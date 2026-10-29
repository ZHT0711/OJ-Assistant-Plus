import * as assert from 'assert';
import { parseCsecgJudgeResponse, parseCsecgVerdict } from '../../backend/csecg/verdict';

suite('CSECG verdict', () => {
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
