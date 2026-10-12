import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const puppeteer = require('puppeteer-core');

/**
 * `OJ-Assistant: 获取腾讯翻译Token`
 *
 * fanyi.qq.com needs a TencentCaptcha pass to mint a translate Token
 * (POST /api/v1/token/create {Ticket, Randstr}). A real browser is the only
 * sane way to solve it, so: open fanyi.qq.com in the shared browser profile,
 * let the user pass the captcha, then harvest localStorage.tokenInfo.
 */
export default vscode.commands.registerCommand('ojassist.qqTranslateToken', async () => {
    await vscode.window.withProgress({
        cancellable: true,
        location: vscode.ProgressLocation.Notification,
        title: 'OJ-Assistant: 获取腾讯翻译 Token',
    }, async (progress, token) => {
        progress.report({ message: '正在打开 fanyi.qq.com，请完成腾讯验证码...' });
        let browser: any;
        try {
            const profile = path.join(os.homedir(), '.ojassist', 'browser-profile', 'fanyi');
            await fs.mkdir(profile, { recursive: true });
            browser = await (puppeteer.launch as any)({
                channel: 'chrome',
                headless: false,
                defaultViewport: null,
                userDataDir: profile,
                args: ['--no-first-run', '--no-default-browser-check'],
            });
            const page = await browser.newPage();
            await page.goto('https://fanyi.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

            const started = Date.now();
            while (Date.now() - started < 240000) {
                if (token.isCancellationRequested) { return; }
                const info = await page.evaluate(() => localStorage.getItem('tokenInfo')).catch(() => null);
                if (info) {
                    const parsed = JSON.parse(String(info));
                    if (parsed.Token) {
                        await saveTencentToken(parsed.Token, parsed.Expiration);
                        vscode.window.showInformationMessage(
                            'OJ-Assistant: 腾讯翻译 Token 已保存' +
                            (parsed.Expiration ? `（有效期至 ${new Date(Number(parsed.Expiration) * 1000).toLocaleString()}）` : '') +
                            '，刷新面板后翻译即走腾讯通道。');
                        return;
                    }
                }
                await new Promise(r => setTimeout(r, 1500));
            }
            throw new Error('等待 Token 超时（未检测到 tokenInfo）');
        } catch (err: any) {
            vscode.window.showErrorMessage('OJ-Assistant: 获取腾讯Token失败: ' + (err?.message ?? err));
        } finally {
            if (browser) { await browser.close().catch(() => undefined); }
        }
    });
});

async function saveTencentToken(token: string, expiration?: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { throw new Error('未打开工作区，无法保存配置'); }
    const file = path.join(folder.uri.fsPath, '.ojassistconfig.json');
    const raw = await fs.readFile(file, 'utf8');
    const indentMatch = raw.match(/^[ \t]+/m);
    const indent = indentMatch ? indentMatch[0].slice(0, 10) : '  ';
    const cfg = JSON.parse(raw);
    cfg.translation = Object.assign({}, cfg.translation, {
        tencentWebToken: token,
        tencentWebTokenExp: expiration,
    });
    await fs.writeFile(file, JSON.stringify(cfg, null, indent) + '\n', 'utf8');
}
