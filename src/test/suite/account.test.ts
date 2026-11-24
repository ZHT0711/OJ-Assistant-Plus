import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialVault } from '../../account/credentials';
import { matchLanguages } from '../../account/language';
import { problemSamples } from '../../account/sampleData';
import { Cancellation, recordOf, submissionAccountKey, SubmissionTracker, WaitStopped } from '../../account/submissions';
import { SubmissionHistory } from '../../account/history';
import { checkSubmissionResponse, SubmissionRejected, submissionRequest } from '../../backend/submissionResponse';

function cancellation() {
    let listener: (() => void) | undefined;
    const token: Cancellation = { isCancellationRequested: false, onCancellationRequested(callback) { listener = callback; return { dispose() { listener = undefined; } }; } };
    return { token, cancel() { (token as any).isCancellationRequested = true; listener?.(); } };
}
const metadata = { scope: 'one|A', sessionKey: 'one', backend: 'fixture', account: 'test', problemId: 'A', relativeFile: 'A.cpp' };

suite('Account submission lifecycle', () => {
    test('explicit cooldown releases the problem lock and blocks other uploads on this account', async () => {
        const tracker = new SubmissionTracker();
        const rateLimitKey = submissionAccountKey('fixture', 'https://judge.test/', 'student');
        const job = tracker.create({ ...metadata, rateLimitKey });
        let uploads = 0;
        const retryAt = Date.now() + 60000;
        await assert.rejects(() => tracker.send(job, async () => { uploads++; throw new SubmissionRejected('cooldown', 'wait', retryAt); }, 100), SubmissionRejected);
        assert.strictEqual(job.state, 'failed'); assert.strictEqual(job.retryAt, retryAt);
        assert.strictEqual(tracker.find(metadata.scope), undefined);
        const next = tracker.create({ ...metadata, scope: 'other-root|B', sessionKey: 'other-root', rateLimitKey });
        await assert.rejects(() => tracker.send(next, async () => { uploads++; return () => undefined; }, 100), /还需等待/);
        assert.strictEqual(uploads, 1); assert.strictEqual(next.state, 'failed');
        const otherAccount = tracker.create({ ...metadata, scope: 'other-account|A', rateLimitKey: submissionAccountKey('fixture', undefined, 'other') });
        await tracker.send(otherAccount, async () => { uploads++; return () => undefined; }, 100);
        assert.strictEqual(uploads, 2);
    });
    test('cooldown history survives restart and expires without automatically resending code', async () => {
        const tracker = new SubmissionTracker();
        const record = { ...recordOf(tracker.create(metadata)), state: 'failed' as const, restriction: 'cooldown' as const, retryAt: Date.now() + 60000 };
        const restarted = new SubmissionTracker(); restarted.restore([record]);
        const blocked = restarted.create(metadata); let uploads = 0;
        await assert.rejects(() => restarted.send(blocked, async () => { uploads++; return () => undefined; }, 100), SubmissionRejected);
        assert.strictEqual(uploads, 0);
        for (const job of restarted.jobs.values()) { job.retryAt = Date.now() - 1; }
        const allowed = restarted.create(metadata);
        await restarted.send(allowed, async () => { uploads++; return () => undefined; }, 100);
        assert.strictEqual(uploads, 1);
    });
    test('captcha rejection is retryable while network failures remain uncertain', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        await assert.rejects(() => tracker.send(job, async () => { throw new SubmissionRejected('captcha', '验证'); }, 100), SubmissionRejected);
        assert.strictEqual(job.state, 'failed'); assert.strictEqual(job.restriction, 'captcha');
        const retry = tracker.create(metadata);
        await assert.rejects(() => tracker.send(retry, async () => { throw new Error('connection lost'); }, 100));
        assert.strictEqual(retry.state, 'unknown'); assert.throws(() => tracker.create(metadata));
    });
    test('a late explicit rejection replaces uncertain upload state with a persisted restriction', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let reject!: (error: Error) => void;
        await assert.rejects(() => tracker.send(job, () => new Promise((_, failure) => { reject = failure; }), 5), WaitStopped);
        assert.strictEqual(job.state, 'unknown');
        reject(new SubmissionRejected('cooldown', 'wait', Date.now() + 60000));
        await assert.rejects(() => job.upload!, SubmissionRejected);
        assert.strictEqual(job.state, 'failed'); assert.strictEqual(recordOf(job).restriction, 'cooldown');
    });
    test('one account cannot upload different problems concurrently, including a timed-out upload', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let finish!: (resolver: Function) => void;
        await assert.rejects(() => tracker.send(job, () => new Promise(resolve => { finish = resolve; }), 5), WaitStopped);
        const next = tracker.create({ ...metadata, scope: 'one|B', problemId: 'B' });
        let uploads = 0;
        await assert.rejects(() => tracker.send(next, async () => { uploads++; return () => undefined; }, 100), /正在上传/);
        finish(() => undefined); await job.upload;
        await tracker.send(tracker.create({ ...metadata, scope: 'one|B', problemId: 'B' }), async () => { uploads++; return () => undefined; }, 100);
        assert.strictEqual(uploads, 1);
    });
    test('restored unfinished records retain duplicate protection with recoverable states', () => {
        const tracker = new SubmissionTracker(); const record = recordOf(tracker.create(metadata));
        const restored = new SubmissionTracker(); restored.restore([{ ...record, state: 'uploading' }]);
        assert.strictEqual(restored.find(metadata.scope)!.state, 'unknown');
        assert.throws(() => restored.create(metadata));
    });
    test('uploads once, rejects duplicate reservations and polls pending verdicts', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let uploads = 0, queries = 0;
        await tracker.send(job, async () => { uploads++; return Object.assign(async () => ({ result: ++queries === 1 ? 'Pending...' : 'Accepted' }), { submissionId: '42' }); }, 100);
        assert.throws(() => tracker.create(metadata), /已有/);
        const result = await tracker.poll(job, { timeout: 200, requestTimeout: 100, interval: 1 });
        assert.strictEqual(result.result, 'Accepted'); assert.strictEqual(uploads, 1); assert.strictEqual(job.recordId, '42');
        assert.strictEqual(tracker.find(metadata.scope), undefined);
    });
    test('query failure retries queries without reposting code', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let uploads = 0, queries = 0;
        await tracker.send(job, async () => { uploads++; return async () => { if (++queries < 3) { throw new Error('network'); } return { result: 'Accepted' }; }; }, 100);
        await tracker.poll(job, { timeout: 300, requestTimeout: 100, interval: 1 });
        assert.strictEqual(uploads, 1); assert.strictEqual(queries, 3);
    });
    test('cancelled polling can resume the same record without another upload', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let uploads = 0, accepted = false;
        await tracker.send(job, async () => { uploads++; return async () => ({ result: accepted ? 'Accepted' : 'Judging...' }); }, 100);
        const source = cancellation(); const timer = setTimeout(() => source.cancel(), 10);
        await assert.rejects(() => tracker.poll(job, { timeout: 500, requestTimeout: 100, interval: 100, token: source.token }), error => error instanceof WaitStopped && error.reason === 'cancelled');
        clearTimeout(timer); assert.strictEqual(job.state, 'paused');
        accepted = true;
        await tracker.poll(job, { timeout: 100, requestTimeout: 50, interval: 1 });
        assert.strictEqual(uploads, 1); assert.strictEqual(job.state, 'completed');
    });
    test('a query watchdog keeps the pending request for safe resume', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let queries = 0, finish!: (value: any) => void;
        await tracker.send(job, async () => () => { queries++; return new Promise(resolve => { finish = resolve; }); }, 100);
        await assert.rejects(() => tracker.poll(job, { timeout: 20, requestTimeout: 15, interval: 1 }), WaitStopped);
        finish({ result: 'Accepted' });
        await tracker.poll(job, { timeout: 100, requestTimeout: 50, interval: 1 });
        assert.strictEqual(queries, 1);
    });
    test('late upload acknowledgement preserves the lock and becomes resumable', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let finish!: (value: Function) => void, uploads = 0;
        await assert.rejects(() => tracker.send(job, () => { uploads++; return new Promise(resolve => { finish = resolve; }); }, 10), WaitStopped);
        assert.strictEqual(job.state, 'unknown'); assert.throws(() => tracker.create(metadata));
        finish(Object.assign(async () => ({ result: 'Accepted' }), { submissionId: '99' }));
        await job.upload;
        assert.strictEqual(job.state, 'paused'); assert.strictEqual(job.recordId, '99');
        await tracker.poll(job, { timeout: 100, requestTimeout: 50, interval: 1 });
        assert.strictEqual(uploads, 1);
    });
    test('cancelling before upload sends no code', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata); const source = cancellation(); source.cancel(); let uploads = 0;
        await assert.rejects(() => tracker.send(job, async () => { uploads++; return () => undefined; }, 100, source.token), WaitStopped);
        assert.strictEqual(uploads, 0); assert.strictEqual(job.state, 'failed');
    });
    test('a deliberately superseded upload is not revived by a late acknowledgement', async () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        let finish!: (value: Function) => void;
        await assert.rejects(() => tracker.send(job, () => new Promise(resolve => { finish = resolve; }), 5), WaitStopped);
        job.state = 'failed';
        const replacement = tracker.create(metadata);
        await tracker.send(replacement, async () => async () => ({ result: 'Accepted' }), 100);
        finish(async () => ({ result: 'Accepted' })); await job.upload;
        assert.strictEqual(job.state, 'failed'); assert.strictEqual(tracker.find(metadata.scope), replacement);
    });
    test('records exclude runtime functions and separate identical IDs across sessions', () => {
        const tracker = new SubmissionTracker(); const job = tracker.create(metadata);
        job.resolver = async () => ({ result: 'Accepted' });
        tracker.create({ ...metadata, sessionKey: 'two', scope: 'two|A' });
        assert.ok(!JSON.stringify(recordOf(job)).includes('resolver')); assert.strictEqual(tracker.jobs.size, 2);
    });
});

suite('Platform submission restrictions', () => {
    const now = 1700000000000;
    test('parses Retry-After seconds, dates, JSON durations and localized messages', () => {
        const cases = [
            { response: { status: 429, headers: { 'retry-after': '12' } }, seconds: 12 },
            { response: { status: 429, headers: { 'Retry-After': new Date(now + 15000).toUTCString() } }, seconds: 15 },
            { response: { status: 429, data: { retry_after: 7 } }, seconds: 7 },
            { response: { status: 200, data: { error: '提交过于频繁，请在 2 分钟后重试' } }, seconds: 120 },
            { response: { status: 200, data: { detail: 'Please wait 5 seconds before submitting again.' } }, seconds: 5 },
            { response: { status: 429, headers: { 'retry-after': 'invalid' } }, seconds: 60 },
            { response: { status: 429, headers: { 'retry-after': '0' } }, seconds: 0 },
        ];
        for (const { response, seconds } of cases) {
            assert.throws(() => checkSubmissionResponse(response, now), error => error instanceof SubmissionRejected && error.kind === 'cooldown' && error.retryAt === now + seconds * 1000);
        }
    });
    test('recognizes JSON validation errors, HTML captcha forms, WAF pages and script alerts', () => {
        for (const data of [
            { errors: { captcha: ['验证码错误'] } }, { captcha_required: true },
            '<form><input name="captchaCode"></form>', '<div class="g-recaptcha"></div>',
            '<html><script src="/cdn-cgi/challenge-platform/challenge.js"></script></html>',
            '<script>alert("验证码错误，请重试");</script>',
        ]) {
            assert.throws(() => checkSubmissionResponse({ status: 200, data }), error => error instanceof SubmissionRejected && error.kind === 'captcha');
        }
        assert.throws(() => checkSubmissionResponse({ status: 200, data: '<p>You have submitted the same code before.</p>' }), error => error instanceof SubmissionRejected && error.kind === 'duplicate');
    });
    test('does not confuse source code, optional disabled captcha inputs or successful responses with a challenge', () => {
        for (const data of [
            { submission_id: 42 }, { rid: 42, code: 'captcha too many requests' },
            '<form><textarea name="source">captcha too many requests</textarea><input disabled name="captcha"></form>',
            '<pre>验证码</pre><script>const captcha = false;</script><p>Submitted</p>',
        ]) { assert.doesNotThrow(() => checkSubmissionResponse({ status: 200, data })); }
    });
    test('handles binary responses and Axios HTTP rejections without hiding network errors', async () => {
        assert.throws(() => checkSubmissionResponse({ data: Buffer.from('验证码错误'), headers: { 'content-type': 'text/html; charset=utf-8' } }), SubmissionRejected);
        await assert.rejects(() => submissionRequest(Promise.reject({ response: { status: 429, headers: { 'retry-after': 10 } } })), SubmissionRejected);
        await assert.rejects(() => submissionRequest(Promise.resolve({ status: 403, data: { error: 'CAPTCHA_REQUIRED' } })), SubmissionRejected);
        const network = new Error('socket closed');
        await assert.rejects(() => submissionRequest(Promise.reject(network)), error => error === network);
        assert.strictEqual((await submissionRequest(Promise.resolve({ data: { submission_id: 42 } }))).data.submission_id, 42);
    });
});

suite('Account language matching', () => {
    const available = [{ value: 54, label: 'CPP (54)' }, { value: 43, label: 'C (43)' }, { value: 31, label: 'Python3' }, { value: 'javascript', label: 'JavaScript' }, { value: 60, label: 'Java17' }, { value: 9, label: 'C#' }];
    test('a previous C++ choice never overrides Python or C files', () => {
        assert.strictEqual(matchLanguages('py', available, undefined, available[0]).selected!.value, 31);
        assert.strictEqual(matchLanguages('c', available, undefined, available[0]).selected!.value, 43);
        assert.strictEqual(matchLanguages('cc', available).selected!.value, 54);
    });
    test('JavaScript and C# remain distinct from Java and C', () => {
        assert.strictEqual(matchLanguages('js', available).selected!.value, 'javascript');
        assert.strictEqual(matchLanguages('cs', available).selected!.value, 9);
        assert.strictEqual(matchLanguages('java', available).selected!.value, 60);
    });
    test('an unrelated remembered compiler is filtered out', () => {
        const result = matchLanguages('cpp', [...available, { value: 73, label: 'GNU G++20' }], available[2]);
        assert.strictEqual(result.choices.length, 2); assert.strictEqual(result.selected, undefined);
    });
    test('legacy platform abbreviations match Python, JavaScript and C#', () => {
        const old = [{ value: 31, label: 'PY (31)' }, { value: 55, label: 'JS (55)' }, { value: 9, label: 'CS (9)' }];
        assert.strictEqual(matchLanguages('py', old).selected!.value, 31);
        assert.strictEqual(matchLanguages('js', old).selected!.value, 55);
        assert.strictEqual(matchLanguages('cs', old).selected!.value, 9);
    });
});

suite('Credential migration and submission history', () => {
    let root: string;
    setup(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oj-account-test-')); });
    teardown(async () => { await fs.rmdir(root, { recursive: true }); });
    test('migrates and verifies credentials while keeping public account settings', async () => {
        const file = path.join(root, 'config.json'); const values = new Map<string, string>();
        const vault = new CredentialVault({ get: async key => values.get(key), store: async (key, value) => { values.set(key, value); } });
        await fs.writeFile(file, JSON.stringify({ backend: 'fixture', credentials: { username: 'student', cookies: 'fixture-cookie', password: 'fixture-password' }, preferredLanguage: 54 }));
        const hydrated = await vault.read(file);
        assert.strictEqual(hydrated.credentials.cookies, 'fixture-cookie');
        const raw = await fs.readFile(file, 'utf8'); assert.ok(!raw.includes('fixture-cookie')); assert.ok(!raw.includes('fixture-password')); assert.ok(raw.includes('student'));
        assert.strictEqual((await vault.read(file)).credentials.password, 'fixture-password');
        const copy = path.join(root, 'copy.json'); await fs.writeFile(copy, raw);
        assert.strictEqual((await vault.read(copy)).credentials.cookies, undefined, 'copied references cannot read another workspace secret');
    });
    test('a failed secret write leaves the legacy configuration untouched', async () => {
        const file = path.join(root, 'config.json'); const raw = '{"backend":"fixture","credentials":{"cookies":"fixture-cookie"}}'; await fs.writeFile(file, raw);
        const vault = new CredentialVault({ get: async () => undefined, store: async () => { throw new Error('locked'); } });
        await assert.rejects(() => vault.read(file), /locked/); assert.strictEqual(await fs.readFile(file, 'utf8'), raw);
    });
    test('concurrent configuration edits are preserved during migration', async () => {
        const file = path.join(root, 'config.json'); const raw = '{"backend":"fixture","credentials":{"cookies":"fixture-cookie"}}'; await fs.writeFile(file, raw);
        let saved: string | undefined;
        const vault = new CredentialVault({ get: async () => saved, store: async (_, value) => { saved = value; await fs.writeFile(file, '{"externalEdit":true}'); } });
        await assert.rejects(() => vault.read(file), /已被修改/); assert.strictEqual(await fs.readFile(file, 'utf8'), '{"externalEdit":true}');
    });
    test('parallel history updates preserve all records and corrupt history is not overwritten', async () => {
        const history = new SubmissionHistory(); const tracker = new SubmissionTracker();
        const first = recordOf(tracker.create(metadata)); const second = recordOf(tracker.create({ ...metadata, scope: 'two' }));
        await Promise.all([history.save(root, first), history.save(root, second)]);
        assert.strictEqual((await history.list(root)).length, 2);
        const file = path.join(root, '.oj-assistant', 'accounts', 'history.json'); await fs.writeFile(file, '{bad');
        await assert.rejects(() => history.save(root, first), /无法读取/); assert.strictEqual(await fs.readFile(file, 'utf8'), '{bad');
    });
    test('old CSECG records are reinterpreted without rewriting or uploading', async () => {
        const history = new SubmissionHistory();
        const record = { ...recordOf(new SubmissionTracker().create(metadata)), backend: 'csecg',
            verdict: { result: '评测结果未识别', details: '共有测试数据:1\n测试数据1完全正确\nwarning: &apos;count&apos;' } };
        await history.save(root, record);
        const file = path.join(root, '.oj-assistant', 'accounts', 'history.json');
        const before = await fs.readFile(file, 'utf8');
        const [loaded] = await history.list(root);
        assert.strictEqual(loaded.verdict!.result, 'Accepted');
        assert.ok(loaded.verdict!.details!.includes("'count'"));
        assert.strictEqual(await fs.readFile(file, 'utf8'), before);
    });
});

suite('Account samples', () => {
    test('HTML line breaks and entities become executable sample text', () => {
        const tests = problemSamples('codeforces', { sampleInput: ['<pre><div>1 2</div><div>&lt;3&gt;</div></pre>'], sampleOutput: ['3<br>4'] });
        assert.deepStrictEqual(tests, [{ input: '1 2\n<3>', output: '3\n4' }]);
    });
    test('plain-text adapter samples preserve literal markup', () => {
        assert.deepStrictEqual(problemSamples('luogu', { sampleInput: ['<node>\n'], sampleOutput: ['&literal;\n'] }), [{ input: '<node>\n', output: '&literal;\n' }]);
    });
});
