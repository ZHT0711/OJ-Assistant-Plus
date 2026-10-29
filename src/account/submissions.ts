import { randomBytes } from 'crypto';

export interface Cancellation {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}
export class WaitStopped extends Error {
    constructor(public reason: 'cancelled' | 'timeout') { super(reason === 'cancelled' ? '已停止等待' : '查询超过等待时限'); }
}
export function bounded<T>(operation: PromiseLike<T>, timeout: number, token?: Cancellation): Promise<T> {
    return new Promise((resolve, reject) => {
        let done = false;
        let subscription: { dispose(): void } | undefined;
        const finish = (callback: () => void) => { if (done) { return; } done = true; clearTimeout(timer); subscription?.dispose(); callback(); };
        const timer = setTimeout(() => finish(() => reject(new WaitStopped('timeout'))), Math.max(1, timeout));
        subscription = token?.onCancellationRequested(() => finish(() => reject(new WaitStopped('cancelled'))));
        Promise.resolve(operation).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        if (token?.isCancellationRequested) { finish(() => reject(new WaitStopped('cancelled'))); }
    });
}
export interface Verdict { id?: number; result: string; time?: string; memory?: string; details?: string; }
export type JobState = 'preparing' | 'uploading' | 'waiting' | 'paused' | 'unknown' | 'completed' | 'failed';
export interface SubmissionRecord {
    localId: string;
    scope: string;
    sessionKey: string;
    backend: string;
    account: string;
    problemId: string;
    contestId?: string;
    relativeFile: string;
    createdAt: string;
    state: JobState;
    language?: string | number;
    recordId?: string;
    verdict?: Verdict;
    message?: string;
}
export interface SubmissionJob extends SubmissionRecord {
    resolver?: () => PromiseLike<Verdict> | Verdict;
    upload?: Promise<Function>;
    query?: Promise<Verdict>;
}
export function isPending(result: string): boolean {
    return /^(?:pending|judging|queu(?:ing|ed)|running|waiting|compiling|评测中|等待|排队)/i.test(result.trim());
}
export function recordOf(job: SubmissionJob): SubmissionRecord {
    const { resolver, upload, query, ...record } = job;
    return JSON.parse(JSON.stringify(record));
}
export class SubmissionTracker {
    readonly jobs = new Map<string, SubmissionJob>();
    private polling = new Set<string>();
    find(scope: string): SubmissionJob | undefined {
        return Array.from(this.jobs.values()).find(job => job.scope === scope && !['completed', 'failed'].includes(job.state));
    }
    create(metadata: Omit<SubmissionRecord, 'localId' | 'createdAt' | 'state'>): SubmissionJob {
        if (this.find(metadata.scope)) { throw new Error('这道题已有未结束的提交，请先继续查询或确认历史记录'); }
        const job: SubmissionJob = { ...metadata, localId: randomBytes(10).toString('hex'), createdAt: new Date().toISOString(), state: 'preparing' };
        this.jobs.set(job.localId, job);
        return job;
    }
    async send(job: SubmissionJob, submit: () => Promise<Function>, timeout: number, token?: Cancellation, changed: () => void = () => undefined): Promise<void> {
        if (job.state !== 'preparing' || job.upload) { throw new Error('这次提交已发起，不能重复上传'); }
        if (token?.isCancellationRequested) { job.state = 'failed'; changed(); throw new WaitStopped('cancelled'); }
        job.state = 'uploading'; changed();
        job.upload = Promise.resolve().then(submit).then(resolver => {
            job.resolver = resolver as any;
            job.recordId = (resolver as any).submissionId?.toString();
            if (job.state !== 'failed') { job.state = job.state === 'uploading' ? 'waiting' : 'paused'; }
            changed();
            return resolver;
        }, error => { if (job.state !== 'failed') { job.state = 'unknown'; job.message = '上传结果尚未确认，请查看原站记录后再决定是否重新提交'; } changed(); throw error; });
        try { await bounded(job.upload, timeout, token); }
        catch (error) { if (!job.resolver) { job.state = 'unknown'; } changed(); throw error; }
    }
    async poll(job: SubmissionJob, options: { timeout: number; requestTimeout: number; interval: number; token?: Cancellation; onChange?: (job: SubmissionJob) => void }): Promise<Verdict> {
        if (!job.resolver) { throw new Error('提交尚无可查询凭据，请先查看原站提交记录'); }
        if (this.polling.has(job.localId)) { throw new Error('该提交正在查询中'); }
        this.polling.add(job.localId);
        const deadline = Date.now() + options.timeout;
        const changed = () => options.onChange?.(job);
        job.state = 'waiting'; job.message = undefined; changed();
        let errors = 0;
        try {
            while (Date.now() < deadline) {
                if (options.token?.isCancellationRequested) { throw new WaitStopped('cancelled'); }
                if (!job.query) { job.query = Promise.resolve().then(() => job.resolver!()); }
                try {
                    const query = job.query;
                    const verdict = await bounded(query, Math.min(options.requestTimeout, deadline - Date.now()), options.token);
                    job.query = undefined;
                    if (!verdict || typeof verdict.result !== 'string') { throw new Error('平台返回的评测数据无效'); }
                    job.verdict = verdict; errors = 0;
                    if (!isPending(verdict.result)) { job.state = 'completed'; changed(); return verdict; }
                    changed();
                } catch (error) {
                    // A request that timed out locally may still be running. Reuse its promise on resume.
                    if (!(error instanceof WaitStopped)) { job.query = undefined; }
                    if (error instanceof WaitStopped || ++errors >= 3) { throw error; }
                }
                await bounded(new Promise<void>(resolve => setTimeout(resolve, options.interval * Math.max(1, errors))), Math.max(1, deadline - Date.now()), options.token);
            }
            throw new WaitStopped('timeout');
        } catch (error) { job.state = 'paused'; job.message = error instanceof WaitStopped ? error.message : '获取评测暂时失败，可继续查询'; changed(); throw error; }
        finally { this.polling.delete(job.localId); }
    }
}
