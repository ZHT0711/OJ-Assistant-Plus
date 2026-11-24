import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { containsPath, nearestAccountRoot } from '../../account/roots';

suite('Nested account folders', () => {
    let root: string;
    setup(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'oj-nested-'));
        await fs.mkdir(path.join(root, 'HDOJ', 'problems'), { recursive: true });
        await fs.writeFile(path.join(root, '.ojassistconfig.json'), '{"backend":"csecg"}');
    });
    teardown(async () => { await fs.rmdir(root, { recursive: true }); });
    test('nested HDOJ owns its files while the parent remains CSECG', async () => {
        const nested = path.join(root, 'HDOJ');
        await fs.writeFile(path.join(nested, '.ojassistconfig.json'), '{"backend":"hdoj"}');
        assert.strictEqual(nearestAccountRoot(path.join(nested, 'problems', '1000.c'), root), nested);
        assert.strictEqual(nearestAccountRoot(path.join(root, 'a', '3919', '5.c'), root), root);
        assert.strictEqual(nearestAccountRoot(path.join(root, 'HDOJ-other', '1000.c'), root), root);
    });
    test('nested folder works when the parent has no platform config', async () => {
        await fs.unlink(path.join(root, '.ojassistconfig.json'));
        const nested = path.join(root, 'HDOJ');
        await fs.writeFile(path.join(nested, '.ojassistconfig.json'), '{"backend":"hdoj"}');
        assert.strictEqual(nearestAccountRoot(path.join(nested, '1000.cpp'), root), nested);
    });
    test('removing nested config falls back to the parent', async () => {
        const config = path.join(root, 'HDOJ', '.ojassistconfig.json');
        await fs.writeFile(config, '{}');
        await fs.unlink(config);
        assert.strictEqual(nearestAccountRoot(path.join(root, 'HDOJ', '1000.c'), root), root);
    });
    test('config search never escapes the workspace and supports nested workspace roots', async () => {
        const nested = path.join(root, 'HDOJ');
        assert.strictEqual(nearestAccountRoot(path.join(nested, '1000.c'), nested), nested);
        assert.strictEqual(containsPath(root, root + '-other'), false);
        assert.strictEqual(containsPath(root, path.join(root, '..old')), true);
        assert.strictEqual(containsPath(root, root), true);
    });
});
