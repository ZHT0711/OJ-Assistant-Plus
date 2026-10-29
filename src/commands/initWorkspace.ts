import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

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
        desc: 'neucsecg.neu.edu.cn；接口需登录后在配置 endpoints 中补全',
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
    'code-runner.runInTerminal': false,
    'code-runner.saveFileBeforeRun': true,
    'code-runner.ignoreSelection': true,
    'code-runner.fileDirectoryAsCwd': true,
    'code-runner.executorMap': {
        c: 'chcp 65001 >nul && gcc -O2 -o "$fileNameWithoutExt.exe" "$fileName" && if exist "$fileNameWithoutExt.in" (".\\$fileNameWithoutExt.exe" < "$fileNameWithoutExt.in") else (echo Input file missing: $fileNameWithoutExt.in. Save the source file, then click Edit on the sample input. & exit /b 1)',
        cpp: 'chcp 65001 >nul && g++ -O2 -std=c++17 -o "$fileNameWithoutExt.exe" "$fileName" && if exist "$fileNameWithoutExt.in" (".\\$fileNameWithoutExt.exe" < "$fileNameWithoutExt.in") else (echo Input file missing: $fileNameWithoutExt.in. Save the source file, then click Edit on the sample input. & exit /b 1)',
    },
};

/** Write .ojassistconfig.json + .vscode/settings.json into `folder`. */
export async function writeWorkspaceFiles(folder: vscode.Uri, card: PlatformCard): Promise<void> {
    const configUri = vscode.Uri.joinPath(folder, '.ojassistconfig.json');
    await fs.writeFile(configUri.fsPath, JSON.stringify(card.config, null, 2) + '\n', 'utf8');

    const vscodeDir = vscode.Uri.joinPath(folder, '.vscode');
    const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
    try {
        await fs.stat(settingsUri.fsPath);
        // Never clobber an existing settings.json - only the fresh template
        // carries the stdin runner, and the user may have their own tweaks.
    } catch {
        await fs.mkdir(vscodeDir.fsPath, { recursive: true });
        await fs.writeFile(settingsUri.fsPath, JSON.stringify(runnerSettings, null, 4) + '\n', 'utf8');
    }
}

function panelHtml(): string {
    const cards = CARDS.map(c => `
        <div class="card">
            <div class="name">${c.name}</div>
            <div class="desc">${c.desc}</div>
            <div class="ex">代码文件命名：<code>${c.example}</code></div>
            <button data-backend="${c.backend}">初始化为 ${c.name}</button>
        </div>`).join('');
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-x';">
<style>
    body { font-family: sans-serif; padding: 16px; color: var(--vscode-foreground); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
    .card { border: 1px solid var(--vscode-widget-border, #444); border-radius: 8px; padding: 12px; }
    .name { font-size: 16px; font-weight: bold; margin-bottom: 6px; }
    .desc { font-size: 12px; opacity: .8; margin-bottom: 6px; }
    .ex { font-size: 12px; margin-bottom: 10px; }
    button { cursor: pointer; padding: 6px 12px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent);
             background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .ok { color: var(--vscode-charts-green); margin-top: 12px; }
</style>
</head>
<body>
    <h3>初始化刷题工作区</h3>
    <div>选择平台，将在<b>当前文件夹</b>写入 <code>.ojassistconfig.json</code> 和 <code>.vscode/settings.json</code>（不改动全局设置，不覆盖已有文件）。</div>
    <div class="grid">${cards}</div>
    <div id="result"></div>
    <script nonce="x">
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('button[data-backend]').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ command: 'init', backend: btn.getAttribute('data-backend') });
            });
        });
        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'done') {
                document.getElementById('result').innerHTML =
                    '<div class="ok">✓ 已写入 ' + msg.files.join('、') + '。下一步：Ctrl+Shift+P -> "Login via browser" 完成登录。</div>';
            }
        });
    </script>
</body>
</html>`;
}

export default vscode.commands.registerCommand('ojassist.initWorkspace', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('OJ-Assistant: 请先打开（或新建）一个文件夹再初始化。');
        return;
    }
    const panel = vscode.window.createWebviewPanel(
        'ojassist.initWorkspace', '初始化刷题工作区',
        vscode.ViewColumn.One, { enableScripts: true });

    panel.webview.html = panelHtml();
    panel.webview.onDidReceiveMessage(async (msg: any) => {
        if (msg?.command !== 'init') { return; }
        const card = CARDS.find(c => c.backend === msg.backend);
        if (!card) { return; }

        const configUri = vscode.Uri.joinPath(folder.uri, '.ojassistconfig.json');
        let overwrite = true;
        try {
            await fs.stat(configUri.fsPath);
            const choice = await vscode.window.showWarningMessage(
                '当前文件夹已有 .ojassistconfig.json，覆盖吗？', { modal: true }, '覆盖');
            overwrite = choice === '覆盖';
        } catch { /* no existing config */ }
        if (!overwrite) { return; }

        await writeWorkspaceFiles(folder.uri, card);
        await vscode.commands.executeCommand('ojassist.reload', folder.uri);
        panel.webview.postMessage({ command: 'done', files: ['.ojassistconfig.json', '.vscode/settings.json'] });
        vscode.window.showInformationMessage(
            `OJ-Assistant: 已按 ${card.name} 初始化。按 Ctrl+Shift+P -> "Login via browser" 登录后即可使用。`);
    });
});
