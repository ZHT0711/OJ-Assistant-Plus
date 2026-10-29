import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { identify, parseHtml, parseLuogu, parseManual, sanitizeHtml } from '../../practice/problem';
import { isPracticeSource, listProblems, problemDir, readPractice, removeProblem, saveProblem } from '../../practice/store';
import { execute, normalizeOutput, runSamples } from '../../practice/runner';

suite('Link practice parsers', () => {
    test('Codeforces aliases share one cache identity and handle A1', () => {
        assert.deepStrictEqual(identify('https://codeforces.com/problemset/problem/123/A1?locale=en'), identify('codeforces.com/contest/123/problem/a1/'));
        assert.strictEqual(identify('https://codeforces.com/gym/100001').collection, true);
        assert.ok(identify('https://codeforces.com/gym/100001/problem/A').submitUrl.includes('/gym/'));
    });
    test('AtCoder contest/tasks aliases share identity', () => {
        assert.deepStrictEqual(identify('https://atcoder.jp/contests/abc001'), identify('https://atcoder.jp/contests/abc001/tasks/'));
        assert.strictEqual(identify('https://atcoder.jp/contests/abc001/tasks/abc001_1').collection, false);
    });
    test('Luogu legacy hosts and case normalize', () => {
        assert.deepStrictEqual(identify('https://luogu.org/problem/p1001'), identify('https://www.luogu.com.cn/problem/P1001#submit'));
        assert.strictEqual(identify('https://www.luogu.com.cn/contest/123').collection, true);
    });
    test('rejects unsupported schemes and credentials', () => {
        for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'https://user:password@example.com/p']) { assert.throws(() => identify(url)); }
    });
    test('does not treat lookalike domains as platform adapters', () => {
        assert.strictEqual(identify('https://codeforces.com.example.org/contest/123').platform, 'codeforces.com.example.org');
    });
    test('CF multiline div samples retain line breaks and literal markup', () => {
        const p = parseHtml(identify('https://codeforces.com/contest/1/problem/A'), '<div class="problem-statement"><div class="title">A. Test</div><p>Sum</p><div class="sample-test"><div class="input"><pre><div>1 2</div><div>&lt;3&gt;</div></pre></div><div class="output"><pre>3<br>4</pre></div></div></div>');
        assert.deepStrictEqual(p.samples, [{ input: '1 2\n<3>', output: '3\n4' }]);
    });
    test('AtCoder chooses English once and preserves math', () => {
        const section = '<section><h3>Sample Input 1</h3><pre>1 2\n</pre></section><section><h3>Sample Output 1</h3><pre>3\n</pre></section>';
        const p = parseHtml(identify('https://atcoder.jp/contests/abc001/tasks/abc001_1'), `<span class="h2">A - Test<span>Time</span></span><div id="task-statement"><span class="lang-ja">日本語</span><span class="lang-en"><p><var>x</var></p>${section}</span></div>`);
        assert.strictEqual(p.title, 'A - Test'); assert.strictEqual(p.samples.length, 1);
        assert.ok(!p.statement.includes('日本語')); assert.ok(p.statement.includes('\\(x\\)'));
    });
    test('Luogu accepts content-only JSON and lentille HTML', () => {
        const raw = { data: { problem: { name: 'A+B', content: { description: '求 **和**', formatI: 'a b' }, samples: [['1 2', '3']] } } };
        const target = identify('https://www.luogu.com.cn/problem/P1001');
        const p = parseLuogu(target, raw);
        assert.strictEqual(p.samples[0].output, '3'); assert.ok(p.statement.includes('<strong>和</strong>'));
        assert.deepStrictEqual(parseLuogu(target, `<script id="lentille-context" type="application/json">${JSON.stringify(raw)}</script>`), p);
    });
    test('AtCoder legacy headings with nested sample sections', () => {
        const p = parseHtml(identify('https://atcoder.jp/contests/abc001/tasks/abc001_1'), '<title>Old task</title><div id="task-statement"><div><h3>入力例 1</h3><section><pre>15\n10\n</pre></section></div><div><h3>出力例 1</h3><section><pre>5\n</pre></section></div></div>');
        assert.deepStrictEqual(p.samples, [{ input: '15\n10', output: '5' }]);
    });
    test('HDU samples are decoded into test pairs', () => {
        const p = parseHtml(identify('http://acm.hdu.edu.cn/showproblem.php?pid=1000'), '<h1>A + B</h1>' + ['Sum', 'a b', 'sum', '1 2<br>3 4', '3<br>7'].map(x => `<div class="panel_content">${x}</div>`).join(''));
        assert.deepStrictEqual(p.samples, [{ input: '1 2\n3 4', output: '3\n7' }]);
    });
    test('fails visibly on login/challenge pages', () => {
        assert.throws(() => parseHtml(identify('https://example.com/p'), '<html><h1>Sign in</h1></html>'), /公开题面/);
        assert.throws(() => parseLuogu(identify('https://www.luogu.com.cn/problem/P1001'), '<h1>Verify</h1>'), /验证/);
    });
    test('removes script execution and resolves safe relative assets', () => {
        const html = sanitizeHtml('<script>alert(1)</script><img src="/image.png" onerror="bad()"><a href="javascript:bad()">bad</a><iframe src="x"></iframe><p style="position:fixed">ok</p>', 'https://example.com/p/1');
        assert.ok(html.includes('https://example.com/image.png'));
        for (const s of ['script', 'onerror', 'javascript:', 'iframe', 'style=']) { assert.ok(!html.includes(s)); }
    });
    test('manual JSON imports arbitrary platforms without inventing samples', () => {
        const p = parseManual({ url: 'https://school.example/p/1', name: 'School', tests: [] });
        assert.strictEqual(p.samples.length, 0); assert.strictEqual(p.platform, 'school.example');
        assert.throws(() => parseManual({ url: p.url, name: 'bad', tests: [{ input: 1, output: '' }] }), /input\/output/);
    });
});

suite('Link practice storage', () => {
    let root: string;
    setup(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oj-practice-test-')); });
    teardown(async () => { await fs.rmdir(root, { recursive: true }); });
    test('duplicate import preserves code and customized tests', async () => {
        const p = parseManual({ url: 'https://example.com/problem/1', name: 'One', tests: [{ input: '1', output: '2' }] });
        assert.strictEqual(await saveProblem(root, p), true);
        const source = path.join(problemDir(root, p.key), 'main.cpp');
        await fs.writeFile(source, 'my solution');
        assert.strictEqual(await saveProblem(root, { ...p, samples: [] }), false);
        assert.strictEqual(readPractice(root, source)!.samples.length, 1);
        assert.strictEqual(await fs.readFile(source, 'utf8'), 'my solution');
        assert.strictEqual((await listProblems(root)).length, 1);
        await removeProblem(root, p.key);
        assert.strictEqual((await listProblems(root)).length, 0);
        await saveProblem(root, { ...p, samples: [] });
        assert.strictEqual((await listProblems(root))[0].samples.length, 1, 'reimport restores custom tests after removal');
    });
    test('atomic test updates and corrupt manifests do not hide good entries', async () => {
        const p = parseManual({ url: 'https://example.com/p/2', name: 'Two' });
        await saveProblem(root, p); p.samples.push({ input: '', output: '' }); await saveProblem(root, p, true);
        const bad = problemDir(root, 'a'.repeat(20)); await fs.mkdir(bad); await fs.writeFile(path.join(bad, 'problem.json'), '{');
        assert.strictEqual((await listProblems(root))[0].samples.length, 1);
        assert.throws(() => problemDir(root, '../outside'));
        assert.strictEqual(isPracticeSource(root, path.join(root, 'main.cpp')), false);
    });
});

suite('Local sample runner', function () {
    this.timeout(30000);
    let root: string;
    setup(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oj runner spaces ')); });
    teardown(async () => { await fs.rmdir(root, { recursive: true }); });
    test('compares tokens while preserving punctuation', () => {
        assert.strictEqual(normalizeOutput(' 1\r\n2 \t'), '1 2'); assert.notStrictEqual(normalizeOutput('1.0'), normalizeOutput('1'));
    });
    test('real C++ compilation handles paths with spaces and tests stdin', async () => {
        const source = path.join(root, 'main.cpp');
        await fs.writeFile(source, '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}');
        const results = await runSamples(source, [{ input: '1 2', output: '3' }, { input: '4 5', output: '10' }], { cpp: 'g++', c: 'gcc', python: 'python', timeout: 2000 });
        assert.strictEqual(results[0].passed, true); assert.strictEqual(results[1].passed, false);
    });
    test('compiler errors retain diagnostics', async () => {
        const source = path.join(root, 'main.cpp'); await fs.writeFile(source, 'invalid cplusplus');
        await assert.rejects(() => runSamples(source, [], { cpp: 'g++', c: 'gcc', python: 'python', timeout: 1000 }), /编译失败/);
    });
    test('kills infinite loops with TLE', async () => {
        const r = await execute(process.execPath, ['-e', 'while(true){}'], root, '', 200);
        assert.strictEqual(r.timedOut, true);
    });
    test('bounds runaway output', async () => {
        const r = await execute(process.execPath, ['-e', 'while(true)process.stdout.write("x".repeat(65536))'], root, '', 5000);
        assert.strictEqual(r.overflow, true); assert.ok(r.stdout.length <= 1024 * 1024);
    });
    test('nonzero exit and stderr remain visible', async () => {
        const r = await execute(process.execPath, ['-e', 'console.error("oops");process.exit(7)'], root, '', 2000);
        assert.strictEqual(r.code, 7); assert.ok(r.stderr.includes('oops'));
    });
    test('missing tool gives an actionable error', async () => {
        await assert.rejects(() => execute('oj-missing-tool-abcdef', [], root, '', 1000), /无法启动/);
    });
});
