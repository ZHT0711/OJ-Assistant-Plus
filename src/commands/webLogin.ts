import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import axios from 'axios';

// puppeteer-core is kept as a webpack external so its .d.ts (too new for our
// TypeScript) is never parsed; require() gives us an untyped handle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const puppeteer = require('puppeteer-core');

/**
 * `OJ-Assist: Login via browser` - the "web login UI".
 *
 * Opens the platform's REAL login page in the user's installed Chrome/Edge
 * (via puppeteer-core `channel`, no bundled browser), lets them sign in
 * natively - captcha images, Cloudflare Turnstile, SMS codes and password
 * managers all work because it is their actual browser flow - then watches
 * for the logged-in state, harvests the matching cookies and writes them to
 * `credentials.cookies` in .ojassistconfig.json. Afterwards the config is
 * reloaded so the adapter picks the session up immediately.
 *
 * The browser runs with a persistent profile under ~/.ojassist/, so on later
 * runs the session is usually still alive and the cookies are re-saved with
 * a single click.
 */

interface PlatformSpec {
    /** Page that shows the login form. */
    loginUrl: string;
    /** Suffix used to filter cookies belonging to this platform. */
    domainSuffix: string;
    /** Cheap cookie-level check (evaluated every polling tick). */
    cookieCheck(cookies: { [k: string]: string }): boolean;
    /**
     * Optional HTTP verification with the harvested cookies - needed where a
     * session cookie is issued before login (NEU OJ, CSECG).
     */
    probe?(cookieHeader: string): Promise<boolean>;
}

const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const platforms: { [backend: string]: PlatformSpec } = {
    luogu: {
        loginUrl: 'https://www.luogu.com.cn/auth/login',
        domainSuffix: 'luogu.com.cn',
        // `_uid` is present but "0" while anonymous.
        cookieCheck: c => !!c['_uid'] && c['_uid'] !== '0',
    },
    leetcode: {
        loginUrl: 'https://leetcode.cn/accounts/login',
        domainSuffix: 'leetcode.cn',
        cookieCheck: c => !!c['LEETCODE_SESSION'],
        probe: async cookie => {
            const response = await axios.post('https://leetcode.cn/graphql/noj-go',
                { query: 'query userStatus { userStatus { isSignedIn username } }' },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': browserUA,
                        'Origin': 'https://leetcode.cn',
                        'Referer': 'https://leetcode.cn/',
                        'Cookie': cookie,
                    },
                    timeout: 20000,
                    validateStatus: () => true,
                });
            return response.data?.data?.userStatus?.isSignedIn === true;
        },
    },
    neuoj: {
        loginUrl: 'https://oj.neu.edu.cn/login',
        domainSuffix: 'oj.neu.edu.cn',
        // Session cookie exists before logging in, so always probe.
        cookieCheck: c => !!c['f_onlinejudge_session'],
        probe: async cookie => {
            const response = await axios.get('https://oj.neu.edu.cn/problems/data?page=1&per_page=1', {
                headers: { 'User-Agent': browserUA, 'Cookie': cookie },
                timeout: 20000,
                maxRedirects: 0,
                validateStatus: () => true,
            });
            return response.status === 200;
        },
    },
    csecg: {
        loginUrl: 'http://neucsecg.neu.edu.cn/',
        domainSuffix: 'neucsecg.neu.edu.cn',
        // JSESSIONID is issued before logging in, so always probe.
        cookieCheck: c => !!c['JSESSIONID'],
        probe: async cookie => {
            const response = await axios.get('http://neucsecg.neu.edu.cn/assignment/', {
                headers: { 'User-Agent': browserUA, 'Accept': 'text/html', 'Cookie': cookie },
                timeout: 20000,
                maxRedirects: 0,
                validateStatus: () => true,
            });
            // Unauthenticated visits answer 302, and established-but-guest
            // sessions answer 200 with an EMPTY body - only a real login
            // serves the (large) SPA shell. Content length is the tell.
            if (response.status < 200 || response.status >= 300) { return false; }
            const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
            return body.length > 500;
        },
    },
};

function profileDir(backend: string): string {
    return path.join(os.homedir(), '.ojassist', 'browser-profile', backend);
}

export default vscode.commands.registerCommand('ojassist.webLogin', async () => {
    const config = await readConfig();
    if (config === undefined) {
        vscode.window.showErrorMessage('OJ-Assistant: .ojassistconfig.json not found - open a workspace that contains one.');
        return;
    }
    const spec = platforms[config.backend];
    if (!spec) {
        vscode.window.showErrorMessage(
            `OJ-Assistant: backend "${config.backend}" does not support browser login ` +
            `(supported: ${Object.keys(platforms).join(', ')}).`);
        return;
    }

    await vscode.window.withProgress({
        cancellable: true,
        location: vscode.ProgressLocation.Notification,
        title: `OJ-Assistant: Web login - ${config.backend}`,
    }, async (progress, token) => {
        progress.report({ message: 'Starting browser...' });

        let browser: any;
        const startedAt = Date.now();
        const timeoutMs = Math.max(10, Number((config as any).webLoginTimeout ?? 300)) * 1000;
        try {
            browser = await launchBrowser();
            const page = await browser.newPage();
            await page.setUserAgent(browserUA);
            await page.goto(spec.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            progress.report({ message: 'Please sign in in the opened browser window...' });

            let cookies: { [k: string]: string } = {};
            let cookieHeader = '';
            while (true) {
                if (token.isCancellationRequested) {
                    return; // finally closes the browser
                }
                if (Date.now() - startedAt > timeoutMs) {
                    throw new Error(`Login not completed within ${timeoutMs / 1000}s.`);
                }
                await delay(1500);

                cookieHeader = await collectCookieHeader(browser, spec.domainSuffix);
                cookies = parseCookieHeader(cookieHeader);
                if (!spec.cookieCheck(cookies)) { continue; }

                // Cookie-level check passed; when the platform needs it,
                // confirm server-side that the session really is authenticated.
                if (spec.probe && !(await safeProbe(spec.probe, cookieHeader))) {
                    continue;
                }
                break;
            }

            await saveCookies(config!, cookieHeader);
            progress.report({ message: 'Cookies saved, reloading adapter...' });
            try {
                await vscode.commands.executeCommand('ojassist.reload');
            } catch (err) {
                // A reload failure is reported by that command itself; cookie
                // saving already succeeded, so only log it here.
                console.error('OJ-Assistant: reload after web login failed', err);
            }
            vscode.window.showInformationMessage(
                `OJ-Assistant: Logged in to ${config!.backend}, cookies saved to .ojassistconfig.json.`);
        } catch (err: any) {
            const message = err?.message ?? String(err);
            if (/could not|channel|executable|browser/i.test(message)) {
                vscode.window.showErrorMessage(
                    'OJ-Assistant: no Chrome/Edge installation was found for browser login. ' +
                    'Install Google Chrome or Microsoft Edge, or paste the cookies manually into ' +
                    'credentials.cookies (F12 -> Network -> Request Headers).');
            } else {
                vscode.window.showErrorMessage(`OJ-Assistant: web login failed: ${message}`);
            }
        } finally {
            if (browser) {
                await browser.close().catch(() => undefined);
            }
        }
    });
});

/** Try Chrome first, then Edge (always present on Windows 10/11). */
async function launchBrowser(): Promise<any> {
    const profile = profileDir(currentBackend() ?? 'default');
    await fs.mkdir(profile, { recursive: true });
    let lastError: any;
    for (const channel of ['chrome', 'msedge']) {
        try {
            return await puppeteer.launch({
                channel,
                headless: false,
                defaultViewport: null,
                userDataDir: profile,
                args: ['--no-first-run', '--no-default-browser-check'],
            });
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError ?? new Error('No supported browser found.');
}

let cachedBackend: string | undefined;
function currentBackend(): string | undefined { return cachedBackend; }

/** Serialize every cookie whose domain matches the platform suffix. */
async function collectCookieHeader(browser: any, domainSuffix: string): Promise<string> {
    const filter = (cookies: any[]) => cookies
        .filter(c => String(c.domain ?? '').includes(domainSuffix))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    // 1) Modern Chrome: browser.cookies() (Puppeteer >= 23) or Storage.getCookies.
    try {
        if (typeof browser.cookies === 'function') {
            return filter(await browser.cookies());
        }
    } catch { /* fall through */ }
    try {
        const client = await browser.target().createCDPSession();
        try {
            const { cookies } = await client.send('Storage.getCookies');
            return filter(cookies);
        } catch {
            // Older Chrome.
            const { cookies } = await client.send('Network.getAllCookies');
            return filter(cookies);
        } finally {
            await client.detach().catch(() => undefined);
        }
    } catch { /* fall through */ }

    // 2) Last resort: cookies visible to the currently open pages.
    const pages = await browser.pages();
    const perPage = await Promise.all(pages.map((p: any) => p.cookies().catch(() => [])));
    const flat: any[] = ([] as any[]).concat(...perPage);
    const seen = new Set<string>();
    return flat
        .filter(c => String(c.domain ?? '').includes(domainSuffix))
        .filter(c => (seen.has(c.name + c.value) ? false : (seen.add(c.name + c.value), true)))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
}

function parseCookieHeader(header: string): { [k: string]: string } {
    const out: { [k: string]: string } = {};
    for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        if (idx > 0) {
            out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
        }
    }
    return out;
}

async function safeProbe(probe: PlatformSpec['probe'], cookieHeader: string): Promise<boolean> {
    try {
        return await probe!(cookieHeader);
    } catch {
        return false;
    }
}

interface OJConfigFile {
    backend: string;
    pathParseRule?: any;
    credentials?: { [k: string]: any };
    [k: string]: any;
}

function configPath(): string | undefined {
    // Prefer the workspace folder of the active editor, but fall back to the
    // first opened folder - otherwise having an unrelated file focused (or a
    // file outside the workspace) makes every command fail with
    // "config not found" even though the workspace does contain one.
    const fromEditor = vscode.window.activeTextEditor
        ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
        : undefined;
    const folder = fromEditor ?? vscode.workspace.workspaceFolders?.[0];
    return folder ? path.join(folder.uri.fsPath, '.ojassistconfig.json') : undefined;
}

async function readConfig(): Promise<OJConfigFile | undefined> {
    const file = configPath();
    if (!file) { return undefined; }
    try {
        const buffer = await fs.readFile(file);
        const config = JSON.parse(buffer.toString());
        cachedBackend = config.backend;
        return config;
    } catch {
        return undefined;
    }
}

async function saveCookies(config: OJConfigFile, cookieHeader: string): Promise<void> {
    const file = configPath();
    if (!file) { throw new Error('Workspace with .ojassistconfig.json is required.'); }
    const raw = await fs.readFile(file, 'utf8');

    // Preserve the file's indentation style (tabs or N spaces).
    const indentMatch = raw.match(/^[ \t]+/m);
    const indent = indentMatch ? indentMatch[0].slice(0, 10) : '  ';

    config.credentials = Object.assign({}, config.credentials, { cookies: cookieHeader });
    await fs.writeFile(file, JSON.stringify(config, null, indent) + '\n', 'utf8');
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
