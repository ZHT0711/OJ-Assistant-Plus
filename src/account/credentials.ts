import { promises as fs } from 'fs';
import { createHash, randomBytes } from 'crypto';

export interface Secrets { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; }
const sensitive = /cookie|password|token|secret|authorization|api.?key/i;
function referenceFor(file: string, config: any, credentials: any): string {
    return 'ojassist.account.' + createHash('sha256').update(JSON.stringify([file, config.backend, config.baseUrl || '', credentials.username || ''])).digest('hex');
}
export async function writeJson(file: string, value: any): Promise<void> {
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(() => undefined); }
}

/** Save and verify the secret before removing legacy plaintext credentials. */
export class CredentialVault {
    constructor(private secrets: Secrets) { }
    async read(file: string, migrate = true): Promise<any> {
        const raw = await fs.readFile(file, 'utf8');
        let config: any;
        try { config = JSON.parse(raw); } catch { throw new Error('账号配置 JSON 格式无效，请检查 .ojassistconfig.json'); }
        if (!config || typeof config !== 'object' || Array.isArray(config)) { throw new Error('账号配置应为 JSON 对象'); }
        const reference = referenceFor(file, config, config.credentials || {});
        const stored = await this.secrets.get(reference);
        let saved: any = {};
        try { saved = stored ? JSON.parse(stored) : {}; } catch { throw new Error('凭据存储内容无法读取，请重新登录'); }
        const credentials = Object.assign({}, saved, config.credentials || {});
        if (migrate && Object.keys(config.credentials || {}).some(key => sensitive.test(key))) {
            await this.save(file, config, credentials, raw);
        }
        return { ...config, credentialRef: reference, credentials };
    }
    async save(file: string, config: any, credentials: any, original?: string): Promise<void> {
        const reference = referenceFor(file, config, credentials);
        const secret: any = {}, publicCredentials: any = {};
        for (const key of Object.keys(credentials)) {
            (sensitive.test(key) ? secret : publicCredentials)[key] = credentials[key];
        }
        const value = JSON.stringify(secret);
        await this.secrets.store(reference, value);
        if (await this.secrets.get(reference) !== value) { throw new Error('凭据存储校验失败，原配置未修改'); }
        if (original !== undefined && await fs.readFile(file, 'utf8') !== original) { throw new Error('账号配置已被修改，请重新加载；原文件已保留'); }
        await writeJson(file, { ...config, credentialRef: reference, credentials: publicCredentials });
    }
}

export function safeMessage(error: any, credentials?: any): string {
    let message = String(error?.message || error || '未知错误');
    for (const [key, value] of Object.entries(credentials || {})) {
        if (sensitive.test(key) && typeof value === 'string' && value.length > 2) { message = message.split(value).join('[凭据已隐藏]'); }
    }
    return message.replace(/((?:cookie|password|authorization)\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]');
}
