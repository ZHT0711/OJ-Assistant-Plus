import { createHash, randomBytes } from 'crypto';
import { Secrets } from './credentials';

export const ACCOUNT_LIBRARY_KEY = 'ojassist.savedAccounts.v1';
export interface SavedAccount {
    id: string;
    backend: string;
    endpoint: string;
    label: string;
    username?: string;
    updatedAt: string;
    verifiedAt?: string;
}
interface StoredAccount extends SavedAccount { credentials: any; sources: string[]; }
interface Catalog { version: 1; accounts: StoredAccount[]; ignoredCredentials: string[]; }
interface RememberAccount {
    backend: string; baseUrl?: string; credentials: any; username?: string;
    id?: string; label?: string; source?: string; verified?: boolean; explicit?: boolean;
}
function endpoint(baseUrl?: string): string { return String(baseUrl || '').trim().replace(/\/+$/, ''); }
function identity(name?: string): string | undefined {
    const value = String(name || '').trim();
    return value && !/^(?:\(session\)|当前会话|当前账号|-)$/i.test(value) ? value : undefined;
}
function fingerprint(credentials: any): string {
    return createHash('sha256').update(JSON.stringify(Object.keys(credentials).sort().map(key => [key, credentials[key]]))).digest('hex');
}
function ignoredKey(backend: string, baseUrl: string | undefined, credentials: any): string {
    return createHash('sha256').update(JSON.stringify([backend, endpoint(baseUrl), fingerprint(credentials)])).digest('hex');
}
function ignoredUsername(backend: string, baseUrl: string | undefined, username?: string): string {
    return username ? 'user:' + createHash('sha256').update(JSON.stringify([backend, endpoint(baseUrl), username])).digest('hex') : '';
}
function publicAccount(account: StoredAccount): SavedAccount {
    const { id, backend, endpoint, label, username, updatedAt, verifiedAt } = account;
    return { id, backend, endpoint, label, username, updatedAt, verifiedAt };
}

/** All credentials and the catalog are encrypted by VS Code SecretStorage. */
export class SavedAccountLibrary {
    private pending: Promise<void> = Promise.resolve();
    private listeners = new Set<() => void>();
    constructor(private secrets: Secrets) { }
    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }
    notify(): void { for (const listener of this.listeners) { listener(); } }
    private async read(): Promise<Catalog> {
        const raw = await this.secrets.get(ACCOUNT_LIBRARY_KEY);
        if (!raw) { return { version: 1, accounts: [], ignoredCredentials: [] }; }
        try {
            const catalog = JSON.parse(raw);
            if (catalog.version !== 1 || !Array.isArray(catalog.accounts) || !Array.isArray(catalog.ignoredCredentials) ||
                !catalog.accounts.every((a: any) => a && typeof a.id === 'string' && typeof a.backend === 'string' &&
                    typeof a.endpoint === 'string' && typeof a.label === 'string' && a.credentials && Array.isArray(a.sources))) { throw new Error(); }
            return catalog;
        } catch { throw new Error('已保存账号库无法读取，原有数据已保留'); }
    }
    private mutate<T>(change: (catalog: Catalog) => T): Promise<T> {
        const operation = this.pending.then(async () => {
            const catalog = await this.read();
            const result = change(catalog);
            const raw = JSON.stringify(catalog);
            await this.secrets.store(ACCOUNT_LIBRARY_KEY, raw);
            if (await this.secrets.get(ACCOUNT_LIBRARY_KEY) !== raw) { throw new Error('账号保存校验失败，请重试'); }
            this.notify();
            return result;
        });
        this.pending = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async list(backend?: string, baseUrl?: string): Promise<SavedAccount[]> {
        await this.pending;
        return (await this.read()).accounts.filter(a => !backend || (a.backend === backend && a.endpoint === endpoint(baseUrl)))
            .map(publicAccount).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    async credentials(id: string, backend: string, baseUrl?: string): Promise<{ account: SavedAccount; credentials: any }> {
        await this.pending;
        const record = (await this.read()).accounts.find(a => a.id === id && a.backend === backend && a.endpoint === endpoint(baseUrl));
        if (!record) { throw new Error('保存账号不存在或不属于当前平台，请重新选择'); }
        return { account: publicAccount(record), credentials: { ...record.credentials } };
    }
    remember(input: RememberAccount): Promise<SavedAccount | undefined> {
        return this.mutate(catalog => {
            const ignored = ignoredKey(input.backend, input.baseUrl, input.credentials);
            const ignoredId = input.id ? 'id:' + input.id : '';
            const credentials = { ...input.credentials };
            const username = identity(input.username) || identity(credentials.username);
            const ignoredUser = ignoredUsername(input.backend, input.baseUrl, username);
            const ignoredKeys = [ignored, ignoredId, ignoredUser].filter(Boolean);
            if (ignoredKeys.some(key => catalog.ignoredCredentials.includes(key)) && !input.explicit) { return undefined; }
            const scope = catalog.accounts.filter(a => a.backend === input.backend && a.endpoint === endpoint(input.baseUrl));
            let record = input.id ? scope.find(a => a.id === input.id) : undefined;
            if (record?.username && username && record.username !== username) { record = undefined; }
            if (!record && username) { record = scope.find(a => a.username === username); }
            if (!record && !input.id) {
                record = scope.find(a => fingerprint(a.credentials) === fingerprint(credentials)) ||
                    (!username && input.source ? scope.find(a => !a.username && a.sources.includes(input.source!)) : undefined);
            }
            if (!record) {
                record = { id: input.id && /^[a-f0-9]{32}$/.test(input.id) && !catalog.accounts.some(a => a.id === input.id)
                    ? input.id : randomBytes(16).toString('hex'), backend: input.backend, endpoint: endpoint(input.baseUrl),
                    label: input.label?.trim().slice(0, 80) || username || `${input.backend.toUpperCase()} 账号 ${scope.length + 1}`,
                    updatedAt: '', credentials, sources: [] };
                catalog.accounts.push(record);
            }
            // An old workspace or a failed password attempt must not replace a
            // login that has already been verified in another workspace.
            if (!record.verifiedAt || input.verified) { record.credentials = credentials; }
            record.username = username || record.username;
            record.updatedAt = new Date().toISOString();
            if (input.verified) { record.verifiedAt = record.updatedAt; }
            if (input.source && !record.sources.includes(input.source)) { record.sources.push(input.source); }
            if (input.explicit) { catalog.ignoredCredentials = catalog.ignoredCredentials.filter(key => !ignoredKeys.includes(key)); }
            return publicAccount(record);
        });
    }
    rename(id: string, label: string): Promise<void> {
        return this.mutate(catalog => {
            const record = catalog.accounts.find(a => a.id === id);
            if (!record) { throw new Error('保存账号不存在，请刷新后重试'); }
            if (!label.trim()) { throw new Error('请输入账号名称'); }
            record.label = label.trim().slice(0, 80);
        });
    }
    remove(id: string): Promise<void> {
        return this.mutate(catalog => {
            const record = catalog.accounts.find(a => a.id === id);
            if (record) { catalog.ignoredCredentials = Array.from(new Set([...catalog.ignoredCredentials, 'id:' + record.id,
                ignoredKey(record.backend, record.endpoint, record.credentials), ignoredUsername(record.backend, record.endpoint, record.username)].filter(Boolean))); }
            catalog.accounts = catalog.accounts.filter(a => a.id !== id);
        });
    }
}
