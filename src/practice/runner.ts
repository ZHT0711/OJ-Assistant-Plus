import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Sample } from './problem';
import { languageById, languageForSource, PracticeLanguageId, ToolId, tools } from './languages';

export interface RunOptions {
    cpp: string; c: string; python: string; timeout: number;
    node?: string; javac?: string; java?: string; go?: string; rust?: string;
}
export interface ProcessResult { stdout: string; stderr: string; code: number | null; timedOut: boolean; overflow: boolean; }
export interface CaseResult extends ProcessResult { passed: boolean; elapsed: number; }

/** No shell interpolation. Bound both output and time, including compiler execution. */
export function execute(command: string, args: string[], cwd: string, input: string, timeout: number): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false, overflow = false, length = 0;
        let timer: ReturnType<typeof setTimeout>;
        const stop = () => {
            if (process.platform === 'win32' && child.pid) {
                const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                killer.on('error', () => child.kill());
            } else { child.kill('SIGKILL'); }
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        const collect = (chunk: string, error: boolean) => {
            length += Buffer.byteLength(chunk, 'utf8');
            if (length > 1024 * 1024) { if (!overflow) { overflow = true; stop(); } return; }
            if (error) { stderr += chunk; } else { stdout += chunk; }
        };
        child.stdout.on('data', c => collect(c, false));
        child.stderr.on('data', c => collect(c, true));
        child.stdin.on('error', () => { /* Program may exit before consuming input. */ });
        child.on('error', err => { clearTimeout(timer); reject(new Error(`无法启动 ${command}：${err.message}。请安装工具或在 OJ Assistant 设置中填写完整路径。`)); });
        child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut, overflow }); });
        timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
        child.stdin.end(input);
    });
}

export function normalizeOutput(value: string): string {
    return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
}

export async function runSamples(source: string, samples: Sample[], options: RunOptions): Promise<CaseResult[]> {
    if (!languageForSource(source)) { throw new Error('样例运行支持 C++、C、Python、JavaScript、Java、Go、Rust'); }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oj-assistant-'));
    const ext = languageForSource(source)!.id;
    const executable = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main');
    let command: string, args: string[];
    try {
        let compile: [string, string[]] | undefined;
        switch (ext) {
            case 'cpp': compile = [options.cpp, ['-std=c++17', '-O2', source, '-o', executable]]; command = executable; args = []; break;
            case 'c': compile = [options.c, ['-std=c11', '-O2', source, '-o', executable]]; command = executable; args = []; break;
            case 'py': command = options.python; args = [source]; break;
            case 'js': command = options.node || 'node'; args = [source]; break;
            case 'java': {
                const java = path.join(dir, 'Main.java');
                await fs.copyFile(source, java);
                compile = [options.javac || 'javac', ['-encoding', 'UTF-8', '-d', dir, java]]; command = options.java || 'java'; args = ['-Dfile.encoding=UTF-8', '-cp', dir, 'Main']; break;
            }
            case 'go': compile = [options.go || 'go', ['build', '-o', executable, source]]; command = executable; args = []; break;
            case 'rs': compile = [options.rust || 'rustc', ['--edition=2021', '-O', source, '-o', executable]]; command = executable; args = []; break;
            default: throw new Error('样例运行支持 C++、C、Python、JavaScript、Java、Go、Rust');
        }
        if (compile) {
            const result = await execute(compile[0], compile[1], dir, '', 60000);
            if (result.code !== 0 || result.timedOut || result.overflow) { throw new Error('编译失败：\n' + (result.stderr || result.stdout || '编译超时或输出超限')); }
        }
        const results: CaseResult[] = [];
        for (const sample of samples) {
            const start = Date.now();
            const result = await execute(command, args, dir, sample.input, options.timeout);
            results.push({ ...result, elapsed: Date.now() - start, passed: result.code === 0 && !result.timedOut && !result.overflow && normalizeOutput(result.stdout) === normalizeOutput(sample.output) });
        }
        return results;
    } finally { await fs.rmdir(dir, { recursive: true }).catch(() => undefined); }
}

export interface ToolCheck { tool: ToolId; command: string; available: boolean; detail: string; }
export async function checkTools(id: PracticeLanguageId, options: RunOptions): Promise<ToolCheck[]> {
    const language = languageById(id);
    if (!language) { throw new Error('不支持的刷题语言'); }
    const checks: ToolCheck[] = [];
    for (const tool of language.tools) {
        const spec = tools[tool];
        const command = options[tool] || spec.command;
        try {
            const result = await execute(command, spec.versionArgs, os.tmpdir(), '', 5000);
            checks.push({ tool, command, available: result.code === 0 && !result.timedOut && !result.overflow,
                detail: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || (result.timedOut ? '检测超时' : '未返回版本信息') });
        } catch (err) { checks.push({ tool, command, available: false, detail: `${err.message} 设置项：ojassist.practice.${spec.setting}` }); }
    }
    return checks;
}
