import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { collectionTargets, fetchProblem } from './importer';
import { escapeHtml as e, identify, normalizeUrl, parseManual, PracticeProblem, problemKey, sanitizeHtml } from './problem';
import { renderLatex } from '../utils/markdown';
import { isPracticeSource, listProblems, problemDir, readPractice, removeProblem, saveProblem } from './store';
import { CaseResult, checkTools, runSamples } from './runner';
import { runOptions } from './settings';
import { languageById, languageForSource, languages, PracticeLanguageId, tools } from './languages';
import { ensureSolution, readProblemLanguage, saveProblemLanguage } from './solutions';

export function practiceForUri(uri: vscode.Uri): PracticeProblem | undefined {
    const root = vscode.workspace.getWorkspaceFolder(uri);
    return root ? readPractice(root.uri.fsPath, uri.fsPath) : undefined;
}
export function isPracticeUri(uri: vscode.Uri): boolean {
    const root = vscode.workspace.getWorkspaceFolder(uri);
    return !!root && isPracticeSource(root.uri.fsPath, uri.fsPath);
}
export async function submitPractice(uri: vscode.Uri): Promise<void> {
    const p = practiceForUri(uri);
    if (!p) { throw new Error('题目缓存不存在，请重新导入链接'); }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.env.clipboard.writeText(doc.getText());
    normalizeUrl(p.submitUrl);
    await vscode.env.openExternal(vscode.Uri.parse(p.submitUrl));
    vscode.window.showInformationMessage('代码已复制；请在打开的题目提交页粘贴，并选择对应语言。');
}

type Item = { group: string } | { problem: PracticeProblem; root: string } | { action: string; label: string };
class PracticeTree implements vscode.TreeDataProvider<Item> {
    private changed = new vscode.EventEmitter<Item | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private entries: Array<{ problem: PracticeProblem; root: string }> = [];
    private filter = '';
    private refreshSeq = 0;
    async refresh(): Promise<void> {
        const seq = ++this.refreshSeq;
        const entries: Array<{ problem: PracticeProblem; root: string }> = [];
        for (const folder of vscode.workspace.workspaceFolders || []) {
            entries.push(...(await listProblems(folder.uri.fsPath)).map(problem => ({ problem, root: folder.uri.fsPath })));
        }
        if (seq !== this.refreshSeq) { return; }
        this.entries = entries;
        this.changed.fire(undefined);
    }
    search(filter: string): void { this.filter = filter.toLowerCase(); this.changed.fire(undefined); }
    getChildren(item?: Item): Item[] {
        const entries = this.entries.filter(x => (x.problem.title + x.problem.platform + x.problem.url).toLowerCase().includes(this.filter));
        if (item && 'group' in item) { return entries.filter(x => x.problem.group === item.group); }
        if (item) { return []; }
        return [
            { action: 'ojassist.pickPracticeLanguage', label: '默认语言：' + defaultLanguage().label + '（点击切换）' },
            { action: 'ojassist.importLink', label: '粘贴题目 / 比赛链接' },
            { action: 'ojassist.importPracticeJson', label: '手动导入 / Competitive Companion JSON' },
            ...Array.from(new Set(entries.map(x => x.problem.group))).map(group => ({ group })),
        ];
    }
    getTreeItem(item: Item): vscode.TreeItem {
        if ('group' in item) {
            const row = new vscode.TreeItem(item.group, vscode.TreeItemCollapsibleState.Expanded);
            row.iconPath = new vscode.ThemeIcon('folder'); return row;
        }
        if ('action' in item) {
            const row = new vscode.TreeItem(item.label);
            row.command = { command: item.action, title: item.label };
            row.iconPath = new vscode.ThemeIcon(item.action === 'ojassist.pickPracticeLanguage' ? 'symbol-enum' : 'add'); return row;
        }
        const row = new vscode.TreeItem(item.problem.title);
        row.id = item.root + ':' + item.problem.key;
        row.description = item.problem.samples.length + ' 个测试';
        row.tooltip = item.problem.url;
        row.contextValue = 'practiceProblem';
        row.iconPath = new vscode.ThemeIcon('file-code');
        row.command = { command: 'ojassist.openPractice', title: '打开链接题目' };
        return row;
    }
    dispose(): void { this.changed.dispose(); }
}

function defaultLanguage(root?: string) {
    const active = vscode.window.activeTextEditor?.document.uri;
    const scope = root ? vscode.Uri.file(root) : active || vscode.workspace.workspaceFolders?.[0]?.uri;
    return languageById(vscode.workspace.getConfiguration('ojassist.practice', scope).get('language', 'cpp')) || languages[0];
}

interface StatementBinding { source: vscode.Uri; root: string; key: string; language: PracticeLanguageId; epoch: number; }

export function registerPractice(context: vscode.ExtensionContext): void {
    const tree = new PracticeTree();
    const view = vscode.window.createTreeView('ojassistant.practice', { treeDataProvider: tree });
    const output = vscode.window.createOutputChannel('OJ Assistant · 样例测试');
    let panel: vscode.WebviewPanel | undefined;
    let binding: StatementBinding | undefined;
    const bindings = new Map<number, StatementBinding>();
    let openSeq = 0;
    let showingSource: string | undefined;
    let committing = Promise.resolve();
    let messages = Promise.resolve();
    let importing = false;
    const running = new Set<string>();
    const rootForImport = async (): Promise<string | undefined> => {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) { vscode.window.showWarningMessage('请先打开一个刷题文件夹；链接模式无需初始化账号配置。'); return; }
        if (folders.length === 1) { return folders[0].uri.fsPath; }
        return (await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择保存链接题目的文件夹' }))?.uri.fsPath;
    };
    const guard = (fn: (...args: any[]) => Promise<any>) => async (...args: any[]) => {
        try { return await fn(...args); } catch (err) { vscode.window.showErrorMessage('OJ Assistant: ' + (err.message || err)); }
    };
    const register = (name: string, fn: (...args: any[]) => Promise<any>) => context.subscriptions.push(vscode.commands.registerCommand(name, guard(fn)));
    const selected = (item?: Item): { problem: PracticeProblem; root: string } | undefined => {
        const current = item || view.selection[0];
        return current && 'problem' in current ? current : undefined;
    };
    async function open(item: { problem: PracticeProblem; root: string }, chosenLanguage?: PracticeLanguageId): Promise<void> {
        const epoch = ++openSeq;
        const { root } = item;
        const language = chosenLanguage || await readProblemLanguage(root, item.problem.key) || defaultLanguage(root).id;
        if (epoch !== openSeq) { return; }
        const source = vscode.Uri.file(await ensureSolution(root, item.problem.key, language));
        if (epoch !== openSeq) { return; }
        const doc = await vscode.workspace.openTextDocument(source);
        // Serialize UI commits and discard stale requests before every asynchronous transition.
        committing = committing.catch(() => undefined).then(async () => {
            if (epoch !== openSeq) { return; }
            await saveProblemLanguage(root, item.problem.key, language);
            if (epoch !== openSeq) { return; }
            showingSource = source.fsPath;
            try { await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false }); }
            finally { showingSource = undefined; }
            if (epoch !== openSeq) { return; }
            const p = readPractice(root, source.fsPath);
            if (!p) { throw new Error('题目缓存不存在，请重新导入'); }
            binding = { root, source, key: p.key, language, epoch };
            bindings.set(epoch, binding);
            if (bindings.size > 32) { bindings.delete(bindings.keys().next().value); }
            if (!panel) {
                panel = vscode.window.createWebviewPanel('ojassist.practiceStatement', p.title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
                    enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets', 'katex')],
                });
                panel.onDidDispose(() => { panel = undefined; binding = undefined; bindings.clear(); openSeq++; }, undefined, context.subscriptions);
                panel.webview.onDidReceiveMessage(msg => {
                    const captured = bindings.get(msg.epoch);
                    if (!captured) { return; }
                    messages = messages.then(() => handleMessage(msg, captured)).catch(err => { vscode.window.showErrorMessage('OJ Assistant: ' + err.message); });
                }, undefined, context.subscriptions);
            }
            panel.title = p.title + ' · ' + languageById(language)!.label;
            panel.webview.html = statementHtml(p, panel, context, binding);
            panel.reveal(vscode.ViewColumn.Beside, true);
        });
        await committing;
    }
    async function handleMessage(msg: any, captured: StatementBinding): Promise<void> {
        const { source, root } = captured;
        // An old page may finish saving its edits, but must never run/submit/switch the new page.
        if (captured !== binding && msg.command !== 'autosave') { return; }
        const p = readPractice(root, source.fsPath);
        if (!p) { return; }
        if (msg.command === 'submit') { await submitPractice(source); return; }
        if (msg.command === 'browser') { await vscode.env.openExternal(vscode.Uri.parse(normalizeUrl(p.url).toString())); return; }
        if (msg.command === 'check') { await checkEnvironment(source, captured.language); return; }
        if (!['save', 'autosave', 'run', 'add', 'language'].includes(msg.command)) { return; }
        if (!Array.isArray(msg.samples) || msg.samples.length > 100 || msg.samples.some((s: any) => typeof s.input !== 'string' || typeof s.output !== 'string' || s.input.length + s.output.length > 2 * 1024 * 1024)) { throw new Error('测试数据格式无效或过大'); }
        p.samples = msg.samples;
        if (msg.command === 'add') {
            if (p.samples.length >= 100) { throw new Error('每题最多保存 100 个测试用例'); }
            p.samples.push({ input: '', output: '' });
        }
        await saveProblem(root, p, true);
        if (msg.command === 'autosave') { return; }
        await tree.refresh();
        if (captured !== binding) { return; }
        if (msg.command === 'language') { await chooseLanguage(root, p, msg.language); }
        else if (msg.command === 'add' && panel) { panel.webview.html = statementHtml(p, panel, context, captured); }
        else if (msg.command === 'run') { void guard(() => run(source, p))(); }
        else { vscode.window.showInformationMessage('测试用例已保存'); }
    }
    async function chooseLanguage(root: string, problem?: PracticeProblem, supplied?: unknown): Promise<PracticeLanguageId | undefined> {
        let language = languageById(supplied);
        if (supplied !== undefined && !language) { throw new Error('不支持的刷题语言'); }
        if (!language) {
            const current = (problem && await readProblemLanguage(root, problem.key)) || defaultLanguage(root).id;
            const picked = await vscode.window.showQuickPick(languages.map(l => ({
                label: (l.id === current ? '$(check) ' : '') + l.label, id: l.id,
                description: l.tools.map(t => tools[t].command).join(' + '),
                detail: `main.${l.id} · ${problem ? '切换当前题目，并作为新题默认语言' : '作为当前文件夹中新题的默认语言'}`,
            })), { placeHolder: '选择链接刷题语言（保留各语言已有代码）', ignoreFocusOut: true });
            if (!picked) { return; }
            language = languageById(picked.id)!;
        }
        await vscode.workspace.getConfiguration('ojassist.practice', vscode.Uri.file(root)).update('language', language.id, vscode.ConfigurationTarget.WorkspaceFolder);
        await tree.refresh();
        if (problem) { await open({ root, problem }, language.id); }
        return language.id;
    }
    async function checkEnvironment(source: vscode.Uri, language: PracticeLanguageId) {
        if ((vscode.workspace as any).isTrusted === false) { throw new Error('请先信任此工作区，再检测编译 / 运行工具'); }
        const checks = await checkTools(language, runOptions(source));
        output.clear(); output.show(true);
        output.appendLine(languageById(language)!.label + ' · 编译 / 运行环境');
        for (const check of checks) { output.appendLine(`${check.available ? '✓' : '✗'} ${check.command}\n${check.detail}\n`); }
        if (checks.every(c => c.available)) { vscode.window.showInformationMessage('当前语言的编译 / 运行环境可用'); }
        else { vscode.window.showWarningMessage('部分语言工具不可用，请查看输出面板中的安装或路径提示'); }
        return checks;
    }
    async function run(source: vscode.Uri, p: PracticeProblem): Promise<CaseResult[] | undefined> {
        if ((vscode.workspace as any).isTrusted === false) { throw new Error('请先信任此工作区，再运行本地代码'); }
        if (running.size) { vscode.window.showInformationMessage('已有样例测试正在运行，完成后可运行下一题；期间可以自由切题。'); return; }
        if (!p.samples.length) { throw new Error('该题没有测试用例，请在题面中添加输入和预期输出'); }
        running.add(source.fsPath);
        try {
            const doc = await vscode.workspace.openTextDocument(source);
            if (!await doc.save()) { throw new Error('无法保存源代码'); }
            output.clear(); output.show(true); output.appendLine(p.title + ' · ' + languageForSource(source.fsPath)!.label + '\n文件：' + source.fsPath + '\n正在编译 / 运行…');
            return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OJ Assistant · 运行样例' }, async () => {
                const results = await runSamples(source.fsPath, p.samples, runOptions(source));
                results.forEach((r, i) => {
                    const status = r.timedOut ? 'TLE' : r.overflow ? '输出超限' : r.code !== 0 ? `RE (${r.code})` : r.passed ? '通过' : 'WA';
                    output.appendLine(`\n#${i + 1} ${status} · ${r.elapsed} ms\n输入:\n${p.samples[i].input}\n预期:\n${p.samples[i].output}\n实际:\n${r.stdout}`);
                    if (r.stderr) { output.appendLine('标准错误:\n' + r.stderr); }
                });
                const passed = results.filter(r => r.passed).length;
                output.appendLine(`\n${passed}/${results.length} 通过（忽略空白差异；本地样例结果不代表线上 AC）`);
                vscode.window.showInformationMessage(`样例测试：${passed}/${results.length} 通过`);
                return results;
            });
        } catch (err) { output.appendLine(err.message); throw err; }
        finally { running.delete(source.fsPath); }
    }
    register('ojassist.importLink', async () => {
        if (importing) { vscode.window.showInformationMessage('正在导入，请稍候'); return; }
        const root = await rootForImport(); if (!root) { return; }
        const raw = await vscode.window.showInputBox({ prompt: '粘贴单题或比赛链接（Codeforces / 洛谷 / AtCoder；其他站点尝试通用解析）', ignoreFocusOut: true });
        if (!raw) { return; }
        const target = identify(raw);
        importing = true;
        let first: PracticeProblem | undefined;
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '导入链接题目', cancellable: true }, async (progress, token) => {
                const targets = await collectionTargets(target);
                const cached = new Map((await listProblems(root)).map(p => [p.key, p]));
                const failed: string[] = [];
                let added = 0, existing = 0;
                for (let i = 0; i < targets.length && !token.isCancellationRequested; i++) {
                    progress.report({ message: `${i + 1}/${targets.length} ${targets[i].id}`, increment: 100 / targets.length });
                    try {
                        const previous = cached.get(problemKey(targets[i].url));
                        if (previous) { existing++; if (!first) { first = previous; } continue; }
                        const p = await fetchProblem(targets[i]);
                        if (target.collection) { p.group = target.platform + ' · ' + (target.contest || target.id); }
                        if (await saveProblem(root, p)) { added++; } else { existing++; }
                        if (!first) { first = p; }
                    } catch (err) { failed.push(targets[i].url + ': ' + err.message); }
                }
                await tree.refresh();
                if (failed.length) {
                    output.clear(); output.appendLine(failed.join('\n')); output.show(true);
                    const choice = await vscode.window.showWarningMessage(`已新增 ${added} 题，已有 ${existing} 题，失败 ${failed.length} 题。可手动导入补充。`, '手动导入', '打开网页');
                    if (choice === '手动导入') { await vscode.commands.executeCommand('ojassist.importPracticeJson'); }
                    if (choice === '打开网页') { await vscode.env.openExternal(vscode.Uri.parse(target.url)); }
                } else { vscode.window.showInformationMessage(`已新增 ${added} 题，已有 ${existing} 题${token.isCancellationRequested ? '（已取消后续导入）' : ''}`); }
            });
        } finally { importing = false; }
        if (first && !target.collection) { await open({ root, problem: first }); }
    });
    register('ojassist.importPracticeJson', async () => {
        const root = await rootForImport(); if (!root) { return; }
        const choice = await vscode.window.showQuickPick(['选择 JSON 文件', '新建手动导入模板'], { placeHolder: '支持 Competitive Companion 格式，可包含单题或题目数组' });
        if (choice === '新建手动导入模板') {
            const template = { name: '题目名称', group: '我的练习', url: 'https://example.com/problem/1000', statement: '在这里粘贴 Markdown 题面', tests: [{ input: '1 2\n', output: '3\n' }] };
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(template, null, 2) }));
            vscode.window.showInformationMessage('填写并保存 JSON，然后再次运行“手动导入”选择该文件。'); return;
        }
        if (!choice) { return; }
        const files = await vscode.window.showOpenDialog({ filters: { json: ['json'] }, canSelectMany: false });
        if (!files?.length) { return; }
        const value = JSON.parse(await fs.readFile(files[0].fsPath, 'utf8'));
        const problems = (Array.isArray(value) ? value : [value]).map(parseManual);
        let added = 0;
        for (const p of problems) { if (await saveProblem(root, p)) { added++; } }
        await tree.refresh(); vscode.window.showInformationMessage(`已新增 ${added} 题，已有 ${problems.length - added} 题`);
        if (problems.length === 1) { await open({ problem: problems[0], root }); }
    });
    register('ojassist.openPractice', async item => { const entry = selected(item); if (entry) { await messages; await open(entry); } });
    register('ojassist.pickPracticeLanguage', async (id?: unknown, item?: Item) => {
        const entry = selected(typeof id === 'object' ? id as Item : item);
        const active = vscode.window.activeTextEditor?.document.uri;
        const problem = entry?.problem || (active && practiceForUri(active));
        const root = entry?.root || (problem && active && vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath) || await rootForImport();
        if (!root) { return; }
        await messages;
        return chooseLanguage(root, problem, typeof id === 'string' ? id : undefined);
    });
    register('ojassist.checkPracticeTools', async (id?: unknown) => {
        const entry = id && typeof id === 'object' ? selected(id as Item) : undefined;
        if (entry) {
            const language = await readProblemLanguage(entry.root, entry.problem.key) || defaultLanguage(entry.root).id;
            return checkEnvironment(vscode.Uri.file(entry.root), language);
        }
        const active = vscode.window.activeTextEditor?.document.uri;
        const root = active && vscode.workspace.getWorkspaceFolder(active);
        const language = languageById(id) || (active && languageForSource(active.fsPath)) || defaultLanguage();
        return checkEnvironment(root ? active! : vscode.workspace.workspaceFolders?.[0]?.uri || context.extensionUri, language.id);
    });
    register('ojassist.refreshPractice', () => tree.refresh());
    register('ojassist.searchPractice', async () => { const filter = await vscode.window.showInputBox({ prompt: '搜索本地链接题目（留空显示全部）' }); if (filter !== undefined) { tree.search(filter); } });
    register('ojassist.runSamples', async () => {
        await messages;
        const source = vscode.window.activeTextEditor?.document.uri;
        const p = source && practiceForUri(source);
        if (!source || !p) { throw new Error('请先打开链接模式的 main 代码文件'); }
        return run(source, p);
    });
    register('ojassist.removePractice', async item => {
        const entry = selected(item); if (!entry) { return; }
        await removeProblem(entry.root, entry.problem.key);
        const dir = problemDir(entry.root, entry.problem.key);
        if (binding && path.dirname(binding.source.fsPath) === dir) { panel?.dispose(); }
        await tree.refresh(); vscode.window.showInformationMessage('已从列表移除，代码文件已保留；重新导入原链接可恢复。');
    });
    context.subscriptions.push(view, tree, output, { dispose: () => panel?.dispose() },
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void guard(() => tree.refresh())(); }),
        vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('ojassist.practice.language')) { void guard(() => tree.refresh())(); } }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!panel || !editor || showingSource || editor.document.uri.fsPath === binding?.source.fsPath) { return; }
            const source = editor.document.uri;
            const problem = practiceForUri(source);
            const language = languageForSource(source.fsPath);
            const root = vscode.workspace.getWorkspaceFolder(source)?.uri.fsPath;
            if (root && problem && language) { void guard(() => open({ problem, root }, language.id))(); }
        }));
    void guard(() => tree.refresh())();
}

function statementHtml(p: PracticeProblem, panel: vscode.WebviewPanel, context: vscode.ExtensionContext, binding: StatementBinding): string {
    const nonce = randomBytes(18).toString('hex');
    const web = panel.webview;
    const katex = web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'assets', 'katex', 'katex.min.css'));
    const samples = p.samples.map((s, i) => `<section class="sample"><h3>测试 ${i + 1}</h3><label>输入<textarea class="input" spellcheck="false">${e(s.input)}</textarea></label><label>预期输出<textarea class="output" spellcheck="false">${e(s.output)}</textarea></label></section>`).join('');
    const options = languages.map(l => `<option value="${l.id}" ${l.id === binding.language ? 'selected' : ''}>${e(l.label)}</option>`).join('');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http:; style-src ${web.cspSource} 'unsafe-inline'; font-src ${web.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${katex}"><style>
    body{font-family:var(--vscode-font-family);line-height:1.7;padding:16px;max-width:1000px;margin:auto}h1{font-size:24px}a{color:var(--vscode-textLink-foreground)}img{max-width:100%}pre{overflow:auto;white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:7px 12px;cursor:pointer;margin:4px}button:hover{background:var(--vscode-button-hoverBackground)}.toolbar{position:sticky;top:0;background:var(--vscode-editor-background);padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}.muted{opacity:.7;font-size:12px}textarea{display:block;box-sizing:border-box;width:100%;min-height:90px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);font-family:var(--vscode-editor-font-family);padding:8px}.sample{border-top:1px solid var(--vscode-panel-border);padding-bottom:12px}table{border-collapse:collapse}td,th{border:1px solid var(--vscode-panel-border);padding:5px 10px}
    select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:5px;max-width:220px}
    </style></head><body><div class="toolbar"><label>做题语言 <select id="language" aria-label="选择做题语言">${options}</select></label><button data-command="run">运行全部测试</button><button data-command="check">检查编译环境</button><button data-command="submit">复制代码并打开提交页</button><button data-command="browser">原题网页</button></div>
    <p class="muted">链接刷题 · ${e(p.platform)} · ${e(languageById(binding.language)!.label)} · main.${binding.language} · 题面已缓存</p><h1>${e(p.title)}</h1>${renderLatex(sanitizeHtml(p.statement, p.url))}
    <h2>样例与自定义测试</h2><p class="muted">可编辑输入和预期输出，编辑时自动保存；切换语言会保留代码与测试。对比忽略空白差异。执行有时间和输出限制，不限制内存。</p>${samples}<button data-command="add">添加测试</button><button data-command="save">保存测试</button>
    <script nonce="${nonce}">
    const vscode=acquireVsCodeApi();const epoch=${binding.epoch};
    function send(command){const samples=Array.from(document.querySelectorAll('.sample')).map(s=>({input:s.querySelector('.input').value,output:s.querySelector('.output').value}));vscode.postMessage({command,samples,epoch,language:document.getElementById('language').value});}
    document.querySelectorAll('button[data-command]').forEach(b=>b.addEventListener('click',()=>send(b.dataset.command)));
    document.getElementById('language').addEventListener('change',()=>send('language'));
    document.querySelectorAll('textarea').forEach(el=>el.addEventListener('input',()=>send('autosave')));
    </script></body></html>`;
}
