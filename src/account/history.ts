import { promises as fs } from 'fs';
import * as path from 'path';
import { SubmissionRecord } from './submissions';
import { writeJson } from './credentials';

export class SubmissionHistory {
    private writing = new Map<string, Promise<void>>();
    async flush(root: string): Promise<void> { await this.writing.get(root); }
    async list(root: string): Promise<SubmissionRecord[]> {
        const file = path.join(root, '.oj-assistant', 'accounts', 'history.json');
        try { const value = JSON.parse(await fs.readFile(file, 'utf8')); return Array.isArray(value) ? value : []; }
        catch (error) { if (error.code === 'ENOENT') { return []; } throw new Error('提交历史文件无法读取，原文件已保留'); }
    }
    save(root: string, record: SubmissionRecord): Promise<void> {
        const writing = (this.writing.get(root) || Promise.resolve()).catch(() => undefined).then(async () => {
            const records = await this.list(root);
            const remaining = records.filter(r => r.localId !== record.localId);
            const dir = path.join(root, '.oj-assistant', 'accounts');
            await fs.mkdir(dir, { recursive: true });
            await writeJson(path.join(dir, 'history.json'), [record, ...remaining].slice(0, 300));
        });
        this.writing.set(root, writing);
        return writing;
    }
}
export const submissionHistory = new SubmissionHistory();
