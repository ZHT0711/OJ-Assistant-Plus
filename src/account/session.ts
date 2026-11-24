import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { adapterFor, backends } from '../backend';
import { OJ, OJAssistConfig } from '../model';
import { CredentialVault, safeMessage } from './credentials';
import { getPreferredLanguage, LanguageChoice, resolvePreferred, setPreferredLanguage } from '../utils/languageState';
import { bounded } from './submissions';
import { nearestAccountRoot } from './roots';
import { ACCOUNT_LIBRARY_KEY, SavedAccountLibrary } from './library';

export interface AccountSession {
    root: vscode.Uri;
    key: string;
    state: 'unconfigured' | 'loading' | 'ready' | 'expired' | 'error' | 'untrusted';
    message?: string;
    config?: OJAssistConfig & { [key: string]: any };
    server?: OJ;
    username?: string;
    user?: any;
    generation: number;
    savedAccountId?: string;
}
class AccountManager {
    private sessions = new Map<string, AccountSession>();
    private changed = new vscode.EventEmitter<AccountSession | undefined>();
    readonly onDidChange = this.changed.event;
    private context!: vscode.ExtensionContext;
    vault!: CredentialVault;
    library!: SavedAccountLibrary;
    private selectedRoot?: vscode.Uri;
    initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        this.vault = new CredentialVault(context.secrets);
        this.library = new SavedAccountLibrary(context.secrets);
        context.subscriptions.push(context.secrets.onDidChange(event => {
            if (event.key === ACCOUNT_LIBRARY_KEY) { this.library.notify(); }
        }));
        context.subscriptions.push(this.changed);
    }
    get current(): AccountSession | undefined {
        const active = vscode.window.activeTextEditor?.document.uri;
        const root = this.selectedRoot || (active && this.forUri(active)?.root) || this.folder()?.uri;
        return root ? this.get(root) : undefined;
    }
    get roots(): vscode.Uri[] {
        const roots = new Map<string, vscode.Uri>();
        for (const folder of vscode.workspace.workspaceFolders || []) { roots.set(folder.uri.toString(), folder.uri); }
        for (const session of this.sessions.values()) {
            if (vscode.workspace.getWorkspaceFolder(session.root)) { roots.set(session.root.toString(), session.root); }
        }
        return Array.from(roots.values());
    }
    async discover(): Promise<void> {
        const configs = await vscode.workspace.findFiles('**/.ojassistconfig.json', '**/{node_modules,.git,.oj-assistant}/**');
        for (const config of configs) { this.get(vscode.Uri.joinPath(config, '..')); }
        await Promise.all(this.roots.filter(root => this.get(root).generation === 0).map(root => this.load(root)));
    }
    folder(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
        const active = uri || vscode.window.activeTextEditor?.document.uri;
        return (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
    }
    get(root: vscode.Uri): AccountSession {
        const key = root.toString();
        let session = this.sessions.get(key);
        if (!session) { session = { root, key, state: 'unconfigured', generation: 0 }; this.sessions.set(key, session); }
        return session;
    }
    remove(root: vscode.Uri): void {
        const session = this.sessions.get(root.toString());
        if (session) { session.generation++; session.server = undefined; session.state = 'unconfigured'; }
        this.sessions.delete(root.toString());
        if (this.selectedRoot?.toString() === root.toString()) { this.selectedRoot = undefined; }
        this.changed.fire(this.current);
    }
    removeOutsideWorkspace(): void {
        for (const session of Array.from(this.sessions.values())) {
            if (!vscode.workspace.getWorkspaceFolder(session.root)) { this.remove(session.root); }
        }
    }
    forUri(uri: vscode.Uri): AccountSession | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) { return undefined; }
        const root = uri.scheme === 'file'
            ? vscode.Uri.file(nearestAccountRoot(uri.fsPath, folder.uri.fsPath)) : folder.uri;
        return this.get(root);
    }
    select(root: vscode.Uri): void {
        this.selectedRoot = root;
        const session = this.get(root);
        setPreferredLanguage(resolvePreferred(session.config?.preferredLanguage, session.server?.listLanguages?.()));
        this.changed.fire(session);
    }
    change(session: AccountSession, state: AccountSession['state'], message?: string): void {
        session.state = state; session.message = message;
        this.changed.fire(session);
    }
    async load(root: vscode.Uri): Promise<AccountSession> {
        const session = this.get(root);
        const generation = ++session.generation;
        session.server = undefined;
        if ((vscode.workspace as any).isTrusted === false) { this.change(session, 'untrusted', '请先信任工作区，再登录账号'); return session; }
        this.change(session, 'loading', '正在读取配置并登录…');
        try {
            const raw = await this.vault.read(path.join(root.fsPath, '.ojassistconfig.json'));
            if (generation !== session.generation) { return session; }
            // Accept readable aliases but keep one canonical id in memory, so
            // capabilities (URLs, file layout, login) never diverge per alias.
            const adapter = adapterFor(raw.backend);
            if (!backends[raw.backend] && !adapter) { throw new Error('未知账号平台：' + raw.backend); }
            const config = adapter && adapter.id !== raw.backend ? { ...raw, backend: adapter.id } : raw;
            session.config = config;
            const credentials = config.credentials || {};
            if (!credentials.cookies && !(credentials.username && credentials.password)) {
                this.change(session, 'expired', '尚无可用凭据，请点击账号状态并通过浏览器登录');
                return session;
            }
            // Import existing workspace logins too, including expired cookies that
            // the user may want to refresh later. The panel never receives secrets.
            let savedAccountId = config.savedAccountId;
            try {
                const saved = await this.library.remember({ backend: config.backend, baseUrl: config.baseUrl, credentials,
                    id: savedAccountId, label: config.accountLabel, source: root.toString() });
                savedAccountId = saved?.id || savedAccountId;
            } catch { /* A broken account catalog must not prevent workspace login. */ }
            if (generation !== session.generation) { return session; }
            const server: OJ = new backends[config.backend](config);
            const user: any = await bounded(server.login(), 20000);
            if (generation !== session.generation) { return session; }
            const name = user?.username || user?.user || user?.handle || config.credentials?.username;
            const username = typeof name === 'string' || typeof name === 'number' ? String(name) : '当前会话';
            let saveWarning: string | undefined;
            try {
                const saved = await this.library.remember({ backend: config.backend, baseUrl: config.baseUrl, credentials,
                    username, id: savedAccountId, label: config.accountLabel, source: root.toString(), verified: true });
                savedAccountId = saved?.id || savedAccountId;
            } catch (error) { saveWarning = '账号已登录，但保存到账号库失败：' + safeMessage(error, credentials); }
            if (generation !== session.generation) { return session; }
            session.server = server;
            session.user = user;
            session.username = username;
            session.savedAccountId = savedAccountId;
            session.key = createHash('sha256').update(JSON.stringify([root.toString(), raw.backend, config.baseUrl || '', session.username])).digest('hex');
            this.change(session, 'ready', saveWarning);
            if (saveWarning) { void vscode.window.showWarningMessage(saveWarning); }
            if (this.current === session) { setPreferredLanguage(resolvePreferred(config.preferredLanguage, server.listLanguages?.())); }
        } catch (error) {
            if (generation !== session.generation) { return session; }
            const missing = error.code === 'ENOENT';
            this.change(session, missing ? 'unconfigured' : isAuthenticationError(error) ? 'expired' : 'error', missing ? '请初始化账号工作区' : safeMessage(error, session.config?.credentials));
        }
        return session;
    }
    assertReady(uri: vscode.Uri): AccountSession & { config: NonNullable<AccountSession['config']>; server: OJ } {
        const session = this.forUri(uri);
        if (!session || session.state !== 'ready' || !session.server || !session.config) { throw new Error(session?.message || '账号尚未登录，请在账号题库中登录或重试'); }
        return session as any;
    }
    async remember(session: AccountSession, ext: string, choice: LanguageChoice): Promise<void> {
        const key = session.key;
        await this.context.workspaceState.update('account.language.' + key + '|' + ext, choice);
        if (this.current === session && session.key === key) { setPreferredLanguage(choice); }
    }
    remembered(session: AccountSession, ext: string): LanguageChoice | undefined {
        return this.context.workspaceState.get<LanguageChoice>('account.language.' + session.key + '|' + ext);
    }
    preferred(session: AccountSession): LanguageChoice | undefined {
        return this.current === session ? getPreferredLanguage() : resolvePreferred(session.config?.preferredLanguage, session.server?.listLanguages?.());
    }
    profile(root: vscode.Uri, backend: string, accountId?: string): string {
        return path.join(this.context.globalStorageUri.fsPath, 'browser', backend,
            createHash('sha256').update(accountId ? 'saved-account:' + accountId : root.toString()).digest('hex').slice(0, 20));
    }
}
export function isAuthenticationError(error: any): boolean {
    const status = error?.response?.status;
    return status === 401 || /会话.{0,4}过期|未登录|未登录状态|not (?:logged|signed) in|not authenticated|session.{0,20}expired|refresh.*cookies/i.test(String(error?.message || error));
}
export const accounts = new AccountManager();
