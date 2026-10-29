import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { accounts, isAuthenticationError } from './session';
import { parseSourceFile } from '../utils/sourceUtils';
import { languageForSource } from '../practice/languages';
import { CaseResult, runSamples } from '../practice/runner';
import { runOptions } from '../practice/settings';
import { escapeHtml as e, Sample } from '../practice/problem';
import { problemSamples, validSamples } from './sampleData';
import { bounded } from './submissions';
import { safeMessage, writeJson } from './credentials';

interface TestData { tests: Sample[]; driver?: string; }
export function registerAccountTesting(context: vscode.ExtensionContext): void {
    let panel: vscode.WebviewPanel | undefined;
    let binding: { source: vscode.Uri; file: string; data: TestData; title: string; generation: number; sessionKey: string } | undefined;
    let generation = 0, running = false;
    let saving = Promise.resolve();
    const output = vscode.window.createOutputChannel('OJ Assistant · 账号样例');
    const resolveSource = (arg?: vscode.Uri | string) => {
        const source = typeof arg === 'string' ? vscode.Uri.parse(arg) : arg || vscode.window.activeTextEditor?.document.uri;
        if (!source) { throw new Error('请先打开账号题目的代码文件'); }
        return source;
    };
    const load = async (source: vscode.Uri) => {
        const session = accounts.assertReady(source);
        const sessionKey = session.key;
        const sessionGeneration = session.generation;
        const doc = await vscode.workspace.openTextDocument(source);
        const info = parseSourceFile(source, session.config, doc.getText());
        if (!info) { throw new Error('当前文件不属于账号题库中的题目'); }
        const key = createHash('sha256').update(JSON.stringify([session.key, info.contestId, info.id])).digest('hex').slice(0, 24);
        const dir = path.join(session.root.fsPath, '.oj-assistant', 'accounts', 'tests');
        const file = path.join(dir, key + '.json');
        let data: TestData | undefined;
        try { data = JSON.parse(await fs.readFile(file, 'utf8')); if (!validSamples(data?.tests)) { throw new Error('测试用例格式无效'); } }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
        if (!data) {
            const server = session.server;
            try {
                const problem = await bounded(server.getProblem(info), 20000);
                data = { tests: problemSamples(session.config.backend, problem.content) };
            } catch (error) { if (isAuthenticationError(error)) { accounts.change(session, 'expired', '登录已过期，请重新登录'); } throw error; }
            await fs.mkdir(dir, { recursive: true }); await writeJson(file, data);
        }
        if (session.generation !== sessionGeneration || session.key !== sessionKey || session.state !== 'ready') { throw new Error('账号已变化，请重新打开题目的测试面板'); }
        return { source, file, data, title: `${session.config.backend} · ${info.contestId ? info.contestId + ' / ' : ''}${info.id}`, sessionKey };
    };
    const run = async (source: vscode.Uri): Promise<CaseResult[] | undefined> => {
        if (running) { vscode.window.showInformationMessage('账号样例测试正在运行'); return; }
        if ((vscode.workspace as any).isTrusted === false) { throw new Error('请先信任工作区，再运行本地代码'); }
        running = true;
        try {
            await saving;
            const session = accounts.assertReady(source);
            const entry = await load(source);
            let executableSource = source;
            if (session.config.backend === 'leetcode') {
                if (!entry.data.driver) { throw new Error('力扣函数题需要调用 Solution 的测试驱动，请打开“账号样例与自定义测试”并选择测试驱动文件'); }
                const file = path.resolve(session.root.fsPath, entry.data.driver);
                const relative = path.relative(session.root.fsPath, file);
                if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('测试驱动必须位于当前工作区'); }
                executableSource = vscode.Uri.file(file);
            }
            if (!languageForSource(executableSource.fsPath)) { throw new Error('本地运行支持 C/C++、Python、JavaScript、Java、Go、Rust'); }
            if (!entry.data.tests.length) { throw new Error('该题未解析到样例，请先添加输入和预期输出'); }
            const doc = await vscode.workspace.openTextDocument(source); if (!await doc.save()) { throw new Error('保存代码失败'); }
            const driver = await vscode.workspace.openTextDocument(executableSource); if (!await driver.save()) { throw new Error('保存测试驱动失败'); }
            output.clear(); output.show(true); output.appendLine(entry.title + '\n' + executableSource.fsPath);
            return await vscode.window.withProgress({ title: '账号题库 · 运行全部样例', location: vscode.ProgressLocation.Notification }, async () => {
                const results = await runSamples(executableSource.fsPath, entry.data.tests, runOptions(executableSource));
                results.forEach((result, i) => {
                    output.appendLine(`\n#${i + 1} ${result.timedOut ? 'TLE' : result.overflow ? '输出超限' : result.code !== 0 ? 'RE' : result.passed ? '通过' : 'WA'} · ${result.elapsed} ms\n预期:\n${entry.data.tests[i].output}\n实际:\n${result.stdout}`);
                    if (result.stderr) { output.appendLine('标准错误:\n' + result.stderr); }
                });
                const passed = results.filter(r => r.passed).length;
                output.appendLine(`\n${passed}/${results.length} 通过（忽略空白差异；本地结果不代表线上 AC）`);
                vscode.window.showInformationMessage(`账号样例：${passed}/${results.length} 通过`);
                return results;
            });
        } catch (error) { output.appendLine(safeMessage(error)); throw error; }
        finally { running = false; }
    };
    const paint = () => {
        if (!panel || !binding) { return; }
        const { data, generation: epoch, title } = binding;
        const nonce = randomBytes(16).toString('hex');
        panel.title = title + ' · 样例测试';
        panel.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
        body{font-family:var(--vscode-font-family);padding:16px}textarea{display:block;width:100%;box-sizing:border-box;min-height:90px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-family:var(--vscode-editor-font-family);padding:8px}button{margin:4px;padding:7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer}.muted{opacity:.7}section{margin-bottom:20px}
        </style></head><body><h2>${e(title)}</h2><p class="muted">${e(binding.source.fsPath)}</p><button data-command="run">运行全部测试</button><button data-command="add">添加测试</button><button data-command="save">保存测试</button><button data-command="driver">选择测试驱动（函数题）</button><p class="muted">${data.driver ? '测试驱动：' + e(data.driver) : '标准输入题直接运行源文件；力扣函数题需要先选择测试驱动。'}</p>
        ${data.tests.map((test, i) => `<section><h3>测试 ${i + 1}</h3><label>输入<textarea class="input">${e(test.input)}</textarea></label><label>预期输出<textarea class="output">${e(test.output)}</textarea></label></section>`).join('')}
        <script nonce="${nonce}">const vscode=acquireVsCodeApi();function send(command){const tests=Array.from(document.querySelectorAll('section')).map(s=>({input:s.querySelector('.input').value,output:s.querySelector('.output').value}));vscode.postMessage({command,tests,epoch:${epoch}});}document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>send(b.dataset.command)));document.querySelectorAll('textarea').forEach(t=>t.addEventListener('input',()=>send('autosave')));</script></body></html>`;
    };
    const register = (command: string, callback: (...args: any[]) => Promise<any>) => context.subscriptions.push(vscode.commands.registerCommand(command, async (...args: any[]) => {
        try { return await callback(...args); } catch (error) { vscode.window.showWarningMessage(safeMessage(error, accounts.current?.config?.credentials)); }
    }));
    register('ojassist.runAccountSamples', arg => run(resolveSource(arg)));
    register('ojassist.accountTests', async arg => {
        const epoch = ++generation;
        const entry = await load(resolveSource(arg));
        if (epoch !== generation) { return; }
        binding = { ...entry, generation: epoch };
        if (!panel) {
            panel = vscode.window.createWebviewPanel('ojassist.accountTests', '账号样例与自定义测试', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
            panel.onDidDispose(() => { panel = undefined; binding = undefined; generation++; }, undefined, context.subscriptions);
            panel.webview.onDidReceiveMessage(message => {
                const entry = binding;
                if (!entry || message.epoch !== entry.generation || !validSamples(message.tests)) { return; }
                saving = saving.then(async () => {
                    if (binding !== entry) { return; }
                    if (accounts.forUri(entry.source)?.key !== entry.sessionKey) { throw new Error('当前账号已变化，请重新打开题目的测试面板'); }
                    entry.data.tests = message.tests;
                    if (message.command === 'add') { if (entry.data.tests.length >= 100) { throw new Error('最多保存 100 个测试'); } entry.data.tests.push({ input: '', output: '' }); }
                    if (message.command === 'driver') {
                        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '选择包含入口及调用逻辑的测试驱动' });
                        const root = accounts.forUri(entry.source)!.root;
                        if (picked?.[0]) {
                            const relative = path.relative(root.fsPath, picked[0].fsPath);
                            if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('测试驱动必须位于当前工作区'); }
                            entry.data.driver = relative;
                        }
                    }
                    await writeJson(entry.file, entry.data);
                    if (message.command === 'add' || message.command === 'driver') { paint(); }
                    if (message.command === 'run') { void vscode.commands.executeCommand('ojassist.runAccountSamples', entry.source); }
                    if (message.command === 'save') { vscode.window.showInformationMessage('账号题目测试已保存'); }
                }).catch(error => { vscode.window.showWarningMessage(safeMessage(error)); });
            }, undefined, context.subscriptions);
        }
        paint(); panel.reveal(vscode.ViewColumn.Beside, true);
    });
    context.subscriptions.push(output, { dispose: () => panel?.dispose() });
}
