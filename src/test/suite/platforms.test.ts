import * as assert from 'assert';
import * as path from 'path';
import { adapterFor, platformAdapters } from '../../backend/platforms';

suite('Platform adapter registry', () => {
    test('every platform id and alias resolves to exactly one adapter', () => {
        const registered = new Set<string>();
        for (const adapter of platformAdapters) {
            for (const name of [adapter.id, ...adapter.aliases]) {
                assert.ok(!registered.has(name), `duplicate platform name: ${name}`);
                registered.add(name);
                assert.strictEqual(adapterFor(name), adapter);
                assert.strictEqual(adapterFor(name.toUpperCase()), adapter, 'lookup is case-insensitive');
            }
        }
    });

    test('readable aliases keep the canonical backend id', () => {
        assert.strictEqual(adapterFor('hnu-acm')!.id, 'hnuacm');
        assert.strictEqual(adapterFor('hduoj')!.id, 'hdoj');
        assert.strictEqual(adapterFor('hnu-cg')!.id, 'hnucg');
        assert.strictEqual(adapterFor('unknown-backend'), undefined);
    });

    test('HDOJ owns a browser URL instead of relying on a command switch', () => {
        assert.strictEqual(
            adapterFor('hdoj')!.webUrl({ id: '1000', contestId: undefined }),
            'http://acm.hdu.edu.cn/showproblem.php?pid=1000');
    });

    test('each platform owns its workspace file layout', () => {
        const entry = { id: 'A', title: 'A', contestId: '7' };
        assert.strictEqual(adapterFor('luogu')!.solutionPath(entry, 'cpp'), 'A.cpp');
        assert.strictEqual(adapterFor('codeforces')!.solutionPath(entry, 'py'), 'A.py');
        assert.strictEqual(adapterFor('neuoj')!.solutionPath(entry, 'cpp'), path.join('problems', 'A.cpp'));
        assert.strictEqual(adapterFor('leetcode')!.solutionPath(entry, 'cpp'), path.join('problems', 'A.cpp'));
        assert.strictEqual(adapterFor('csecg')!.solutionPath(entry, 'cpp'), path.join('a', '7', 'A.cpp'));
        assert.strictEqual(adapterFor('hnucg')!.solutionPath({ id: 'B', title: 'B' }, 'py'), path.join('a', '0', 'B.py'));
    });

    test('sample handling is declared per platform', () => {
        assert.strictEqual(adapterFor('luogu')!.sampleHtml, false);
        assert.strictEqual(adapterFor('hnu-cg')!.sampleHtml, false);
        assert.strictEqual(adapterFor('hdoj')!.sampleHtml, true);
        assert.strictEqual(adapterFor('fixture-account')?.sampleHtml, undefined);
    });

    test('contest URLs and problem-index URLs are both derived from the adapter', () => {
        const codeforces = adapterFor('codeforces')!;
        assert.strictEqual(codeforces.webUrl({ id: 'A', contestId: '1900' }), 'https://codeforces.com/problemset/problem/1900/A');
        assert.strictEqual(codeforces.webUrl({ id: '1900B', contestId: undefined }), 'https://codeforces.com/problemset/problem/1900/B');
        assert.strictEqual(adapterFor('csecg')!.webUrl({ id: '12', contestId: '34' }),
            'http://neucsecg.neu.edu.cn/assignment/programList.jsp?proNum=12&assignID=34');
    });
});
