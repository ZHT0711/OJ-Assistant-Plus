import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { accounts } from '../account/session';
import { safeMessage } from '../account/credentials';
import { adapterFor, platformAdapters } from '../backend';
import type { LoginSpec } from '../backend';
import { browserUA } from '../backend/platforms';

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

export default vscode.commands.registerCommand('ojassist.webLogin', async (target?: vscode.Uri | string) => {
    const root = typeof target === 'string' ? vscode.Uri.parse(target) : target || accounts.current?.root || accounts.folder()?.uri;
    if (!root || (vscode.workspace as any).isTrusted === false) { vscode.window.showWarningMessage('请打开并信任账号工作区，再进行浏览器登录'); return; }
    const file = path.join(root.fsPath, '.ojassistconfig.json');
    let config: any;
    try { config = await accounts.vault.read(file); }
    catch (error) {
        vscode.window.showErrorMessage('OJ-Assistant: 无法读取账号配置：' + safeMessage(error));
        return;
    }
    const session = accounts.get(root);
    const adapter = adapterFor(config.backend);
    const spec = adapter?.login;
    if (!spec) {
        const supported = platformAdapters.filter(platform => platform.login).map(platform => platform.id).join(', ');
        vscode.window.showErrorMessage(
            `OJ-Assistant: backend "${config.backend}" does not support browser login ` +
            `(supported: ${supported}).`);
        return;
    }
    accounts.select(root);
    accounts.change(session, 'loading', '正在等待浏览器登录…');

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
            browser = await launchBrowser(accounts.profile(root, config.backend));
            const page = await browser.newPage();
            await page.setUserAgent(browserUA);
            await page.goto(spec.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            progress.report({ message: 'Please sign in in the opened browser window...' });

            let cookies: { [k: string]: string } = {};
            let cookieHeader = '';
            while (true) {
                if (token.isCancellationRequested) {
                    accounts.change(session, 'expired', '浏览器登录已取消，可以重试');
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

            const raw = await fs.readFile(file, 'utf8');
            const latest = await accounts.vault.read(file, false);
            if (latest.backend !== config.backend || latest.credentialRef !== config.credentialRef || latest.baseUrl !== config.baseUrl) { throw new Error('登录期间账号配置已变化，请重试'); }
            await accounts.vault.save(file, latest, { ...latest.credentials, cookies: cookieHeader }, raw);
            progress.report({ message: 'Cookies saved, reloading adapter...' });
            try {
                await vscode.commands.executeCommand('ojassist.reload', root);
            } catch (err) {
                // A reload failure is reported by that command itself; cookie
                // saving already succeeded, so only log it here.
                console.error('OJ-Assistant: reload after web login failed', err);
            }
            vscode.window.showInformationMessage(
                `OJ-Assistant: ${config.backend} 凭据已保存至 VS Code 凭据存储，${session.state === 'ready' ? '账号已就绪' : '请检查账号状态'}。`);
        } catch (err: any) {
            const message = safeMessage(err, config.credentials);
            accounts.change(session, 'error', message);
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
async function launchBrowser(profile: string): Promise<any> {
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

/** Serialize every cookie whose domain matches the platform suffix. */
async function collectCookieHeader(browser: any, domainSuffix: string): Promise<string> {
    const filter = (cookies: any[]) => cookies
        .filter(c => { const domain = String(c.domain || '').replace(/^\./, ''); const suffix = domainSuffix.replace(/^\./, ''); return domain === suffix || domain.endsWith('.' + suffix); })
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

async function safeProbe(probe: LoginSpec['probe'], cookieHeader: string): Promise<boolean> {
    try {
        return await probe!(cookieHeader);
    } catch {
        return false;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
