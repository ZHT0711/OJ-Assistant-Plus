import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialVault } from '../../account/credentials';
import { matchLanguages } from '../../account/language';
import { problemSamples } from '../../account/sampleData';
import { Cancellation, recordOf, SubmissionTracker, WaitStopped } from '../../account/submissions';
import { SubmissionHistory } from '../../account/history';

function cancellation() {
    let listener: (() => void) | undefined;
    const token: Cancellation = { isCancellationRequested: false, onCancellationRequested(callback) { listener = callback; return { dispose() { listener = undefined; } }; } };
    return { token, cancel() { (token as any).isCancellationRequested = true; listener?.(); } };
}
const metadata = { scope: 'one|A', sessionKey: 'one', backend: 'fixture', account: 'test', problemId: 'A', relativeFile: 'A.cpp' };

suite('Account submission lifecycle', () => {
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
