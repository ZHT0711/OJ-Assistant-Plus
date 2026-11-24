// Code Runner entry point. Works from both PowerShell and cmd on Windows.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
    console.error('Save the source file before running it.');
    process.exit(1);
}
const source = path.resolve(file);
const cwd = path.dirname(source);
const ext = path.extname(source).toLowerCase();
const stem = path.basename(source, ext);
const cpp = ['.cpp', '.cc', '.cxx'].includes(ext);
if (ext !== '.c' && !cpp) {
    console.error('This runner supports C and C++ files.');
    process.exit(1);
}
const program = path.join(cwd, stem + (process.platform === 'win32' ? '.exe' : ''));
const compile = spawnSync(cpp ? 'g++' : 'gcc', [
    '-O2', ...(cpp ? ['-std=c++17'] : []), '-o', path.basename(program), path.basename(source),
], { cwd, stdio: 'inherit', shell: false });
if (compile.error) { console.error(compile.error.message); }
if (compile.status !== 0) { process.exit(compile.status || 1); }

const input = path.join(cwd, stem + '.in');
let fd;
try {
    try { fd = fs.openSync(input, 'r'); }
    catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    console.log(fd === undefined ? '[OJ] No .in file; enter input in this terminal.' : '[OJ] Input: ' + input);
    const result = spawnSync(program, [], { cwd, stdio: [fd === undefined ? 'inherit' : fd, 'inherit', 'inherit'], shell: false });
    if (result.error) { console.error(result.error.message); }
    process.exitCode = result.status === null ? 1 : result.status;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    if (fd !== undefined) { fs.closeSync(fd); }
}
