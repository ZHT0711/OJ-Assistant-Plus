import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { accounts } from '../account/session';
import { safeMessage } from '../account/credentials';
import { adapterFor } from '../backend';
import { randomBytes } from 'crypto';

/**
 * GUI wizard: pick a platform card in a webview and it writes
 * `.ojassistconfig.json` + `.vscode/settings.json` (CodeRunner feeds the
 * sibling .in file as stdin) into the current workspace folder.
 */

interface PlatformCard {
    backend: string;
    name: string;
    desc: string;
    example: string;
    config: object;
}

const CARDS: PlatformCard[] = [
    {
        backend: 'codeforces', name: 'Codeforces', example: '1000A.cpp 或 c/1000/A.cpp',
        desc: '账号密码登录；可保存并复用已有账号',
        config: { backend: 'codeforces', credentials: {}, pathParseRule: {
            contestProblem: 'c[\\\\/](\\d+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: '\\/([0-9]+[A-Za-z][0-9]*)[\\.\\w]*\\.(\\w+)$',
        } },
    },
    {
        backend: 'fjutacm', name: '福建工程学院 ACM', example: '1000.cpp',
        desc: '账号密码登录；可保存并复用已有账号',
        config: { backend: 'fjutacm', credentials: {}, pathParseRule: {
            contestProblem: 'c[\\\\/](\\d+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: '\\/(\\d+)[\\.\\w]*\\.(\\w+)$',
        } },
    },
    {
        backend: 'luogu', name: '洛谷', example: 'P1001.cpp',
        desc: '读题免登录；提交走浏览器登录保存的 Cookie',
        config: {
            backend: 'luogu',
            credentials: {},
            pathParseRule: {
            contestProblem: 'c[\\\\/](\\d+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: '\\/([A-Za-z]\\d+)[\\.\\w]*\\.(\\w+)$',
            },
        },
    },
    {
        backend: 'leetcode', name: '力扣 (leetcode.cn)', example: 'problems/two-sum.cpp',
        desc: '题面/样例自动解析，自动过 WAF；账号密码或浏览器 Cookie 登录',
        config: {
            backend: 'leetcode',
            credentials: {},
            pathParseRule: {
            contestProblem: 'c[\\\\/](\\d+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: '\\/([a-z0-9]+(?:-[a-z0-9]+)+)[\\.\\w]*\\.(\\w+)$',
            },
        },
    },
    {
        backend: 'neuoj', name: '东北大学 OJ', example: 'problems/1001.cpp',
        desc: 'oj.neu.edu.cn；浏览器登录后可搜题/看题/交题',
        config: {
            backend: 'neuoj',
            credentials: {},
            pathParseRule: {
            contestProblem: 'c[\\\\/](\\d+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: 'problems?[\\\\/](\\d+)[\\.\\w]*\\.(\\w+)$',
            },
        },
    },
    {
        backend: 'hdoj',
        name: '杭电 OJ (HDOJ)',
        example: 'problems/1000.cpp',
        desc: 'acm.hdu.edu.cn；登录无验证码，题库按卷浏览 + 关键词搜索',
        config: {
            backend: 'hdoj',
            credentials: {},
            pathParseRule: {
            contestProblem: 'c[\\\\/](\\d+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: '(?:problems?[\\\\/])?(\\d+)[\\.\\w]*\\.(\\w+)$',
            },
        },
    },
    {
        backend: 'csecg', name: 'CSECG 作业平台', example: 'problems/题目.cpp',
        desc: 'neucsecg.neu.edu.cn；通过浏览器登录作业平台',
        config: {
            backend: 'csecg',
            credentials: {},
            pathParseRule: {
            contestProblem: 'a[\\\\/](\\w+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: 'problems?[\\\\/]((?:(?!\\/).)+)[\\.\\w]*\\.(\\w+)$',
            },
            endpoints: {},
        },
    },
    {
        backend: 'hnuacm', name: '湖南大学 ACM OJ', example: 'problems/10000.cpp',
        desc: 'acm.hnu.edu.cn；可从 Edge 登录后保存 Cookie，题库无需验证码',
        config: {
            backend: 'hnuacm', credentials: {},
            pathParseRule: {
            contestProblem: 'c[\\\\/](\\d+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: 'problems?[\\\\/](\\d+)[\\.\\w]*\\.(\\w+)$',
            },
        },
    },
    {
        backend: 'hnucg', name: '湖南大学 CourseGrading', example: 'a/作业ID/题号.cpp',
        desc: 'cg.hnu.edu.cn；Edge 登录后保存 Cookie，图片验证码可在浏览器完成',
        config: {
            backend: 'hnucg', credentials: {}, baseUrl: 'https://cg.hnu.edu.cn',
            pathParseRule: {
            contestProblem: 'a[\\\\/](\\w+)[\\\\/](\\w+)[\\.\\w]*\\.(\\w+)$',
            normalProblem: 'problems?[\\\\/]((?:(?!\\\\/).)+)[\\.\\w]*\\.(\\w+)$',
            },
        },
    },
];

const runnerSettings = {
    'code-runner.runInTerminal': true,
    'code-runner.saveFileBeforeRun': true,
    'code-runner.ignoreSelection': true,
    'code-runner.fileDirectoryAsCwd': true,
    'code-runner.executorMap': {
        c: 'node "$workspaceRoot/.vscode/oj-run.cjs" $fullFileName',
        cpp: 'node "$workspaceRoot/.vscode/oj-run.cjs" $fullFileName',
    },
};

/** Write .ojassistconfig.json + .vscode/settings.json into `folder`. */
export async function writeWorkspaceFiles(folder: vscode.Uri, card: PlatformCard, credentials?: any, original?: string): Promise<void> {
    const configUri = vscode.Uri.joinPath(folder, '.ojassistconfig.json');
    if (credentials) { await accounts.vault.save(configUri.fsPath, card.config, credentials, original); }
    else { await fs.writeFile(configUri.fsPath, JSON.stringify(card.config, null, 2) + '\n', 'utf8'); }

    const vscodeDir = vscode.Uri.joinPath(folder, '.vscode');
    const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
    try {
        await fs.stat(settingsUri.fsPath);
        // Never clobber an existing settings.json - only the fresh template
        // carries the stdin runner, and the user may have their own tweaks.
    } catch {
        await fs.mkdir(vscodeDir.fsPath, { recursive: true });
        await fs.copyFile(path.join(__dirname, '..', 'assets', 'runner.cjs'), vscode.Uri.joinPath(vscodeDir, 'oj-run.cjs').fsPath);
        await fs.writeFile(settingsUri.fsPath, JSON.stringify(runnerSettings, null, 4) + '\n', 'utf8');
    }
}

function panelHtml(folder: vscode.Uri): string {
    const target = folder.fsPath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cards = CARDS.map(c => `
        <div class="card" data-backend="${c.backend}">
            <div class="name">${c.name}</div>
            <div class="desc">${c.desc}</div>
            <div class="ex">代码文件命名：<code>${c.example}</code></div>
            <label>已保存账号<select class="accounts"><option value="">不使用已保存账号</option></select></label>
            <label>账号名称<input class="account-name" maxlength="80" placeholder="可选，用于区分同平台的多个账号"></label>
            <div class="actions"><button data-action="init">仅初始化</button>
            <button data-action="login">${adapterFor(c.backend)?.login ? '登录新账号并保存' : '账号密码登录并保存'}</button></div>
            <div class="actions secondary"><button data-action="rename" disabled>重命名</button><button data-action="remove" disabled>移除保存账号</button></div>
        </div>`).join('');
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-x';">
<style>
    body { font-family: sans-serif; padding: 16px; color: var(--vscode-foreground); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 12px; }
    .card { border: 1px solid var(--vscode-widget-border, #444); border-radius: 8px; padding: 12px; }
    .name { font-size: 16px; font-weight: bold; margin-bottom: 6px; }
    .desc { font-size: 12px; opacity: .8; margin-bottom: 6px; }
    .ex { font-size: 12px; margin-bottom: 10px; }
    label { display: block; font-size: 12px; margin: 10px 0; }
    select, input { display: block; box-sizing: border-box; width: 100%; margin-top: 5px; padding: 7px;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .secondary button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:disabled { opacity: .45; cursor: default; }
    button { cursor: pointer; padding: 6px 12px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent);
             background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .ok { color: var(--vscode-charts-green); margin-top: 12px; }
</style>
</head>
<body>
    <h3>初始化刷题工作区</h3>
    <div>目标文件夹：<b>${target}</b></div>
    <p>选择平台，为此文件夹建立独立刷题区。配置只用于此文件夹及其子目录；父目录的刷题区保持不变。</p>
    <p>登录后自动保存到本机账号库。选择已保存账号即可用于新刷题区；登录过期后可重新登录。</p>
    <button id="refresh">刷新已保存账号</button>
    <div class="grid">${cards}</div>
    <div id="result"></div>
    <script nonce="x">
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('.card').forEach(card => {
            const select = card.querySelector('.accounts');
            select.addEventListener('change', () => {
                card.querySelector('[data-action="init"]').textContent = select.value ? '使用此账号初始化' : '仅初始化';
                card.querySelectorAll('.secondary button').forEach(btn => btn.disabled = !select.value);
            });
            card.querySelectorAll('button[data-action]').forEach(btn => btn.addEventListener('click', () => {
                vscode.postMessage({ command: btn.dataset.action, backend: card.dataset.backend,
                    accountId: select.value, label: card.querySelector('.account-name').value });
            }));
        });
        document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'ready' }));
        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'accounts') {
                document.querySelectorAll('.card').forEach(card => {
                    const select = card.querySelector('.accounts');
                    const selected = select.value;
                    select.replaceChildren(new Option('不使用已保存账号', ''));
                    (msg.accounts[card.dataset.backend] || []).forEach(account => {
                        const suffix = account.endpoint ? ' · ' + account.endpoint : '';
                        select.add(new Option(account.label + (account.username && account.username !== account.label ? ' · ' + account.username : '') + suffix, account.id));
                    });
                    select.value = Array.from(select.options).some(option => option.value === selected) ? selected : '';
                    select.dispatchEvent(new Event('change'));
                });
            } else if (msg.command === 'busy') {
                document.querySelectorAll('button').forEach(btn => btn.disabled = msg.value);
                if (!msg.value) { document.querySelectorAll('.accounts').forEach(select => select.dispatchEvent(new Event('change'))); }
            } else if (msg.command === 'done') {
                document.getElementById('result').textContent = msg.message || '✓ 刷题区已初始化，可点击账号状态登录。';
            } else if (msg.command === 'error') {
                document.getElementById('result').textContent = msg.message;
            }
        });
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
}

export default vscode.commands.registerCommand('ojassist.initWorkspace', async (target?: vscode.Uri) => {
    const folder = target || accounts.current?.root || accounts.folder()?.uri;
    if (!folder) {
        vscode.window.showErrorMessage('OJ-Assistant: 请先打开（或新建）一个文件夹再初始化。');
        return;
    }
    if (folder.scheme !== 'file' || !(await fs.stat(folder.fsPath)).isDirectory()) {
        vscode.window.showErrorMessage('OJ-Assistant: 请右键选择一个本地文件夹。');
        return;
    }
    const panel = vscode.window.createWebviewPanel(
        'ojassist.initWorkspace', '初始化刷题工作区',
        vscode.ViewColumn.One, { enableScripts: true });

    panel.webview.html = panelHtml(folder);
    let initializing = false;
    let disposed = false;
    const sendAccounts = async () => {
        const saved = await accounts.library.list();
        if (disposed) { return; }
        const grouped: { [backend: string]: typeof saved } = {};
        for (const card of CARDS) { grouped[card.backend] = saved.filter(account => account.backend === card.backend); }
        await panel.webview.postMessage({ command: 'accounts', accounts: grouped });
    };
    const accountChanges = accounts.library.onDidChange(() => { void sendAccounts().catch(() => undefined); });
    const listener = panel.webview.onDidReceiveMessage(async (msg: any) => {
        if (msg?.command === 'ready') {
            try { await sendAccounts(); }
            catch (error) { void panel.webview.postMessage({ command: 'error', message: safeMessage(error) }); }
            return;
        }
        if (!['init', 'login', 'rename', 'remove'].includes(msg?.command) || initializing) { return; }
        const card = CARDS.find(c => c.backend === msg.backend);
        if (!card) { return; }
        initializing = true;
        void panel.webview.postMessage({ command: 'busy', value: true });
        try {
            if ((vscode.workspace as any).isTrusted === false && (msg.command !== 'init' || msg.accountId)) {
                throw new Error('请先信任工作区，再使用已保存账号或登录');
            }
            const label = typeof msg.label === 'string' ? msg.label.trim().slice(0, 80) : '';
            const accountId = typeof msg.accountId === 'string' ? msg.accountId : '';
            const selected = accountId ? (await accounts.library.list()).find(account => account.id === accountId && account.backend === card.backend) : undefined;
            if (accountId && !selected) { throw new Error('保存账号不存在或不属于此平台，请重新选择'); }
            if (msg.command === 'rename' || msg.command === 'remove') {
                if (!selected) { throw new Error('请先选择已保存账号'); }
                if (msg.command === 'rename') { await accounts.library.rename(selected.id, label); }
                else {
                    const confirmed = await vscode.window.showWarningMessage(`移除保存账号“${selected.label}”？已配置的刷题区仍可使用原登录信息。`, { modal: true }, '移除');
                    if (!confirmed) { return; }
                    await accounts.library.remove(selected.id);
                }
                await sendAccounts();
                void panel.webview.postMessage({ command: 'done', message: msg.command === 'rename' ? '✓ 账号名称已更新。' : '✓ 已移除保存账号。' });
                return;
            }

            const configUri = vscode.Uri.joinPath(folder, '.ojassistconfig.json');
            let original: string | undefined;
            try {
                original = await fs.readFile(configUri.fsPath, 'utf8');
            } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
            const existing = original === undefined ? undefined : JSON.parse(original);
            const samePlatform = existing && (adapterFor(existing.backend)?.id || existing.backend) === card.backend;
            if (existing && !samePlatform) {
                const choice = await vscode.window.showWarningMessage('当前文件夹已配置其他平台，替换为此平台吗？代码文件会保留。', { modal: true }, '替换平台');
                if (!choice) { return; }
            }
            let config: any = { ...card.config, ...(samePlatform ? existing : {}), backend: card.backend };
            let credentials: any;
            if (msg.command === 'init' && selected) {
                credentials = (await accounts.library.credentials(selected.id, card.backend, selected.endpoint)).credentials;
                config = { ...config, credentials: {}, baseUrl: selected.endpoint || undefined, savedAccountId: selected.id, accountLabel: selected.label };
            }
            if (msg.command === 'login' && !adapterFor(card.backend)?.login) {
                const username = await vscode.window.showInputBox({ prompt: `${card.name} 用户名`, ignoreFocusOut: true });
                if (username === undefined) { return; }
                if (!username.trim()) { throw new Error('请输入用户名'); }
                const password = await vscode.window.showInputBox({ prompt: `${card.name} 密码`, password: true, ignoreFocusOut: true });
                if (password === undefined) { return; }
                if (!password) { throw new Error('请输入密码'); }
                credentials = { username: username.trim(), password };
                config = { ...config, credentials: {}, savedAccountId: randomBytes(16).toString('hex'), accountLabel: label || username.trim() };
            }
            if (original !== undefined) { await fs.copyFile(configUri.fsPath, configUri.fsPath + '.bak-' + Date.now()); }

            await writeWorkspaceFiles(folder, { ...card, config }, credentials, original);
            if (credentials) {
                try {
                    await accounts.library.remember({ backend: card.backend, baseUrl: config.baseUrl, credentials,
                        id: config.savedAccountId, label: config.accountLabel, source: folder.toString(), explicit: true });
                } catch (error) { void vscode.window.showWarningMessage('登录信息已存入刷题区，但账号库更新失败：' + safeMessage(error, credentials)); }
            }
            if (msg.command === 'login' && adapterFor(card.backend)?.login) {
                await vscode.commands.executeCommand('ojassist.webLogin', folder, { newAccount: true, label });
            } else { await vscode.commands.executeCommand('ojassist.reload', folder); }
            await sendAccounts();
            const session = accounts.get(folder);
            const message = session.state === 'ready' ? (session.message || `✓ ${card.name} 账号已连接，登录信息已保存。`)
                : (selected || msg.command === 'login' ? '登录尚未完成或已过期，可再次登录；已保存账号会保留。' : '✓ 刷题区已初始化，可点击“登录新账号并保存”继续。');
            void panel.webview.postMessage({ command: 'done', message });
        } catch (error) {
            const message = '账号或刷题区操作失败：' + safeMessage(error);
            void panel.webview.postMessage({ command: 'error', message });
            vscode.window.showErrorMessage(message);
        } finally {
            initializing = false;
            if (!disposed) { void panel.webview.postMessage({ command: 'busy', value: false }); }
        }
    });
    panel.onDidDispose(() => { disposed = true; accountChanges.dispose(); listener.dispose(); });
});
