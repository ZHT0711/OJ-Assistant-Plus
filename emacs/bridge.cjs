/* OJ Assistant's editor-independent service for the native Emacs frontend. */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const Module = require('node:module');

// Compile only this checkout's TypeScript. No VS Code installation is needed.
const sourceRoot = path.resolve(__dirname, '../src');
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => {
    if (!file.startsWith(sourceRoot + path.sep)) { throw new Error('Unexpected TypeScript module'); }
    const source = require('node:fs').readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    }, fileName: file });
    module._compile(compiled.outputText, file);
};

class Uri {
    constructor(value) {
        this.value = value;
        this.fsPath = value.startsWith('file:') ? fileURLToPath(value) : value;
        this.path = this.fsPath.replace(/\\/g, '/');
    }
    toString() { return this.value; }
    static file(file) { return new Uri(pathToFileURL(file).href); }
    static parse(value) { return new Uri(value); }
    static joinPath(uri, ...parts) { return Uri.file(path.resolve(uri.fsPath, ...parts)); }
}
const vscode = {
    Uri,
    env: { openExternal: async uri => { emit({ event: 'open', url: uri.toString() }); return true; } },
    window: { showInputBox: async () => { throw new Error('请使用 Emacs 的登录命令或浏览器登录完成验证'); } },
};
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
    if (name === 'vscode' && parent?.filename.startsWith(sourceRoot + path.sep)) { return vscode; }
    return originalLoad.call(this, name, parent, isMain);
};
// Backends only use the Markdown export. Avoid loading the VS Code UI barrel.
const markdown = require('../src/utils/markdown.ts');
const utilsFile = path.join(sourceRoot, 'utils/index.ts');
const utilsModule = new Module(utilsFile);
utilsModule.exports = markdown;
utilsModule.loaded = true;
require.cache[utilsFile] = utilsModule;

const { backends, adapterFor, platformAdapters } = require('../src/backend/index.ts');
const { identify, parseManual, problemKey, sanitizeHtml } = require('../src/practice/problem.ts');
const { fetchProblem, collectionTargets } = require('../src/practice/importer.ts');
const store = require('../src/practice/store.ts');
const solutions = require('../src/practice/solutions.ts');
const { languages, tools, languageForSource, languageById } = require('../src/practice/languages.ts');
const { runSamples, checkTools } = require('../src/practice/runner.ts');
const { SourceFile } = require('../src/model/Problem.ts');
const { matchLanguages } = require('../src/account/language.ts');
const { SubmissionTracker, recordOf, submissionAccountKey } = require('../src/account/submissions.ts');
const { writeJson, safeMessage } = require('../src/account/credentials.ts');
const { sampleText, validSamples } = require('../src/account/sampleData.ts');

let emit = () => {};
const storageRoot = path.join(os.homedir(), '.oj-assistant-emacs');

async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') { return fallback; } throw error; }
}

// Windows DPAPI encrypts the account catalog for the current Windows user.
// Credentials travel over stdin, never command-line arguments or project files.
function protect(value, decrypt = false) {
    const script = '$ErrorActionPreference="Stop";' +
        '[void][Reflection.Assembly]::LoadWithPartialName("System.Security");' +
        '[Console]::InputEncoding=[Text.UTF8Encoding]::new();' +
        '[Console]::OutputEncoding=[Text.UTF8Encoding]::new();' +
        '$value=[Console]::In.ReadToEnd();' + (decrypt
            ? '$bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$null,0);[Console]::Write([Text.Encoding]::UTF8.GetString($bytes))'
            : '$bytes=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,0);[Console]::Write([Convert]::ToBase64String($bytes))');
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        const timer = setTimeout(() => child.kill(), 15000);
        child.stdout.setEncoding('utf8').on('data', text => { output += text; });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 Windows 凭据加密服务')); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) { resolve(output); }
            else { reject(new Error('Windows 凭据存储无法读取或写入，请使用原 Windows 账号重试')); }
        });
        child.stdin.end(value, 'utf8');
    });
}

class AccountVault {
    constructor(directory = storageRoot) { this.directory = directory; this.pending = Promise.resolve(); this.memory = []; }
    async list() {
        if (process.platform !== 'win32') { return this.memory; }
        let encrypted;
        try { encrypted = await fs.readFile(path.join(this.directory, 'accounts.dpapi'), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') { return []; } throw error; }
        return JSON.parse(await protect(encrypted, true));
    }
    save(account) {
        const operation = this.pending.catch(() => {}).then(async () => {
            const accounts = await this.list();
            const next = [account, ...accounts.filter(item => item.id !== account.id)];
            if (process.platform !== 'win32') { this.memory = next; return; }
            const encrypted = await protect(JSON.stringify(next));
            if (await protect(encrypted, true) !== JSON.stringify(next)) { throw new Error('凭据存储回读校验失败'); }
            await fs.mkdir(this.directory, { recursive: true });
            const file = path.join(this.directory, 'accounts.dpapi');
            const temp = file + '.' + randomBytes(6).toString('hex');
            try { await fs.writeFile(temp, encrypted, { mode: 0o600 }); await fs.rename(temp, file); }
            finally { await fs.unlink(temp).catch(() => {}); }
        });
        this.pending = operation;
        return operation;
    }
}

function createService(options = {}) {
    const vault = options.vault || new AccountVault();
    const registry = options.backends || backends;
    const sessions = new Map();
    const connections = new Map();
    const generations = new Map();
    const tracker = new SubmissionTracker();
    const cancellations = new Map();
    const pendingUploads = new Set();
    const locks = new Map();
    const running = new Set();
    const activeBrowsers = new Set();
    const browserLogins = new Set();
    const notify = options.emit || (() => {});
    const canonicalRoot = root => path.resolve(root);
    const configFile = root => path.join(root, '.oj-assistant/emacs.json');
    const historyFile = root => path.join(root, '.oj-assistant/emacs-history.json');
    const cacheFile = (root, key) => path.join(root, '.oj-assistant/emacs-problems', key, 'problem.json');

    async function serial(root, fn) {
        const key = canonicalRoot(root);
        const operation = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
        locks.set(key, operation);
        try { return await operation; }
        finally { if (locks.get(key) === operation) { locks.delete(key); } }
    }
    async function config(root) {
        const own = await readJson(configFile(root), null);
        const legacy = await readJson(path.join(root, '.ojassistconfig.json'), {});
        const canonical = value => adapterFor(value)?.id || value;
        if (!own) { return { ...legacy, backend: canonical(legacy.backend) }; }
        const compatible = canonical(own.backend) === canonical(legacy.backend) &&
            (own.baseUrl || '') === (legacy.baseUrl || '');
        const inherited = compatible ? legacy : {};
        return { ...inherited, ...own, backend: canonical(own.backend),
            credentials: own.accountId ? undefined : inherited.credentials };
    }
    async function configure(root, value) {
        await fs.mkdir(path.dirname(configFile(root)), { recursive: true });
        await writeJson(configFile(root), value);
    }
    function invalidate(root) {
        sessions.delete(root);
        connections.delete(root);
        generations.set(root, (generations.get(root) || 0) + 1);
    }
    async function loadSession(root, generation) {
        const cfg = await config(root);
        if (!registry[cfg.backend]) { throw new Error('请先初始化账号工作区并登录'); }
        const saved = (await vault.list()).find(account => account.id === cfg.accountId);
        const credentials = saved?.credentials || cfg.credentials;
        if (!credentials || !Object.keys(credentials).some(key => /cookie|password|token/i.test(key))) {
            throw new Error('请先登录。VS Code 凭据需在 Emacs 中重新登录一次');
        }
        const server = new registry[cfg.backend]({ ...cfg, credentials });
        let user;
        try { user = await server.login(); }
        catch (error) { throw new Error(safeMessage(error, credentials)); }
        const account = String(user?.username || user?.user || user?.handle || credentials.username || '当前会话');
        const sessionKey = createHash('sha256').update(JSON.stringify([cfg.backend, cfg.baseUrl || '', account])).digest('hex');
        const session = { server, cfg, account, sessionKey, credentials };
        if ((generations.get(root) || 0) !== generation) { throw new Error('登录期间账号已切换，请重试'); }
        sessions.set(root, session);
        return session;
    }
    async function connect(root) {
        if (sessions.has(root)) { return sessions.get(root); }
        if (connections.has(root)) { return connections.get(root); }
        const pending = loadSession(root, generations.get(root) || 0);
        connections.set(root, pending);
        try { return await pending; }
        finally { if (connections.get(root) === pending) { connections.delete(root); } }
    }
    async function remember(root, cfg, credentials, id, label) {
        const account = { id: id || randomBytes(12).toString('hex'), backend: cfg.backend,
            baseUrl: cfg.baseUrl, label: label || cfg.backend, credentials };
        // Verify credentials before replacing the workspace's selected account.
        const server = new registry[cfg.backend]({ ...cfg, credentials });
        try { await server.login(); }
        catch (error) { throw new Error(safeMessage(error, credentials)); }
        await vault.save(account);
        await configure(root, { backend: cfg.backend, baseUrl: cfg.baseUrl, accountId: account.id, label: account.label });
        invalidate(root);
        return { label: account.label, persistent: process.platform === 'win32' };
    }
    async function history(root) { return readJson(historyFile(root), []); }
    async function persist(root, job) {
        await serial(root, async () => {
            const records = await history(root);
            await fs.mkdir(path.dirname(historyFile(root)), { recursive: true });
            await writeJson(historyFile(root), [recordOf(job), ...records.filter(item => item.localId !== job.localId)].slice(0, 300));
        });
        notify({ event: 'judgement', record: recordOf(job), root });
    }
    function keyFor(session, info) {
        return problemKey(JSON.stringify([session.sessionKey, info.contestId || '', info.id]));
    }
    async function getProblem(root, params) {
        if (!/^[a-f0-9]{20}$/.test(params.key || '')) { throw new Error('无效的题目编号'); }
        const file = params.kind === 'account' ? cacheFile(root, params.key) : path.join(store.problemDir(root, params.key), 'problem.json');
        const problem = await readJson(file);
        if (!problem) { throw new Error('题目缓存不存在，请重新打开题目'); }
        return problem;
    }
    function runOptions(params = {}) {
        const defaults = Object.fromEntries(Object.entries(tools).map(([key, value]) => [key, value.command]));
        return { ...defaults, ...params.tools, timeout: Math.max(100, Math.min(600000, Number(params.timeout) || 2000)) };
    }
    async function openAccount(root, params) {
        const session = await connect(root);
        const info = { id: String(params.id), contestId: params.contestId == null ? undefined : String(params.contestId) };
        const key = keyFor(session, info);
        let problem = await readJson(cacheFile(root, key));
        if (!problem || params.refresh) {
            let fetched;
            try { fetched = await session.server.getProblem(info); }
            catch (error) { throw new Error(safeMessage(error, session.credentials)); }
            const adapter = adapterFor(session.cfg.backend);
            const content = fetched.content;
            const url = adapter?.webUrl(info) || '';
            const htmlSamples = session.cfg.backend === 'leetcode' || adapter?.sampleHtml !== false;
            const samples = (content.sampleInput || []).map((input, index) => ({
                input: sampleText(String(input || ''), htmlSamples),
                output: sampleText(String(content.sampleOutput[index] || ''), htmlSamples),
            }));
            const sections = [['题目描述', content.desc], ['输入', content.input], ['输出', content.output], ['提示', content.note]];
            problem = { version: 1, key, kind: 'account', backend: session.cfg.backend, sessionKey: session.sessionKey,
                ...info, url, submitUrl: url, title: content.title, platform: session.cfg.backend, group: params.assignmentName || info.contestId || '',
                statement: sanitizeHtml(sections.filter(([, text]) => text).map(([title, text]) => `<h2>${title}</h2>${text}`).join(''), url || 'https://example.com'),
                samples, functionProblem: session.cfg.backend === 'leetcode' };
            await fs.mkdir(path.dirname(cacheFile(root, key)), { recursive: true });
            await writeJson(cacheFile(root, key), problem);
        }
        const language = languageById(params.language || 'cpp');
        if (!language) { throw new Error('不支持的本地语言'); }
        const relative = adapterFor(session.cfg.backend)?.solutionPath(info, language.id) || path.join('problems', `${info.id}.${language.id}`);
        const source = path.resolve(root, relative);
        if (!source.startsWith(root + path.sep)) { throw new Error('平台返回的文件名超出工作区'); }
        await fs.mkdir(path.dirname(source), { recursive: true });
        try { await fs.writeFile(source, language.template, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') { throw error; } }
        const metadata = path.join(root, '.oj-assistant/emacs-sources.json');
        await serial(root, async () => {
            const files = await readJson(metadata, {});
            files[path.relative(root, source)] = { key, kind: 'account' };
            await writeJson(metadata, files);
        });
        return { problem, source };
    }
    async function poll(root, job, credentials) {
        if (cancellations.has(job.localId)) { throw new Error('该提交正在查询中'); }
        const controller = new AbortController();
        cancellations.set(job.localId, controller);
        const token = {
            get isCancellationRequested() { return controller.signal.aborted; },
            onCancellationRequested(listener) {
                controller.signal.addEventListener('abort', listener, { once: true });
                return { dispose: () => controller.signal.removeEventListener('abort', listener) };
            },
        };
        try {
            await tracker.poll(job, { timeout: options.pollTimeout || 120000,
                requestTimeout: options.requestTimeout || 15000, interval: options.pollInterval || 1500, token,
                onChange: () => {
                    if (job.verdict?.details) { job.verdict.details = safeMessage(job.verdict.details, credentials); }
                    notify({ event: 'judgement', root, record: recordOf(job) });
                } });
        } catch (error) { job.message = safeMessage(error, credentials); }
        finally { cancellations.delete(job.localId); }
        await persist(root, job);
        return recordOf(job);
    }
    async function browserLogin(root, params) {
        const cfg = await config(root);
        const spec = adapterFor(cfg.backend)?.login;
        if (!spec) { throw new Error('该平台请使用用户名密码登录'); }
        const id = randomBytes(12).toString('hex');
        const profile = path.join(storageRoot, 'browser', cfg.backend, cfg.accountId || id);
        await fs.mkdir(profile, { recursive: true });
        const puppeteer = require('puppeteer-core');
        let browser, lastError;
        for (const channel of ['msedge', 'chrome']) {
            try {
                browser = await puppeteer.launch({ channel, headless: false, defaultViewport: null,
                    userDataDir: profile, args: ['--no-first-run', '--no-default-browser-check'] });
                break;
            } catch (error) { lastError = error; }
        }
        if (!browser) { throw new Error('无法启动 Chrome/Edge。' + safeMessage(lastError)); }
        activeBrowsers.add(browser);
        try {
            const page = await browser.newPage();
            await page.goto(spec.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const deadline = Date.now() + 300000;
            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                const cookies = (await browser.cookies()).filter(cookie => {
                    const domain = cookie.domain.replace(/^\./, '');
                    return domain === spec.domainSuffix || domain.endsWith('.' + spec.domainSuffix);
                });
                const values = Object.fromEntries(cookies.map(cookie => [cookie.name, cookie.value]));
                if (!spec.cookieCheck(values)) { continue; }
                const header = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                if (spec.probe && !await spec.probe(header).catch(() => false)) { continue; }
                return await serial(root, async () => {
                    if (JSON.stringify(await config(root)) !== JSON.stringify(cfg)) { throw new Error('登录期间工作区账号配置已变化，请重试'); }
                    return remember(root, cfg, { cookies: header }, cfg.accountId || id, params.label);
                });
            }
            throw new Error('浏览器登录等待超时，请重试');
        } finally { activeBrowsers.delete(browser); await browser.close().catch(() => {}); }
    }

    async function dispatch(method, params = {}) {
        params = params || {};
        const root = canonicalRoot(params.root || process.cwd());
        switch (method) {
            case 'hello': return { languages, platforms: platformAdapters.map(item => ({ id: item.id, browser: !!item.login })) };
            case 'init': return serial(root, async () => {
                if (!registry[params.backend]) { throw new Error('未知平台'); }
                if ((await config(root)).backend && !params.replace) { throw new Error('此目录已有账号配置，请用切换账号或重新登录'); }
                await configure(root, { backend: params.backend, label: params.label || params.backend });
                invalidate(root);
                return { backend: params.backend };
            });
            case 'accounts': return (await vault.list()).map(({ credentials, ...account }) => account);
            case 'account-use': return serial(root, async () => {
                const saved = (await vault.list()).find(account => account.id === params.id);
                if (!saved) { throw new Error('保存的账号不存在'); }
                return remember(root, saved, saved.credentials, saved.id, saved.label);
            });
            case 'login': return serial(root, async () => {
                const cfg = await config(root);
                if (!registry[cfg.backend]) { throw new Error('请先初始化账号工作区'); }
                return remember(root, cfg, params.credentials, cfg.accountId, params.label);
            });
            case 'browser-login': {
                if (browserLogins.has(root)) { throw new Error('此工作区正在等待浏览器登录'); }
                browserLogins.add(root);
                try { return await browserLogin(root, params); }
                finally { browserLogins.delete(root); }
            }
            case 'status': {
                const cfg = await config(root);
                return { backend: cfg.backend || '', label: cfg.label || '', ready: sessions.has(root) };
            }
            case 'account-list': {
                const session = await connect(root);
                if (!session.server.searchProblems) { throw new Error('此平台未提供题库搜索，请按题号打开'); }
                try {
                    const page = await session.server.searchProblems(params.keyword || '', params.page || 1);
                    const records = (await history(root)).filter(record => record.sessionKey === session.sessionKey && record.state === 'completed');
                    page.problems = page.problems.map(problem => {
                        const record = records.find(item => item.problemId === problem.id && (item.contestId || '') === (problem.contestId || '') &&
                            /accepted|已通过|得分|\d+(?:\.\d+)?\s*分/i.test(item.verdict?.result || ''));
                        return record ? { ...problem, status: record.verdict.result === 'Accepted' ? '✓ 已AC' : record.verdict.result } : problem;
                    });
                    return { ...page, account: session.account };
                }
                catch (error) { throw new Error(safeMessage(error, session.credentials)); }
            }
            case 'account-open': return openAccount(root, params);
            case 'account-languages': {
                const session = await connect(root);
                return matchLanguages(languageForSource(params.source)?.id || '', session.server.listLanguages?.() || []);
            }
            case 'practice-import': {
                const targets = await collectionTargets(identify(params.url));
                const imported = [], failed = [];
                for (const target of targets) {
                    try {
                        const problem = await fetchProblem(target);
                        await serial(root, () => store.saveProblem(root, problem));
                        imported.push(problem);
                        notify({ event: 'progress', message: `已导入 ${imported.length}/${targets.length} ${problem.title}` });
                    } catch (error) { failed.push({ url: target.url, message: safeMessage(error) }); }
                }
                return { imported, failed };
            }
            case 'practice-json': {
                const value = JSON.parse(await fs.readFile(params.file, 'utf8'));
                const problems = (Array.isArray(value) ? value : [value]).map(parseManual);
                for (const problem of problems) { await serial(root, () => store.saveProblem(root, problem)); }
                return problems;
            }
            case 'practice-list': return store.listProblems(root);
            case 'practice-remove': return serial(root, () => store.removeProblem(root, params.key));
            case 'practice-open': {
                const problem = await getProblem(root, params);
                const language = params.language || await solutions.readProblemLanguage(root, params.key) || 'cpp';
                return serial(root, async () => {
                    const source = await solutions.ensureSolution(root, params.key, language);
                    await solutions.saveProblemLanguage(root, params.key, language);
                    return { source, problem };
                });
            }
            case 'source-info': {
                const source = path.resolve(params.source);
                const practice = store.readPractice(root, source);
                if (practice) { return { kind: 'practice', key: practice.key }; }
                return (await readJson(path.join(root, '.oj-assistant/emacs-sources.json'), {}))[path.relative(root, source)] || null;
            }
            case 'problem': return getProblem(root, params);
            case 'tests': {
                const problem = await getProblem(root, params);
                if (params.kind !== 'account') { return problem.samples; }
                return (await readJson(path.join(path.dirname(cacheFile(root, params.key)), 'tests.json'), { tests: problem.samples })).tests;
            }
            case 'tests-save': return serial(root, async () => {
                if (!validSamples(params.tests)) {
                    throw new Error('测试应为包含 input/output 字符串的数组，至多 100 项，每项至多 2 MiB');
                }
                const problem = await getProblem(root, params);
                if (params.kind === 'account') {
                    await writeJson(path.join(path.dirname(cacheFile(root, params.key)), 'tests.json'), { tests: params.tests });
                } else { await store.saveProblem(root, { ...problem, samples: params.tests }, true); }
                return params.tests;
            });
            case 'tools': return checkTools(params.language || 'cpp', runOptions(params));
            case 'run': {
                const source = path.resolve(params.source);
                if (running.has(source)) { throw new Error('此文件正在测试'); }
                const problem = await getProblem(root, params);
                if (problem.functionProblem && !params.driver) { throw new Error('力扣函数题请用带前缀参数的运行命令选择自包含测试驱动'); }
                const tests = await dispatch('tests', params);
                if (!tests.length) { throw new Error('尚无样例，请先编辑测试'); }
                running.add(source);
                try {
                    const results = await runSamples(params.driver ? path.resolve(params.driver) : source, tests, runOptions(params));
                    return results.map((result, index) => ({ ...result, input: tests[index].input, expected: tests[index].output }));
                }
                finally { running.delete(source); }
            }
            case 'history': return history(root);
            case 'submit': {
                const session = await connect(root);
                const problem = await getProblem(root, { ...params, kind: 'account' });
                if (problem.sessionKey !== session.sessionKey) { throw new Error('当前账号与此题缓存不匹配，请用当前账号重新打开题目'); }
                const source = path.resolve(params.source);
                const sourceType = languageForSource(source)?.id;
                const choices = matchLanguages(sourceType || '', session.server.listLanguages?.() || []).choices;
                if (!choices.some(choice => String(choice.value) === String(params.language))) { throw new Error('提交语言与文件类型不匹配'); }
                const file = new SourceFile(problem.id, problem.contestId, sourceType, await fs.readFile(source, 'utf8'), Uri.file(source), params.language);
                const scope = JSON.stringify([root, session.sessionKey, problem.contestId || '', problem.id]);
                let job;
                await serial(root, async () => {
                    const records = await history(root);
                    const rateLimitKey = submissionAccountKey(session.cfg.backend, session.server.baseUrl || session.cfg.baseUrl, session.account);
                    tracker.restore(records.filter(record => record.sessionKey === session.sessionKey), rateLimitKey);
                    const prior = records.find(record => record.scope === scope && !['completed', 'failed'].includes(record.state));
                    if (prior) { throw new Error('该题有未结束的提交，请从历史继续查询或到原站确认后解除阻止'); }
                    job = tracker.create({ scope, sessionKey: session.sessionKey, backend: session.cfg.backend, account: session.account,
                        problemId: problem.id, contestId: problem.contestId, relativeFile: path.relative(root, source), language: params.language, rateLimitKey });
                    await fs.mkdir(path.dirname(historyFile(root)), { recursive: true });
                    await writeJson(historyFile(root), [recordOf(job), ...await history(root)].slice(0, 300));
                });
                pendingUploads.add(job.localId);
                try {
                    const sending = tracker.send(job, () => session.server.submit(file), options.uploadTimeout || 30000);
                    job.upload?.then(() => pendingUploads.delete(job.localId), () => pendingUploads.delete(job.localId));
                    await sending;
                }
                catch (error) { job.message = safeMessage(error, session.credentials); }
                // If an upload finishes after its timeout, persist its record ID too.
                if (job.state === 'unknown') { job.upload?.then(() => persist(root, job), () => persist(root, job)).catch(() => {}); }
                await persist(root, job);
                return job.resolver ? poll(root, job, session.credentials) : recordOf(job);
            }
            case 'resume': {
                const session = await connect(root);
                const record = (await history(root)).find(item => item.localId === params.id);
                if (!record) { throw new Error('没有找到该提交'); }
                if (record.sessionKey !== session.sessionKey) { throw new Error('请切换到提交时的账号'); }
                if (record.state === 'completed' || record.state === 'failed') { return record; }
                let job = tracker.jobs.get(record.localId);
                if (!job) {
                    if (!record.recordId || !session.server.resumeSubmission) { throw new Error('平台无法恢复此提交，请在原站查看记录后解除阻止'); }
                    const source = new SourceFile(record.problemId, record.contestId, '', '', Uri.file(path.join(root, record.relativeFile)), record.language);
                    job = { ...record, resolver: session.server.resumeSubmission(record.recordId, source) };
                    tracker.jobs.set(job.localId, job);
                }
                if (!job.resolver) { throw new Error('上传结果尚未确认，请查看原站记录'); }
                return poll(root, job, session.credentials);
            }
            case 'pause': {
                const record = (await history(root)).find(item => item.localId === params.id);
                if (!record) { throw new Error('没有找到该提交'); }
                const controller = cancellations.get(record.localId);
                if (!controller) { throw new Error('此提交当前未在等待评测'); }
                controller.abort();
                return { paused: true };
            }
            case 'submission-dismiss': return serial(root, async () => {
                const records = await history(root);
                const record = records.find(item => item.localId === params.id);
                const live = tracker.jobs.get(params.id);
                if (pendingUploads.has(params.id) || cancellations.has(params.id)) { throw new Error('该提交仍在上传或等待评测，请稍后处理'); }
                if (!record) { throw new Error('提交不存在'); }
                record.state = 'failed'; record.message = '用户已在原站确认并解除重交阻止';
                if (live) { Object.assign(live, record); }
                await writeJson(historyFile(root), records);
                return record;
            });
            default: throw new Error('未知操作 ' + method);
        }
    }
    return { dispatch, close: async () => { await Promise.allSettled([...activeBrowsers].map(browser => browser.close())); } };
}

function main() {
    const output = value => process.stdout.write(JSON.stringify(value) + '\n');
    emit = output;
    // Backend diagnostics must never corrupt the JSON protocol or expose credentials.
    console.log = console.warn = console.error = () => {};
    const service = createService({ emit: output });
    const input = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', line => {
        let request;
        try { request = JSON.parse(line); }
        catch { output({ id: null, error: '无效的 JSON 请求' }); return; }
        service.dispatch(request.method, request.params).then(
            result => output({ id: request.id, result: result === undefined ? null : result }),
            error => output({ id: request.id, error: safeMessage(error) }),
        );
    });
    input.on('close', () => { service.close().finally(() => process.exit(0)); });
}

module.exports = { createService, AccountVault, protect };
if (require.main === module) { main(); }
