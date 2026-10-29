import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { languages } from '../../practice/languages';
import { ensureSolution, readProblemLanguage, saveProblemLanguage } from '../../practice/solutions';
import { checkTools, RunOptions, runSamples } from '../../practice/runner';

const sumSolutions: { [id: string]: string } = {
    cpp: '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}',
    c: '#include <stdio.h>\nint main(void){long long a,b;scanf("%lld%lld",&a,&b);printf("%lld",a+b);return 0;}',
    py: 'import sys\na,b=map(int,sys.stdin.buffer.read().split())\nprint(a+b)\n',
    js: "const a=require('fs').readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);console.log(a[0]+a[1]);",
    java: 'import java.util.*;\n// 中文 UTF-8 编译测试\npublic class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in);System.out.println(s.nextLong()+s.nextLong()); }}',
    go: 'package main\nimport "fmt"\nfunc main(){var a,b int64;fmt.Scan(&a,&b);fmt.Println(a+b)}\n',
    rs: 'use std::io::{self,Read};\nfn main(){let mut s=String::new();io::stdin().read_to_string(&mut s).unwrap();let v:Vec<i64>=s.split_whitespace().map(|v|v.parse().unwrap()).collect();println!("{}",v[0]+v[1]);}',
};

suite('Practice language state and toolchains', function () {
    this.timeout(90000);
    let root: string;
    const key = 'b'.repeat(20);
    const options: RunOptions = { cpp: 'g++', c: 'gcc', python: 'python', timeout: 3000 };
    setup(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oj languages 空格 ')); });
    teardown(async () => { await fs.rmdir(root, { recursive: true }); });
    test('switching languages preserves solutions and remembers the last choice', async () => {
        const cpp = await ensureSolution(root, key, 'cpp');
        await fs.writeFile(cpp, 'my C++ solution');
        await saveProblemLanguage(root, key, 'cpp');
        const python = await ensureSolution(root, key, 'py');
        await fs.writeFile(python, 'my Python solution');
        await saveProblemLanguage(root, key, 'py');
        await ensureSolution(root, key, 'cpp');
        assert.strictEqual(await fs.readFile(cpp, 'utf8'), 'my C++ solution');
        assert.strictEqual(await fs.readFile(python, 'utf8'), 'my Python solution');
        assert.strictEqual(await readProblemLanguage(root, key), 'py');
        await fs.writeFile(path.join(path.dirname(cpp), 'language.json'), '{broken');
        assert.strictEqual(await readProblemLanguage(root, key), undefined);
    });
    test('custom tool paths yield a clear diagnostic when unavailable', async () => {
        const results = await checkTools('java', { ...options, javac: 'missing-java-compiler-abcdef', java: 'missing-java-runtime-abcdef' });
        assert.strictEqual(results.length, 2);
        assert.ok(results.every(r => !r.available));
        assert.ok(results[0].detail.includes('ojassist.practice.javaCompiler'));
        assert.ok(results[1].detail.includes('ojassist.practice.javaCommand'));
    });
    for (const language of languages) {
        test(`${language.label}: real template and positive/negative sample runs`, async function () {
            const checks = await checkTools(language.id, options);
            if (checks.some(c => !c.available)) { this.skip(); return; }
            const source = await ensureSolution(root, key, language.id);
            const empty = await runSamples(source, [{ input: '', output: '' }], options);
            assert.ok(empty[0].passed, language.label + ' template is runnable');
            await fs.writeFile(source, sumSolutions[language.id], 'utf8');
            const results = await runSamples(source, [
                { input: '1 2\n', output: '3\n' },
                { input: '-10 20\n', output: '10\n' },
                { input: '5 6\n', output: '12\n' },
            ], options);
            assert.deepStrictEqual(results.map(r => r.passed), [true, true, false]);
        });
    }
});
