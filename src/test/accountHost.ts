import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

async function until(check: () => Promise<boolean> | boolean, label = 'condition'): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await check()) { return; } await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Host assertion timed out: ' + label);
}

/** Use fresh empty folders to intercept views before workspaceContains activation. No network. */
export async function run(): Promise<void> {
    const extension = vscode.extensions.getExtension('skowosy.oj-assistant-plus')!;
    let tree: any, statement: any;
    const originalTree = vscode.window.createTreeView;
    const originalProvider = vscode.window.registerWebviewViewProvider;
    const originalPanel = vscode.window.createWebviewPanel;
    const originalProgress = vscode.window.withProgress;
    let testPanel: vscode.WebviewPanel | undefined;
    let testMessage: ((value: any) => void) | undefined;
    (vscode.window as any).createTreeView = (name: string, options: any) => { if (name === 'ojassistant.problems') { tree = options.treeDataProvider; } return originalTree(name, options); };
    (vscode.window as any).registerWebviewViewProvider = (name: string, provider: any, options: any) => { if (name === 'ojassistant.problemInfoView') { statement = provider; } return originalProvider(name, provider, options); };
    (vscode.window as any).createWebviewPanel = (...args: any[]) => {
        const panel = (originalPanel as any)(...args);
        if (args[0] === 'ojassist.accountTests') {
            testPanel = panel;
            const event = panel.webview.onDidReceiveMessage;
            panel.webview.onDidReceiveMessage = (listener: any, ...rest: any[]) => { testMessage = listener; return event(listener, ...rest); };
        }
        return panel;
    };
    const instances: FixtureOJ[] = [];
    class FixtureOJ {
        posts: any[] = [];
        resumeCount = 0;
        hold = false;
        constructor(public config: any) { instances.push(this); }
        async login() { if (this.config.testLoginFailure) { throw new Error('not logged in fixture'); } return { user: this.config.credentials.username }; }
        listLanguages() { return [{ value: 54, label: 'C++17' }, { value: 31, label: 'Python3' }, { value: 43, label: 'C' }]; }
        async searchProblems() { return { problems: [{ id: 'P1001', title: this.config.credentials.username + ' sum' }], hasMore: false }; }
        async getProblem(info: any) { return { ...info, content: { title: this.config.credentials.username + ' ' + info.id, desc: '<p>Sum</p>', input: '', output: '', sampleInput: ['<pre>1 2\n</pre>'], sampleOutput: ['<pre>3\n</pre>'] } }; }
        async submit(source: any) { this.posts.push({ type: source.sourceType, language: source.languageOverride, file: source.uri.fsPath }); return Object.assign(async () => ({ result: this.hold ? 'Judging...' : 'Accepted', time: '1 ms', memory: '1 MB' }), { submissionId: String(1000 + this.posts.length) }); }
        resumeSubmission() { this.resumeCount++; return async () => ({ result: 'Accepted', time: '1 ms' }); }
    }
    try {
        await extension.activate();
        const api = extension.exports;
        api.backends['fixture-account'] = FixtureOJ;
        const roots = vscode.workspace.workspaceFolders!.map(f => f.uri);
        assert.ok(roots.length >= 2, 'host test requires two isolated folders');
        for (let i = 0; i < 2; i++) {
            await fs.writeFile(path.join(roots[i].fsPath, '.ojassistconfig.json'), JSON.stringify({ backend: 'fixture-account', credentials: { username: 'fixture-student-' + i, cookies: 'fixture-cookie-' + i }, preferredLanguage: 54,
                pathParseRule: { contestProblem: '', normalProblem: '\\/([A-Z]\\d+)\\.(\\w+)$' } }));
            assert.strictEqual(await vscode.commands.executeCommand('ojassist.reload', roots[i]), 'ready');
            const raw = await fs.readFile(path.join(roots[i].fsPath, '.ojassistconfig.json'), 'utf8');
            assert.ok(!raw.includes('fixture-cookie-'), 'cookies migrated out of public configuration');
            assert.strictEqual(api.accounts.get(roots[i]).state, 'ready');
        }
        assert.notStrictEqual(api.accounts.get(roots[0]).key, api.accounts.get(roots[1]).key);
        api.accounts.select(roots[0]);
        await vscode.commands.executeCommand('ojassist.openProblem', { id: 'P1001', title: 'sum' });
        const cpp = vscode.Uri.file(path.join(roots[0].fsPath, 'P1001.cpp'));
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, cpp.fsPath, 'code generated in selected account folder');
        const doc = await vscode.workspace.openTextDocument(cpp);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(cpp, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}');
        await vscode.workspace.applyEdit(edit); await doc.save();
        api.accounts.select(roots[1]);
        const first = await vscode.commands.executeCommand<any>('ojassist.submitAccountSource', cpp);
        assert.strictEqual(first.state, 'completed');
        const cppServer = api.accounts.get(roots[0]).server as FixtureOJ;
        assert.strictEqual(cppServer.posts[0].language, 54, 'C++ compiler belongs to source account');
        const samples = await vscode.commands.executeCommand<any[]>('ojassist.runAccountSamples', cpp);
        assert.ok(samples?.[0].passed, 'real account C++ sample passes');
        await vscode.commands.executeCommand('ojassist.accountTests', cpp);
        assert.ok(testPanel && testMessage);
        const epoch = Number(/epoch:(\d+)/.exec(testPanel!.webview.html)![1]);
        testMessage!({ epoch, command: 'save', tests: [{ input: '-10 20\n', output: '10\n' }] });
        const custom = await vscode.commands.executeCommand<any[]>('ojassist.runAccountSamples', cpp);
        assert.ok(custom?.[0].passed, 'custom account test persists and executes');
        const python = vscode.Uri.file(path.join(roots[1].fsPath, 'P1001.py'));
        await fs.writeFile(python.fsPath, 'print(sum(map(int,input().split())))\n');
        const pyRecord = await vscode.commands.executeCommand<any>('ojassist.submitAccountSource', python);
        assert.strictEqual(pyRecord.language, 31, 'Python does not inherit global C++ language');
        const pyServer = api.accounts.get(roots[1]).server as FixtureOJ;
        assert.strictEqual(pyServer.posts[0].language, 31); assert.strictEqual(cppServer.posts.length, 1);
        await vscode.commands.executeCommand('ojassistant.problemInfoView.focus');
        await until(() => statement?.lastContent?.title?.includes('fixture-student-1'), 'account statement after workspace switch');
        assert.ok(statement.lastContent.title.includes('fixture-student-1'), 'same problem ID uses the new account statement');
        await vscode.commands.executeCommand('ojassist.refreshProblems');
        const row = tree.getChildren().find((node: any) => node.entry?.id === 'P1001');
        assert.ok(tree.getTreeItem(row).description.includes('已AC'), 'verdict updates completion state');
        await vscode.window.showTextDocument(doc);
        cppServer.hold = true;
        const cancel = new vscode.CancellationTokenSource();
        (vscode.window as any).withProgress = (options: any, callback: any) => (originalProgress as any)(options, (progress: any, token: any) => {
            if (String(options.title).includes('等待评测')) { setTimeout(() => cancel.cancel(), 30); return callback(progress, cancel.token); }
            return callback(progress, token);
        });
        const paused = await vscode.commands.executeCommand<any>('ojassist.submitAccountSource', cpp);
        (vscode.window as any).withProgress = originalProgress;
        cancel.dispose();
        assert.strictEqual(paused.state, 'paused'); assert.ok(paused.recordId);
        const historyFile = path.join(roots[0].fsPath, '.oj-assistant', 'accounts', 'history.json');
        await until(async () => JSON.parse(await fs.readFile(historyFile, 'utf8')).some((record: any) => record.localId === paused.localId && record.state === 'paused'), 'paused submission history');
        const postsBeforeResume = instances.reduce((sum, server) => sum + server.posts.length, 0);
        api.submissions.jobs.delete(paused.localId); // Exercise persisted recovery without an in-memory resolver.
        assert.strictEqual(await vscode.commands.executeCommand('ojassist.reload', roots[0]), 'ready');
        await vscode.commands.executeCommand('ojassist.resumeJudgement', paused.localId);
        assert.strictEqual(instances.reduce((sum, server) => sum + server.posts.length, 0), postsBeforeResume, 'resume never posts code');
        assert.strictEqual(api.submissions.jobs.get(paused.localId).state, 'completed');
        assert.strictEqual((api.accounts.get(roots[0]).server as FixtureOJ).resumeCount, 1);
        assert.ok(!(await fs.readFile(historyFile, 'utf8')).includes('fixture-cookie-'));
        const configFile = path.join(roots[0].fsPath, '.ojassistconfig.json');
        const config = JSON.parse(await fs.readFile(configFile, 'utf8')); config.testLoginFailure = true; await fs.writeFile(configFile, JSON.stringify(config));
        assert.strictEqual(await vscode.commands.executeCommand('ojassist.reload', roots[0]), 'expired');
        assert.ok(tree.getChildren()[0].label.includes('重新登录'), 'expired session is shown explicitly');
        config.testLoginFailure = false; await fs.writeFile(configFile, JSON.stringify(config)); await vscode.commands.executeCommand('ojassist.reload', roots[0]);
        console.log('ACCOUNT_HOST_PASS: workspace/account isolation, SecretStorage migration, language matching, real samples, custom tests, statement identity, AC refresh, cancellation and persisted query-only recovery');
    } finally {
        (vscode.window as any).createTreeView = originalTree;
        (vscode.window as any).registerWebviewViewProvider = originalProvider;
        (vscode.window as any).createWebviewPanel = originalPanel;
        (vscode.window as any).withProgress = originalProgress;
    }
}
