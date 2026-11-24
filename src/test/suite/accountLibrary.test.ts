import * as assert from 'assert';
import { ACCOUNT_LIBRARY_KEY, SavedAccountLibrary } from '../../account/library';

suite('Saved platform accounts', () => {
    let values: Map<string, string>;
    let library: SavedAccountLibrary;
    setup(() => {
        values = new Map();
        library = new SavedAccountLibrary({ get: async key => values.get(key), store: async (key, value) => { values.set(key, value); } });
    });
    test('persists credentials across restarts and only exposes safe account metadata', async () => {
        const account = (await library.remember({ backend: 'hdoj', credentials: { username: 'student', password: 'private-password', cookies: 'private-cookie' }, verified: true }))!;
        const listed = JSON.stringify(await library.list());
        assert.ok(!/private-password|private-cookie|credentials|password|cookies/.test(listed));
        assert.ok(account.verifiedAt);
        const restarted = new SavedAccountLibrary({ get: async key => values.get(key), store: async (key, value) => { values.set(key, value); } });
        assert.strictEqual((await restarted.credentials(account.id, 'hdoj')).credentials.cookies, 'private-cookie');
        assert.strictEqual(values.size, 1);
        assert.ok(values.has(ACCOUNT_LIBRARY_KEY));
    });
    test('keeps platforms and custom endpoints isolated', async () => {
        const account = (await library.remember({ backend: 'csecg', baseUrl: 'https://school.example/cg/', credentials: { cookies: 'test-cookie' } }))!;
        await assert.rejects(() => library.credentials(account.id, 'hdoj', 'https://school.example/cg'), /不属于/);
        await assert.rejects(() => library.credentials(account.id, 'csecg', 'https://other.example/cg'), /不属于/);
        await assert.rejects(() => library.credentials(account.id, 'csecg', 'https://school.example/other'), /不属于/);
        assert.strictEqual((await library.credentials(account.id, 'csecg', 'https://school.example/cg')).credentials.cookies, 'test-cookie');
    });
    test('refreshes the same username while preserving multiple accounts', async () => {
        const first = (await library.remember({ backend: 'hdoj', credentials: { username: 'one', cookies: 'old' } }))!;
        const refreshed = (await library.remember({ backend: 'hdoj', credentials: { username: 'one', cookies: 'new' }, verified: true }))!;
        await library.remember({ backend: 'hdoj', credentials: { username: 'two', cookies: 'other' } });
        assert.strictEqual(first.id, refreshed.id);
        assert.strictEqual((await library.list('hdoj')).length, 2);
        assert.strictEqual((await library.credentials(first.id, 'hdoj')).credentials.cookies, 'new');
    });
    test('supports multiple unnamed browser accounts and refreshes a selected one', async () => {
        const first = (await library.remember({ backend: 'csecg', credentials: { cookies: 'one' }, source: '/workspace', username: '(session)' }))!;
        const second = (await library.remember({ backend: 'csecg', credentials: { cookies: 'two' }, source: '/workspace', id: 'a'.repeat(32), label: '小号', explicit: true }))!;
        const refreshed = (await library.remember({ backend: 'csecg', credentials: { cookies: 'three' }, source: '/workspace', id: second.id }))!;
        assert.notStrictEqual(first.id, second.id);
        assert.strictEqual(refreshed.id, second.id);
        assert.strictEqual(refreshed.label, '小号');
        assert.strictEqual((await library.list()).length, 2);
    });
    test('recognizing a different username never overwrites the previous account', async () => {
        const first = (await library.remember({ backend: 'hdoj', credentials: { username: 'one', cookies: 'one-cookie' } }))!;
        const second = (await library.remember({ backend: 'hdoj', id: first.id, credentials: { username: 'two', cookies: 'two-cookie' }, username: 'two' }))!;
        assert.notStrictEqual(first.id, second.id);
        assert.strictEqual((await library.credentials(first.id, 'hdoj')).credentials.username, 'one');
    });
    test('rename survives automatic imports and remove does not immediately reimport', async () => {
        const input = { backend: 'hdoj', credentials: { cookies: 'saved-cookie' }, source: '/workspace' };
        const account = (await library.remember(input))!;
        await library.rename(account.id, '我的杭电账号');
        await library.remember({ ...input, id: account.id, label: 'old label' });
        assert.strictEqual((await library.list())[0].label, '我的杭电账号');
        await library.remove(account.id);
        assert.strictEqual(await library.remember(input), undefined);
        assert.strictEqual((await library.list()).length, 0);
        await library.remember({ ...input, explicit: true });
        assert.strictEqual((await library.list()).length, 1);
    });
    test('serializes concurrent saves without losing accounts', async () => {
        await Promise.all(['one', 'two', 'three'].map(username => library.remember({ backend: 'hdoj', credentials: { username, cookies: username } })));
        assert.strictEqual((await library.list()).length, 3);
    });
    test('forgetting one account does not suppress other accounts used in the same folder', async () => {
        const first = (await library.remember({ backend: 'hdoj', source: '/workspace', credentials: { username: 'one', cookies: 'one-cookie' } }))!;
        const second = (await library.remember({ backend: 'hdoj', source: '/workspace', credentials: { username: 'two', cookies: 'two-cookie' } }))!;
        await library.remove(first.id);
        const refreshed = await library.remember({ backend: 'hdoj', source: '/workspace', id: second.id, credentials: { username: 'two', cookies: 'two-refreshed' } });
        assert.strictEqual(refreshed!.id, second.id);
        assert.strictEqual((await library.list()).length, 1);
    });
    test('older workspace copies do not resurrect a removed account', async () => {
        const account = (await library.remember({ backend: 'hdoj', credentials: { cookies: 'older-cookie' } }))!;
        await library.remember({ backend: 'hdoj', id: account.id, credentials: { cookies: 'new-cookie' } });
        await library.remove(account.id);
        assert.strictEqual(await library.remember({ backend: 'hdoj', id: account.id, credentials: { cookies: 'older-cookie' } }), undefined);
        assert.strictEqual((await library.list()).length, 0);
    });
    test('old cookies and unverified passwords cannot replace a verified login', async () => {
        const account = (await library.remember({ backend: 'hdoj', credentials: { username: 'student', cookies: 'working' }, verified: true }))!;
        await library.remember({ backend: 'hdoj', credentials: { username: 'student', cookies: 'expired' } });
        await library.remember({ backend: 'hdoj', credentials: { username: 'student', password: 'wrong-password' }, explicit: true });
        assert.strictEqual((await library.credentials(account.id, 'hdoj')).credentials.cookies, 'working');
        await library.remember({ backend: 'hdoj', credentials: { username: 'student', cookies: 'refreshed' }, verified: true });
        assert.strictEqual((await library.credentials(account.id, 'hdoj')).credentials.cookies, 'refreshed');
    });
    test('a removed named account stays forgotten when another folder has older cookies', async () => {
        const account = (await library.remember({ backend: 'hdoj', credentials: { username: 'student', cookies: 'current' } }))!;
        await library.remove(account.id);
        assert.strictEqual(await library.remember({ backend: 'hdoj', credentials: { username: 'student', cookies: 'older' } }), undefined);
    });
    test('rejects corrupted catalogs without overwriting them', async () => {
        values.set(ACCOUNT_LIBRARY_KEY, '{bad');
        await assert.rejects(() => library.remember({ backend: 'hdoj', credentials: { cookies: 'one' } }), /无法读取/);
        assert.strictEqual(values.get(ACCOUNT_LIBRARY_KEY), '{bad');
    });
    test('failed writes preserve saved accounts and do not report success', async () => {
        const account = (await library.remember({ backend: 'hdoj', credentials: { cookies: 'original' } }))!;
        const before = values.get(ACCOUNT_LIBRARY_KEY);
        const locked = new SavedAccountLibrary({ get: async key => values.get(key), store: async () => { throw new Error('locked'); } });
        await assert.rejects(() => locked.rename(account.id, 'new name'), /locked/);
        assert.strictEqual(values.get(ACCOUNT_LIBRARY_KEY), before);
    });
});
