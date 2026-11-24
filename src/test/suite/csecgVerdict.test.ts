import * as assert from 'assert';
import { parseCsecgJudgeResponse, parseCsecgVerdict } from '../../backend/csecg/verdict';

suite('CSECG verdict', () => {
    const report = (cases: string, warning = '') => `最后一次提交时间: 2026-10-30 18:58:52\n得分：10.00\n${warning}\n共有测试数据:5\n平均占用内存:1.352K    平均CPU时间:0.00361S\n测试数据评判结果\n${cases}`;
    const acceptedCases = [1, 2, 3, 4, 5].map(n => `测试数据${n}完全正确`).join('\n');
    test('recognizes the actual 3919/5.c report', () => {
        const verdict = parseCsecgVerdict(report(acceptedCases), '0');
        assert.strictEqual(verdict.status, 'Accepted');
        assert.ok(verdict.details.includes('得分：10.00'));
        assert.ok(verdict.details.includes('测试数据5完全正确'));
    });
    test('compiler warnings preserve all diagnostics without failing accepted cases', () => {
        const warning = '成功编译,但有警告信息.\nMain.c: In function &apos;sum&apos;:\nMain.c:13:5: warning: &#39;count&#39; may be used uninitialized\n     return count;\n     ^';
        const verdict = parseCsecgVerdict(report(acceptedCases, warning), '0');
        assert.strictEqual(verdict.status, 'Accepted');
        assert.ok(verdict.details.includes("In function 'sum':"));
        assert.ok(verdict.details.includes("'count' may be used uninitialized"));
        assert.ok(verdict.details.includes('     return count;\n     ^'));
    });
    test('mixed test results do not report Accepted', () => {
        assert.strictEqual(parseCsecgVerdict(report(acceptedCases.replace('测试数据1完全正确', '测试数据1输出错误')), '0').status, 'Wrong Answer');
        assert.strictEqual(parseCsecgVerdict(report(acceptedCases + '\n测试数据6运行超时'), '0').status, 'Time Limit Exceeded');
        assert.strictEqual(parseCsecgVerdict(report(acceptedCases.replace('测试数据2完全正确', '测试数据2格式错误')), '0').status, 'Presentation Error');
    });
    test('partial or duplicated passing cases do not imply acceptance', () => {
        assert.notStrictEqual(parseCsecgVerdict(report('测试数据1完全正确'), '0').status, 'Accepted');
        assert.notStrictEqual(parseCsecgVerdict(report(Array(5).fill('测试数据1完全正确').join('\n')), '0').status, 'Accepted');
        assert.notStrictEqual(parseCsecgVerdict(report(acceptedCases.replace('测试数据1', '测试数据0')), '0').status, 'Accepted');
    });
    test('compiler diagnostics outrank memory usage statistics', () => {
        const verdict = parseCsecgVerdict('<pre>4.c:3:2: error: expected ; near <stdio.h></pre><div>Memory: 128 KB</div>', '0');
        assert.strictEqual(verdict.status, 'Compile Error');
        assert.ok(verdict.details.includes('4.c:3:2: error: expected ;'));
        assert.ok(verdict.details.includes('<stdio.h>'));
    });

    test('memory usage alone is not a memory limit verdict', () => {
        assert.strictEqual(parseCsecgVerdict('Memory: 128 KB', '0').status, '评测结果未识别');
        assert.strictEqual(parseCsecgVerdict('Memory Limit: 64 MB', '0').status, '评测结果未识别');
        assert.strictEqual(parseCsecgVerdict('Memory Limit Exceeded', '0').status, 'Memory Limit Exceeded');
    });

    test('parses a UTF-8 JSON response and keeps its error details', () => {
        const body = Buffer.from(JSON.stringify([{ ret: '0' }, { content: '编译错误\nmain.c:2:1: error: unknown type name' }]));
        const verdict = parseCsecgJudgeResponse(body);
        assert.strictEqual(verdict.status, 'Compile Error');
        assert.ok(verdict.details.includes('main.c:2:1'));
    });

    test('decodes CourseGrading GBK verdicts', () => {
        const gbk = Buffer.from('5b7b22726574223a202230227d2c207b22636f6e74656e74223a2022b1e0d2ebb4edcef3227d5d', 'hex');
        assert.strictEqual(parseCsecgJudgeResponse(gbk).status, 'Compile Error');
    });

    test('does not silently assign a verdict to malformed data', () => {
        assert.throws(() => parseCsecgJudgeResponse(Buffer.from('<html>login</html>')), /无法解析/);
    });
});
