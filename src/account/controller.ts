import * as vscode from 'vscode';
import * as path from 'path';
import { SourceFile } from '../model';
import { parseSourceFile } from '../utils/sourceUtils';
import { AccountSession, accounts, isAuthenticationError } from './session';
import { matchLanguages, sourceExtension } from './language';
import { safeMessage } from './credentials';
import { submissionHistory } from './history';
import { recordOf, SubmissionJob, SubmissionRecord, SubmissionTracker, WaitStopped } from './submissions';
import { registerAccountTesting } from './testing';

export const submissions = new SubmissionTracker();
let context: vscode.ExtensionContext;
let output: vscode.OutputChannel;
const roots = new Map<string, vscode.Uri>();
const servers = new Map<string, object>();
const redactions = new Map<string, any>();
/** Runtime-only references are bounded; history is the durable store. */
const MAX_RUNTIME_ENTRIES = 64;
function rememberRuntime(job: SubmissionJob, root: vscode.Uri, server: object, credentials: any): void {
    roots.set(job.localId, root);
    servers.set(job.localId, server);
    redactions.set(job.localId, credentials);
    if (roots.size <= MAX_RUNTIME_ENTRIES) { return; }
    for (const id of roots.keys()) {
        if (roots.size <= MAX_RUNTIME_ENTRIES) { break; }
        const state = submissions.jobs.get(id)?.state;
        if (!state || state === 'completed' || state === 'failed') {
            roots.delete(id); servers.delete(id); redactions.delete(id);
        }
    }
}

function persist(job: SubmissionJob): void {
    const root = roots.get(job.localId);
    if (root) { void submissionHistory.save(root.fsPath, recordOf(job)).catch(() => { output.appendLine('提交历史保存失败，请检查工作区写入权限。'); }); }
}
function seconds(uri: vscode.Uri, name: string, fallback: number): number {
    const value = Number(vscode.workspace.getConfiguration('ojassist.account', uri).get(name, fallback));
    return Math.max(100, Math.min(600000, (Number.isFinite(value) ? value : fallback) * 1000));
}
async function selectLanguage(session: AccountSession, source: SourceFile): Promise<boolean> {
    const generation = session.generation;
    const sessionKey = session.key;
    const available = session.server?.listLanguages?.() || [];
    const ext = sourceExtension(source.sourceType);
    const configured = session.config?.languages?.[source.sourceType] ?? session.config?.languages?.[ext];
    if (!available.length) { source.languageOverride = configured; return true; }
    const { choices, selected } = matchLanguages(ext, available, accounts.remembered(session, ext), accounts.preferred(session), configured);
    if (!choices.length) {
        if (configured !== undefined && !available.some(l => String(l.value) === String(configured))) { source.languageOverride = configured; return true; }
        throw new Error(`当前平台没有与 .${source.sourceType} 匹配的语言，请检查文件扩展名及平台语言配置`);
    }
    let language = selected;
    if (!language && session.config?.askLanguage === false) { language = choices[0]; }
    if (!language) {
        const picked = await vscode.window.showQuickPick(choices.map(l => ({ ...l, description: `.${ext}` })), { placeHolder: `选择 ${session.config?.backend} 的 .${ext} 提交语言`, ignoreFocusOut: true });
        if (!picked) { return false; }
        language = picked;
    }
    source.languageOverride = language.value;
    if (session.generation !== generation || session.key !== sessionKey) { throw new Error('账号已变化，请重新确认提交语言'); }
    await accounts.remember(session, ext, language);
    return true;
}

async function poll(job: SubmissionJob, session: AccountSession): Promise<void> {
    const server = servers.get(job.localId);
    const credentials = redactions.get(job.localId);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${job.backend} · ${job.problemId} · 等待评测`, cancellable: true }, async (progress, token) => {
        try {
            const verdict = await submissions.poll(job, {
                timeout: seconds(session.root, 'judgementTimeout', 120), requestTimeout: seconds(session.root, 'requestTimeout', 15), interval: 1000, token,
                onChange: current => { if (current.verdict?.details) { current.verdict.details = safeMessage(current.verdict.details, credentials); } progress.report({ message: current.verdict?.result || current.message || '查询中…' }); persist(current); },
            });
            if (verdict.details) { verdict.details = safeMessage(verdict.details, credentials); }
            persist(job);
            output.appendLine(`[${new Date().toLocaleString()}] ${job.backend} ${job.problemId}: ${verdict.result}${job.recordId ? ' · 记录 ' + job.recordId : ''}`);
            if (verdict.details) { output.appendLine(verdict.details); }
            const perf = [verdict.time && verdict.time !== '-' ? verdict.time : '', verdict.memory && verdict.memory !== '-' ? verdict.memory : ''].filter(Boolean).join(' / ');
            void vscode.window.showInformationMessage(`${job.problemId}：${verdict.result}${perf ? ' · ' + perf : ''}`, '查看提交历史').then(choice => {
                if (choice) { void vscode.commands.executeCommand('ojassist.submissionHistory'); }
            });
            void vscode.commands.executeCommand('ojassist.recordAccountVerdict', recordOf(job));
            if (accounts.current?.key === job.sessionKey && accounts.current.server === server) { void vscode.commands.executeCommand('ojassist.refreshProblems'); }
        } catch (error) {
            if (session.key === job.sessionKey && session.server === server && isAuthenticationError(error)) { accounts.change(session, 'expired', '登录已过期，请重新登录后继续查询'); }
            const message = error instanceof WaitStopped ? `${error.message}；线上评测可能仍在进行，可继续查询本次记录。` : `获取评测暂时失败：${safeMessage(error, credentials)}。可继续查询本次记录。`;
            job.message = message; persist(job);
            void vscode.window.showWarningMessage(message, '继续查询', '重新登录').then(action => {
                if (action === '继续查询') { void vscode.commands.executeCommand('ojassist.resumeJudgement', job.localId); }
                if (action === '重新登录') { void vscode.commands.executeCommand('ojassist.webLogin', session.root); }
            });
        }
    });
}

export async function submitAccount(editor: vscode.TextEditor): Promise<SubmissionRecord | undefined> {
    let job: SubmissionJob | undefined;
    let session: AccountSession | undefined;
    try {
        session = accounts.assertReady(editor.document.uri);
        if (accounts.current !== session) { accounts.select(session.root); }
        // Capture the server, config and code before opening a language picker.
        const server = session.server!;
        const generation = session.generation;
        const source = parseSourceFile(editor.document.uri, session.config!, editor.document.getText());
        if (!source) { throw new Error('当前代码文件不符合账号题目的命名规则'); }
        const scope = JSON.stringify([session.key, source.contestId, source.id]);
        const existing = submissions.find(scope);
        if (existing) {
            const action = await vscode.window.showWarningMessage('这道题已有未结束的提交。可继续查询，或查看原站记录后确认重新提交。', '继续查询', '确认后重新提交');
            if (action === '继续查询') { await resume(existing.localId); }
            if (action === '确认后重新提交') {
                if (existing.state === 'uploading' || existing.state === 'waiting' || existing.state === 'preparing') { throw new Error('本次操作仍在执行，请先停止等待或等待完成'); }
                const confirmed = await vscode.window.showWarningMessage('确认已检查原站提交记录，并允许发送一份新的代码？', { modal: true }, '允许重新提交');
                if (confirmed) { existing.state = 'failed'; existing.message = '用户确认允许重新提交'; persist(existing); return submitAccount(editor); }
            }
            return recordOf(existing);
        }
        job = submissions.create({ scope, sessionKey: session.key, backend: session.config!.backend, account: session.username || '', problemId: source.id,
            contestId: source.contestId, relativeFile: path.relative(session.root.fsPath, source.uri.fsPath) });
        rememberRuntime(job, session.root, server, session.config!.credentials); persist(job);
        if (!await selectLanguage(session, source)) { job.state = 'failed'; job.message = '选择语言时已取消，未上传代码'; persist(job); return recordOf(job); }
        if (session.generation !== generation || session.server !== server || session.state !== 'ready') { throw new Error('账号状态已变化，请确认当前账号后重新提交'); }
        job.language = source.languageOverride;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${job.backend} · ${source.id} · 上传代码`, cancellable: true }, async (progress, token) => {
            progress.report({ message: '正在发送本次代码…' });
            await submissions.send(job!, () => server.submit(source), seconds(session!.root, 'uploadTimeout', 30), token, () => persist(job!));
        });
        await poll(job, session);
        return recordOf(job);
    } catch (error) {
        if (job?.state === 'preparing') { job.state = 'failed'; }
        if (session && job && session.key === job.sessionKey && session.server === servers.get(job.localId) && isAuthenticationError(error)) { accounts.change(session, 'expired', '登录已过期，请重新登录'); }
        const message = safeMessage(error, job ? redactions.get(job.localId) : session?.config?.credentials);
        if (job) { job.message = job.state === 'unknown' ? '上传结果未确认，请先查看原站提交记录；上传不会自动重试。' : message; persist(job); }
        vscode.window.showWarningMessage(job?.state === 'unknown' ? job.message! : message);
        return job ? recordOf(job) : undefined;
    }
}

async function resume(id?: string): Promise<void> {
    const session = accounts.current;
    if (!session?.server || session.state !== 'ready' || !session.config) { throw new Error('请先登录对应账号，再继续查询'); }
    if (!id) {
        await submissionHistory.flush(session.root.fsPath);
        const all = await submissionHistory.list(session.root.fsPath);
        const records = all.filter(r => r.sessionKey === session.key && !['completed', 'failed'].includes(r.state));
        if (records.length === 0) {
            // An empty QuickPick looks like "the button does nothing" - say why.
            const sameAccount = all.some(r => r.sessionKey === session.key);
            const message = sameAccount
                ? '当前账号没有正在等待的评测。已完成的提交可在“查看提交历史”中查看。'
                : (all.length > 0
                    ? '本地提交记录属于其他账号或工作区，请切换回原工作区后再查询。'
                    : '当前账号还没有本地提交记录；通过本扩展提交一次后会自动记录。');
            const action = await vscode.window.showInformationMessage(message, '查看提交历史');
            if (action === '查看提交历史') { await vscode.commands.executeCommand('ojassist.submissionHistory'); }
            return;
        }
        const picked = await vscode.window.showQuickPick(records.map(record => ({ label: `${record.problemId} · ${record.state}`, description: record.createdAt, record })), { placeHolder: '选择要继续查询的提交' });
        id = picked?.record.localId;
        if (!id) { return; }
    }
    let job = submissions.jobs.get(id);
    if (!job) {
        await submissionHistory.flush(session.root.fsPath);
        const record = (await submissionHistory.list(session.root.fsPath)).find(r => r.localId === id);
        if (!record || record.sessionKey !== session.key) { throw new Error('该记录不属于当前账号工作区'); }
        job = { ...record, state: 'paused' };
        submissions.jobs.set(id, job); roots.set(id, session.root);
    }
    if (!roots.has(id)) { roots.set(id, session.root); }
    if (roots.get(id)?.toString() !== session.root.toString() || job.sessionKey !== session.key) { throw new Error('请先切换到原提交的平台和账号'); }
    if (job.state === 'completed') { vscode.window.showInformationMessage(job.verdict?.result || '评测已完成'); return; }
    if (!job.resolver || servers.get(id) !== session.server) {
        if (!job.recordId || !session.server.resumeSubmission) { throw new Error('该平台尚无可恢复的独立提交编号，请在原站查看记录；本命令不会重新上传代码'); }
        const file = path.resolve(session.root.fsPath, job.relativeFile);
        const relative = path.relative(session.root.fsPath, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('提交记录中的代码路径无效'); }
        const source = new SourceFile(job.problemId, job.contestId, path.extname(file).slice(1), '', vscode.Uri.file(file), job.language);
        job.resolver = session.server.resumeSubmission(job.recordId, source) as any;
        job.query = undefined;
        rememberRuntime(job, session.root, session.server, session.config.credentials);
    }
    await poll(job, session);
}

export function registerAccountCommands(extensionContext: vscode.ExtensionContext): void {
    context = extensionContext;
    output = vscode.window.createOutputChannel('OJ Assistant · 账号评测');
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    status.command = 'ojassist.accountStatus';
    const update = () => {
        const session = accounts.current;
        status.text = `$(account) ${session?.config?.backend || 'OJ 账号'} · ${session?.state === 'ready' ? session.username : session?.state === 'loading' ? '登录中…' : session?.state === 'expired' ? '登录过期' : '未就绪'}`;
        status.tooltip = session?.message || '查看账号状态 / 登录 / 切换工作区'; status.show();
    };
    const register = (name: string, callback: (...args: any[]) => Promise<any>) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: any[]) => {
        try { return await callback(...args); } catch (error) { vscode.window.showWarningMessage(safeMessage(error, accounts.current?.config?.credentials)); }
    }));
    register('ojassist.accountStatus', async () => {
        const session = accounts.current;
        const action = await vscode.window.showQuickPick(['浏览器登录 / 重新登录', '重试账号连接', '切换账号工作区', '查看提交历史'], { placeHolder: `${session?.config?.backend || '未配置'} · ${session?.username || ''} · ${session?.message || session?.state || '未配置'}` });
        if (action === '浏览器登录 / 重新登录') { await vscode.commands.executeCommand('ojassist.webLogin', session?.root); }
        if (action === '重试账号连接') { await vscode.commands.executeCommand('ojassist.reload', session?.root); }
        if (action === '切换账号工作区') { await vscode.commands.executeCommand('ojassist.selectAccountWorkspace'); }
        if (action === '查看提交历史') { await vscode.commands.executeCommand('ojassist.submissionHistory'); }
    });
    register('ojassist.selectAccountWorkspace', async () => {
        const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择账号题库使用的工作区文件夹' });
        if (picked) { accounts.select(picked.uri); if (accounts.get(picked.uri).state === 'unconfigured') { await accounts.load(picked.uri); } }
    });
    register('ojassist.resumeJudgement', id => resume(id));
    register('ojassist.submitAccountSource', async (source: vscode.Uri) => {
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), { preview: false });
        return submitAccount(editor);
    });
    register('ojassist.submissionHistory', async () => {
        const session = accounts.current;
        if (!session) { vscode.window.showWarningMessage('OJ-Assistant: 请先打开并登录账号工作区，再查看提交历史。'); return; }
        await submissionHistory.flush(session.root.fsPath);
        const all = await submissionHistory.list(session.root.fsPath);
        const records = all.filter(r => r.sessionKey === session.key);
        if (records.length === 0) {
            // Avoid opening an empty QuickPick, which reads as a dead button.
            const message = all.length > 0
                ? '本地提交记录属于其他账号或工作区，请切换回原工作区后再查看。'
                : `当前账号（${session.config?.backend ?? '未配置'}）还没有本地提交记录；通过本扩展提交一次后会自动记录。`;
            vscode.window.showInformationMessage(message);
            return;
        }
        const picked = await vscode.window.showQuickPick(records.map(record => ({ label: `${record.problemId} · ${record.verdict?.result || record.state}`, description: new Date(record.createdAt).toLocaleString(), detail: `${record.relativeFile}${record.recordId ? ' · 记录 ' + record.recordId : ''}`, record })), { placeHolder: records.length ? '选择提交记录查看详情或继续查询' : '当前账号暂无本地提交记录' });
        if (!picked) { return; }
        const action = await vscode.window.showQuickPick(['查看详情', '打开代码', '继续查询'], { placeHolder: picked.label });
        if (action === '继续查询') { await resume(picked.record.localId); }
        if (action === '查看详情') { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(picked.record, null, 2) })); }
        if (action === '打开代码') {
            const file = path.resolve(session.root.fsPath, picked.record.relativeFile);
            const relative = path.relative(session.root.fsPath, file);
            if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('代码路径不属于当前工作区'); }
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
        }
    });
    context.subscriptions.push(output, status, accounts.onDidChange(update));
    registerAccountTesting(context);
    update();
}
