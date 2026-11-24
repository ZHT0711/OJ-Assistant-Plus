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
    let initPanel: vscode.WebviewPanel | undefined;
    let initMessage: ((value: any) => Promise<void>) | undefined;
    const initMessages: any[] = [];
    (vscode.window as any).createTreeView = (name: string, options: any) => { if (name === 'ojassistant.problems') { tree = options.treeDataProvider; } return originalTree(name, options); };
    (vscode.window as any).registerWebviewViewProvider = (name: string, provider: any, options: any) => { if (name === 'ojassistant.problemInfoView') { statement = provider; } return originalProvider(name, provider, options); };
    (vscode.window as any).createWebviewPanel = (...args: any[]) => {
        const panel = (originalPanel as any)(...args);
        if (args[0] === 'ojassist.accountTests') {
            testPanel = panel;
            const event = panel.webview.onDidReceiveMessage;
            panel.webview.onDidReceiveMessage = (listener: any, ...rest: any[]) => { testMessage = listener; return event(listener, ...rest); };
        }
        if (args[0] === 'ojassist.initWorkspace') {
            initPanel = panel;
            const event = panel.webview.onDidReceiveMessage;
            panel.webview.onDidReceiveMessage = (listener: any, ...rest: any[]) => { initMessage = listener; return event(listener, ...rest); };
            const post = panel.webview.postMessage;
            panel.webview.postMessage = (message: any) => { initMessages.push(message); return post.call(panel.webview, message); };
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
        const accountSuffix = path.basename(path.dirname(roots[0].fsPath));
        assert.ok(roots.length >= 2, 'host test requires two isolated folders');
        await until(() => roots.every(root => api.accounts.get(root).generation > 0 && api.accounts.get(root).state !== 'loading'), 'initial account discovery');
        for (let i = 0; i < 2; i++) {
            await fs.writeFile(path.join(roots[i].fsPath, '.ojassistconfig.json'), JSON.stringify({ backend: 'fixture-account', credentials: { username: 'fixture-student-' + i + '-' + accountSuffix, cookies: 'fixture-cookie-' + i + '-' + accountSuffix }, preferredLanguage: 54,
                pathParseRule: { contestProblem: '', normalProblem: '\\/([A-Z]\\d+)\\.(\\w+)$' } }));
            assert.strictEqual(await vscode.commands.executeCommand('ojassist.reload', roots[i]), 'ready', api.accounts.get(roots[i]).message);
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
        const parentConfig = await fs.readFile(configFile, 'utf8');
        const nested = vscode.Uri.joinPath(roots[0], 'HDOJ');
        await fs.mkdir(nested.fsPath);
        api.accounts.select(roots[1]);
        await vscode.commands.executeCommand('ojassist.initWorkspace', nested);
        assert.ok(initPanel && initMessage, 'folder initialization opens platform picker');
        assert.ok(initPanel!.webview.html.includes(nested.fsPath), 'picker identifies the clicked folder');
        await initMessage!({ command: 'init', backend: 'hdoj' });
        const nestedFile = path.join(nested.fsPath, '.ojassistconfig.json');
        const nestedConfig = JSON.parse(await fs.readFile(nestedFile, 'utf8'));
        assert.strictEqual(nestedConfig.backend, 'hdoj');
        assert.strictEqual(await fs.readFile(configFile, 'utf8'), parentConfig, 'nested init preserves parent platform');
        assert.ok(await fs.stat(path.join(nested.fsPath, '.vscode', 'oj-run.cjs')));
        const menu = extension.packageJSON.contributes.menus['explorer/context'];
        assert.ok(menu.some((item: any) => item.command === 'ojassist.initWorkspace' && item.when.includes('explorerResourceIsFolder')));
        const hdoj = api.backends.hdoj;
        try {
            api.backends.hdoj = FixtureOJ;
            const nestedUsername = 'fixture-nested-hdoj-' + accountSuffix;
            const nestedCookie = 'fixture-nested-cookie-' + accountSuffix;
            nestedConfig.credentials = { username: nestedUsername, cookies: nestedCookie };
            await fs.writeFile(nestedFile, JSON.stringify(nestedConfig));
            assert.strictEqual(await vscode.commands.executeCommand('ojassist.reload', nested), 'ready');
            await vscode.commands.executeCommand('ojassist.openProblem', { id: '1000', title: 'nested HDOJ sum' });
            const nestedSource = vscode.Uri.joinPath(nested, 'problems', '1000.cpp');
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), nestedSource.toString(), 'HDOJ code goes into the nested folder');
            assert.strictEqual(api.accounts.forUri(nestedSource).root.toString(), nested.toString());
            assert.strictEqual(api.accounts.forUri(cpp).root.toString(), roots[0].toString());
            const parentPosts = instances.filter(server => server.config.backend !== 'hdoj').reduce((sum, server) => sum + server.posts.length, 0);
            const nestedRecord = await vscode.commands.executeCommand<any>('ojassist.submitAccountSource', nestedSource);
            assert.strictEqual(nestedRecord.backend, 'hdoj');
            assert.strictEqual(nestedRecord.state, 'completed');
            assert.strictEqual((api.accounts.get(nested).server as FixtureOJ).posts.length, 1);
            assert.strictEqual(instances.filter(server => server.config.backend !== 'hdoj').reduce((sum, server) => sum + server.posts.length, 0), parentPosts, 'nested code is never uploaded to the parent platform');
            await until(async () => !!(await fs.stat(path.join(nested.fsPath, '.oj-assistant', 'accounts', 'history.json')).catch(() => undefined)), 'nested history');
            await until(async () => (await api.accounts.library.list('hdoj')).some((account: any) => account.username === nestedUsername), 'saved-account import');
            const saved = (await api.accounts.library.list('hdoj')).find((account: any) => account.username === nestedUsername);
            assert.ok(saved, 'existing logins automatically enter the saved account library');
            await initMessage!({ command: 'ready' });
            assert.ok(initMessages.some(message => message.command === 'accounts' && message.accounts.hdoj.some((account: any) => account.id === saved.id)));
            await initMessage!({ command: 'rename', backend: 'hdoj', accountId: saved.id, label: '我的杭电主号' });
            assert.strictEqual((await api.accounts.library.list('hdoj')).find((account: any) => account.id === saved.id).label, '我的杭电主号');
            initPanel!.dispose();
            const reused = vscode.Uri.joinPath(roots[0], 'HDOJ-reused');
            await fs.mkdir(reused.fsPath);
            await vscode.commands.executeCommand('ojassist.initWorkspace', reused);
            await initMessage!({ command: 'init', backend: 'hdoj', accountId: saved.id });
            assert.strictEqual(api.accounts.get(reused).state, 'ready', 'saved account initializes a new folder without another login');
            assert.notStrictEqual(api.accounts.get(reused).key, api.accounts.get(nested).key, 'reusing credentials preserves workspace submission isolation');
            const reusedConfigFile = path.join(reused.fsPath, '.ojassistconfig.json');
            const reusedRaw = await fs.readFile(reusedConfigFile, 'utf8');
            assert.ok(!reusedRaw.includes('fixture-nested-cookie'), 'reused secrets never enter workspace JSON');
            assert.strictEqual((await api.accounts.vault.read(reusedConfigFile)).credentials.cookies, nestedCookie);
            const beforeInvalidSelection = reusedRaw;
            await initMessage!({ command: 'init', backend: 'luogu', accountId: saved.id });
            assert.strictEqual(await fs.readFile(reusedConfigFile, 'utf8'), beforeInvalidSelection, 'cross-platform selection is rejected before changing files');
            assert.ok(!JSON.stringify(initMessages).includes('fixture-nested-cookie'), 'webview messages contain metadata only');
            api.accounts.remove(nested);
            await api.accounts.discover();
            assert.strictEqual(api.accounts.get(nested).state, 'ready', 'startup discovery reloads nested configs');
            assert.ok(api.accounts.roots.some((root: vscode.Uri) => root.toString() === nested.toString()), 'nested folder appears in account switcher');
            await fs.unlink(nestedFile);
            assert.strictEqual(api.accounts.forUri(nestedSource).root.toString(), roots[0].toString(), 'removed nested config falls back to parent');
            assert.strictEqual(await fs.readFile(configFile, 'utf8'), parentConfig);
            const originalWarning = vscode.window.showWarningMessage;
            try {
                (vscode.window as any).showWarningMessage = async () => '移除';
                await initMessage!({ command: 'remove', backend: 'hdoj', accountId: saved.id });
            } finally { (vscode.window as any).showWarningMessage = originalWarning; }
            assert.ok(!(await api.accounts.library.list('hdoj')).some((account: any) => account.id === saved.id));
            assert.strictEqual(await vscode.commands.executeCommand('ojassist.reload', reused), 'ready', 'removing a library account preserves configured workspaces');
            assert.ok(!(await api.accounts.library.list('hdoj')).some((account: any) => account.username === nestedUsername), 'forgotten accounts do not reappear during reload');
            await vscode.commands.executeCommand('ojassist.openProblem', { id: '1000', title: 'restricted submission fixture' });
            const restrictedSource = vscode.Uri.joinPath(reused, 'problems', '1000.cpp');
            const warning = vscode.window.showWarningMessage;
            const notices: any[][] = [];
            let rejectedUploads = 0;
            try {
                (vscode.window as any).showWarningMessage = async (...args: any[]) => { notices.push(args); return undefined; };
                api.accounts.get(reused).server.submit = async () => {
                    rejectedUploads++; throw { response: { status: 429, headers: { 'retry-after': '60' } } };
                };
                const cooldown = await vscode.commands.executeCommand<any>('ojassist.submitAccountSource', restrictedSource);
                assert.strictEqual(cooldown.state, 'failed'); assert.strictEqual(cooldown.restriction, 'cooldown');
                assert.strictEqual(api.accounts.get(reused).state, 'ready', 'rate limiting preserves login');
                const restrictedHistory = path.join(reused.fsPath, '.oj-assistant', 'accounts', 'history.json');
                await until(async () => JSON.parse(await fs.readFile(restrictedHistory, 'utf8')).some((record: any) => record.localId === cooldown.localId && record.retryAt), 'persisted cooldown');
                api.submissions.jobs.delete(cooldown.localId);
                await vscode.commands.executeCommand('ojassist.reload', reused);
                const blocked = await vscode.commands.executeCommand<any>('ojassist.submitAccountSource', restrictedSource);
                assert.strictEqual(blocked.restriction, 'cooldown'); assert.strictEqual(rejectedUploads, 1);
                assert.strictEqual((api.accounts.get(reused).server as FixtureOJ).posts.length, 0, 'restored cooldown prevents an HTTP upload');
                for (const job of api.submissions.jobs.values()) {
                    if (job.sessionKey === cooldown.sessionKey) { job.retryAt = Date.now() - 1; }
                }
                api.accounts.get(reused).server.submit = async () => {
                    rejectedUploads++; throw { response: { status: 403, data: { errors: { captcha: ['验证码错误'] } } } };
                };
                const captcha = await vscode.commands.executeCommand<any>('ojassist.submitAccountSource', restrictedSource);
                assert.strictEqual(captcha.state, 'failed'); assert.strictEqual(captcha.restriction, 'captcha');
                assert.strictEqual(api.accounts.get(reused).state, 'ready', 'captcha preserves login');
                assert.ok(notices.some(args => args.includes('复制代码并打开原站')), 'verification exposes a manual browser action');
                await vscode.commands.executeCommand('ojassist.resumeJudgement', captcha.localId);
                assert.strictEqual(rejectedUploads, 2, 'resuming a rejected record sends no code');
                console.log('SUBMISSION_RESTRICTIONS_HOST_PASS: cooldown persistence, blocked repeat uploads, captcha action, login preservation, failed-record query handling');
            } finally { (vscode.window as any).showWarningMessage = warning; }
        } finally { api.backends.hdoj = hdoj; initPanel?.dispose(); }
        const cf = api.backends.codeforces;
        const originalInput = vscode.window.showInputBox;
        try {
            api.backends.codeforces = FixtureOJ;
            let passwordHidden = false;
            (vscode.window as any).showInputBox = async (options: any) => {
                if (options.password) { passwordHidden = true; return 'fixture-private-password'; }
                return 'fixture-cf-student-' + accountSuffix;
            };
            const cfRoot = vscode.Uri.joinPath(roots[0], 'Codeforces');
            await fs.mkdir(cfRoot.fsPath);
            await vscode.commands.executeCommand('ojassist.initWorkspace', cfRoot);
            await initMessage!({ command: 'login', backend: 'codeforces', label: 'CF 主号' });
            assert.ok(passwordHidden);
            assert.strictEqual(api.accounts.get(cfRoot).state, 'ready');
            const cfAccount = (await api.accounts.library.list('codeforces')).find((account: any) => account.username === 'fixture-cf-student-' + accountSuffix);
            assert.strictEqual(cfAccount.label, 'CF 主号');
            assert.strictEqual((await api.accounts.library.credentials(cfAccount.id, 'codeforces')).credentials.password, 'fixture-private-password');
            assert.ok(!(await fs.readFile(path.join(cfRoot.fsPath, '.ojassistconfig.json'), 'utf8')).includes('fixture-private-password'));
            assert.ok(!JSON.stringify(initMessages).includes('fixture-private-password'));
            console.log('SAVED_ACCOUNT_HOST_PASS: automatic import, panel account list/rename/remove, reuse in another folder, platform isolation, hidden password login, no credentials in webview or workspace JSON');
        } finally { api.backends.codeforces = cf; (vscode.window as any).showInputBox = originalInput; initPanel?.dispose(); }
        console.log('NESTED_FOLDER_HOST_PASS: folder context menu, explicit initialization target, parent config preserved, nested HDOJ generation/submission/history, startup discovery and deletion fallback');
        console.log('ACCOUNT_HOST_PASS: workspace/account isolation, SecretStorage migration, language matching, real samples, custom tests, statement identity, AC refresh, cancellation and persisted query-only recovery');
    } finally {
        (vscode.window as any).createTreeView = originalTree;
        (vscode.window as any).registerWebviewViewProvider = originalProvider;
        (vscode.window as any).createWebviewPanel = originalPanel;
        (vscode.window as any).withProgress = originalProgress;
    }
}
