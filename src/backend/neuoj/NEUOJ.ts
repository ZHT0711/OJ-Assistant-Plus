import axios, { AxiosRequestConfig } from 'axios';
import axiosCookieJarSupport from '@3846masa/axios-cookiejar-support';
import { CookieJar, Cookie } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { promises as fs } from 'fs';
import {
    OJ, User, Configuration, SimpleUserPasswordCredential,
    SourceFile, ProblemSubmit, Problem, ProblemInfo, ProblemListEntry, ProblemListPage
} from '../../model';
import { markdownToHtml } from '../../utils';

axiosCookieJarSupport(axios);

/**
 * Fallback language id map for https://oj.neu.edu.cn (Laravel "F_OnlineJudge").
 *
 * The real ids live in the submit form on each problem page, so at submit time
 * we re-read them from `<select>` options whenever the page provides one. This
 * map is only used when the page can not be parsed (config `languages` overrides it).
 */
const defaultLanguageMap: { [ext: string]: number } = {
    'c': 1,
    'cpp': 2,
    'cc': 2,
    'cxx': 2,
    'java': 3,
    'py': 4,
    'py3': 4,
    'python': 4,
    'js': 5,
    'go': 6,
    'txt': 0,
};

interface LivewireComponent {
    snapshot: string;
    updates: { [key: string]: any };
    calls: Array<{ path: string; method: string; params: any[] }>;
}

interface ProblemPageInfo {
    html: string;
    $: cheerio.Root;
    /** <form> that posts to *submissions/create*, if the page has a classic form. */
    submitForm: cheerio.Element | undefined;
    /** value -> label of the language <select> found on the page. */
    languageOptions: Array<{ value: string; label: string }>;
    /** CSRF token fresh from the page meta. */
    csrf: string | undefined;
}

class NEUOJConfiguration implements Configuration {
    [key: string]: any;
    /** username/password (Livewire login) or cookies (browser login). */
    constructor(public credentials: any) { }
}

export class NEUOJUser implements User {
    constructor(
        public user: string,
        public password: string,
        public session: CookieJar,
    ) { }
}

export class NEUOJ implements OJ {
    readonly baseUrl = (this.config.baseUrl as string) ?? 'https://oj.neu.edu.cn';

    user!: NEUOJUser;
    private axiosConfig: AxiosRequestConfig = {};
    private cookieJar!: CookieJar;
    /** Livewire update endpoint, discovered from the login page. */
    private livewireUri: string = '/livewire/update';
    /** Session CSRF token, refreshed from every page we load. */
    private csrfToken: string = '';

    constructor(private config: NEUOJConfiguration) { }

    // ------------------------------------------------------------------ login

    async login(): Promise<NEUOJUser> {
        this.cookieJar = new CookieJar();
        this.axiosConfig = {
            jar: this.cookieJar,
            withCredentials: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        };

        const credentials = this.config.credentials ?? {};
        if (credentials.cookies) {
            // Session harvested by "OJ-Assist: Login via browser" - reuse it
            // and skip the Livewire/captcha flow entirely.
            this.storeCookies(String(credentials.cookies));
        } else if (credentials.username && credentials.password) {
            // 1. Load the login page: we need the Livewire snapshot, the update
            //    URI and the session CSRF token.
            const loginPage = await axios.get(this.baseUrl + '/login', this.axiosConfig);
            const snapshot = this.extractLoginSnapshot(loginPage.data);
            this.livewireUri = this.extractLivewireUri(loginPage.data);
            this.csrfToken = this.extractMetaCsrf(loginPage.data) ?? '';
            await this.loginWithPassword(snapshot);
        } else {
            throw new Error(
                'OJ-Assistant: neuoj needs credentials.cookies (run "OJ-Assist: Login via browser") ' +
                'or credentials.username + credentials.password in .ojassistconfig.json');
        }

        // Verify the session actually works (the login endpoint may accept the
        // request yet fail silently, e.g. wrong captcha that was not reported).
        await this.assertLoggedIn();

        this.user = new NEUOJUser(credentials.username ?? '(cookie session)', credentials.password ?? '', this.cookieJar);
        return this.user;
    }

    /** Load a cookie string ("a=1; b=2") captured from the browser. */
    private storeCookies(cookieString: string): void {
        for (const pair of cookieString.split(/;\s*/)) {
            if (!pair.trim()) { continue; }
            try {
                const cookie = Cookie.parse(pair.trim());
                if (!cookie) { continue; }
                for (const domain of ['oj.neu.edu.cn', '.oj.neu.edu.cn']) {
                    const clone = Cookie.parse(pair.trim())!;
                    clone.domain = domain;
                    clone.path = '/';
                    this.cookieJar.setCookieSync(clone, this.baseUrl + '/');
                }
            } catch { /* skip malformed pairs */ }
        }
    }

    /**
     * Drive the Livewire 3 `login.tab-login` component:
     *   GET /captcha/flat (same session) -> show the image -> ask the user for
     *   the code -> POST {livewireUri} with updates + loginWithPassword call.
     */
    private async loginWithPassword(snapshot: string): Promise<void> {
        const attempts = Math.max(1, Number(this.config.captchaAttempts ?? 3));
        let lastError = '';
        for (let i = 0; i < attempts; i++) {
            const captcha = await this.fetchAndAskCaptcha();
            const payload = {
                components: [{
                    snapshot,
                    updates: {
                        username: this.config.credentials.username,
                        password: this.config.credentials.password,
                        captcha,
                        remember: true,
                    },
                    calls: [{ path: '', method: 'loginWithPassword', params: [] }],
                }],
            };
            const response = await axios.post(
                this.baseUrl + this.livewireUri,
                payload,
                Object.assign({}, this.axiosConfig, {
                    headers: Object.assign({}, this.axiosConfig.headers, {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-Livewire': 'true',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-CSRF-TOKEN': this.csrfToken,
                        'Referer': this.baseUrl + '/login',
                    }),
                })
            );

            const errors = this.readLivewireErrors(response.data);
            if (Object.keys(errors).length === 0) {
                // Livewire sessions may rotate the CSRF token on login.
                const refreshed = await this.tryRefreshCsrf();
                if (refreshed) { this.csrfToken = refreshed; }
                return;
            }
            lastError = Object.keys(errors).map(k => (errors[k] || []).join('、')).filter(Boolean).join('；')
                || '登录失败';
            if (!/验证码|captcha/i.test(lastError)) {
                // No point retrying with a new captcha when the server
                // complains about the credentials themselves.
                throw new Error(`OJ-Assistant: NEU OJ login failed: ${lastError}`);
            }
        }
        throw new Error(`OJ-Assistant: NEU OJ login failed after ${attempts} attempts: ${lastError}`);
    }

    /** GET /captcha/flat with our session, open the image, ask for the code. */
    private async fetchAndAskCaptcha(): Promise<string> {
        const response = await axios.get(
            this.baseUrl + '/captcha/flat',
            Object.assign({}, this.axiosConfig, { responseType: 'arraybuffer' })
        );
        const captchaFile = path.join(os.tmpdir(), 'ojassist-neuoj-captcha.jpg');
        await fs.writeFile(captchaFile, Buffer.from(response.data));
        await vscode.env.openExternal(vscode.Uri.file(captchaFile));

        const code = await vscode.window.showInputBox({
            prompt: 'NEU OJ 验证码（图片已用系统查看器打开）',
            placeHolder: '输入图片中的字符',
            ignoreFocusOut: true,
        });
        if (code === undefined || code === '') {
            throw new Error('OJ-Assistant: Login cancelled (no captcha given).');
        }
        return code.trim();
    }

    private async assertLoggedIn(): Promise<void> {
        const probe = await axios.get(
            this.baseUrl + '/problems/data?page=1&per_page=1',
            Object.assign({}, this.axiosConfig, { maxRedirects: 0, validateStatus: (s: number) => s < 500 })
        );
        if (probe.status >= 300 && probe.status < 400) {
            throw new Error('OJ-Assistant: NEU OJ login did not establish a session (still redirected to /login).');
        }
    }

    private async tryRefreshCsrf(): Promise<string | undefined> {
        try {
            const page = await axios.get(this.baseUrl + '/login', this.axiosConfig);
            return this.extractMetaCsrf(page.data) ?? this.extractDataCsrf(page.data);
        } catch {
            return undefined;
        }
    }

    // --------------------------------------------------------------- problems

    async getProblem(problemInfo: ProblemInfo): Promise<Problem> {
        const page = await this.fetchProblemPage(problemInfo);
        const $ = page.$;

        // ---- Title: prefer page elements, then a cleaned <title>, then md ----
        const stripSite = (t: string) => t.trim()
            .replace(new RegExp('^F_OnlineJudge' + '\\s*[-\u2013|]?\\s*', 'i'), '')
            .replace(new RegExp('\\s*[-\u2013|]\\s*F_OnlineJudge.*$', 'i'), '')
            .trim();
        const isScoreMeta = (t: string) => /知识[：:]|思维[：:]|实现[：:]/.test(t) && /分/.test(t);
        let title = '';
        try {
            await this.ensureCatalog();
            title = this.problemCatalog?.find(p => p.id === String(problemInfo.id))?.title ?? '';
        } catch { /* catalog unavailable - fall back to page elements */ }
        if (!title) {
            title = stripSite($('.problem-title, .problem-header h1, h1').first().text() || '');
        }
        if (!title || isScoreMeta(title)) {
            const alt = stripSite($('h2, .card-title, .card-header').first().text() || '');
            title = (alt && !isScoreMeta(alt)) ? alt : '';
        }
        if (!title || isScoreMeta(title)) {
            const fromTag = stripSite($('title').first().text() || '');
            title = (fromTag && !isScoreMeta(fromTag)) ? fromTag : '';
        }

        // ---- Statement: NEU OJ stores Markdown (### sections, ``` fences) ----
        const vditorText = $('#problem-content-vditor').text().trim();
        const containerHtml = vditorText ? '' : (this.firstHtml($, [
            '.problem-description',
            '.problem-statement',
            'article .content',
            'article',
            '.card-body .problem',
            'main',
        ]) ?? $('.card-body').first().html() ?? '');
        const rawMarkdown = vditorText || cheerio.load('<div>' + containerHtml + '</div>')('div').first().text();

        const sections = splitMarkdownSections(rawMarkdown);
        if (!title) {
            const firstHeading = rawMarkdown.match(new RegExp('^#' + '{1,4}\\s+(.+)$', 'm'));
            const candidate = (firstHeading?.[1] ?? '').trim();
            title = candidate && !/题面描述|题目描述|数据范围/.test(candidate) ? candidate : '';
        }
        if (!title) { title = 'Problem ' + problemInfo.id; }

        // Samples: #### 输入样例N ``` ... ``` / #### 输出样例N ``` ... ```
        const sampleInput: string[] = [];
        const sampleOutput: string[] = [];
        const cardIn = $('#problem-input-example pre').first().text().replace(/\n$/, '');
        const cardOut = $('#problem-output-example pre').first().text().replace(/\n$/, '');
        const inBlocks: any[] = cardIn ? [{ 0: cardIn }] : [...rawMarkdown.matchAll(new RegExp('输入样例[^`]*`{3,}[\\s\\S]*?' + '`{3,}', 'g'))];
        const outBlocks: any[] = cardOut ? [{ 0: cardOut }] : [...rawMarkdown.matchAll(new RegExp('输出样例[^`]*`{3,}[\\s\\S]*?' + '`{3,}', 'g'))];
        const stripFence = (block: string) => block.replace(/^[^`]*`{3,}[\w]*\n?/, '').replace(/`{3,}\s*$/, '').replace(/\n$/, '');
        for (const b of inBlocks) { sampleInput.push(pre(escapeText(stripFence(b[0])))); }
        for (const b of outBlocks) { sampleOutput.push(escapeText(stripFence(b[0])).replace(/\n$/, '')); }
        // Remove sample sections from the description (they render separately).
        const descBody = (sections['题面描述'] ?? sections['题目描述'] ?? sections['题面'] ?? sections['描述'] ?? rawMarkdown)
            .replace(new RegExp('^#' + '{1,6}\\*输入样例[\\s\\S]*$', 'm'), '')
            .replace(new RegExp('^#' + '{1,6}\\*输出样例[\\s\\S]*$', 'm'), '');

        const inputMd = sections['输入'] ?? sections['输入格式'] ?? '';
        const outputMd = sections['输出'] ?? sections['输出格式'] ?? '';
        const noteMd = sections['数据范围'] ?? sections['说明'] ?? sections['备注'] ?? '';

        return new Problem(problemInfo.id, problemInfo.contestId, {
            title,
            desc: markdownToHtml(descBody) || '<p>(无题面内容)</p>',
            input: markdownToHtml(inputMd),
            output: markdownToHtml(outputMd),
            sampleInput: sampleInput.length ? sampleInput : [],
            sampleOutput: sampleOutput.length ? sampleOutput : [],
            note: markdownToHtml(noteMd),
        });
    }

    private async fetchProblemPage(problemInfo: ProblemInfo): Promise<ProblemPageInfo> {
        const url = problemInfo.contestId
            ? `${this.baseUrl}/contests/${problemInfo.contestId}`
            : `${this.baseUrl}/problems/${problemInfo.id}`;
        const response = await axios.get(url, this.axiosConfig);
        const html: string = typeof response.data === 'string' ? response.data : String(response.data);
        const $ = cheerio.load(html);

        // Not logged in (or the problem does not exist): Laravel redirected us.
        if (/\/login\b/.test(String(response.request?.res?.responseUrl ?? url)) || $('form wire\\:submit\\[prevent\\]').length > 0 && html.indexOf('loginWithPassword') >= 0) {
            if (html.indexOf('loginWithPassword') >= 0) {
                throw new Error('OJ-Assistant: Session expired, please run "OJ-Assist: Reload config".');
            }
        }

        this.csrfToken = this.extractMetaCsrf(html) ?? this.csrfToken;

        const submitForm = $('form').filter((i, el) => {
            const action = $(el).attr('action') ?? '';
            return /submissions?\/create|submit/i.test(action);
        }).get()[0];

        const languageOptions: Array<{ value: string; label: string }> = [];
        if (submitForm) {
            $(submitForm).find('select option').each((i, el) => {
                const value = $(el).attr('value');
                if (value !== undefined) {
                    languageOptions.push({ value, label: $(el).text().trim() });
                }
            });
        }

        return { html, $: $ as any, submitForm, languageOptions, csrf: this.csrfToken };
    }

    /**
     * Problem catalog via the PUBLIC /api/problems endpoint (works without
     * login). Downloaded once per session, then filtered/paged client side
     * because the endpoint has no keyword parameters.
     */
    private problemCatalog: Array<{ id: string; title: string; isAc: boolean; tried: boolean }> | undefined;

    /** Public /api/problems catalog (fetched once): titles + AC flags. */
    private async ensureCatalog(): Promise<void> {
        if (this.problemCatalog) { return; }
        const response = await axios.get(this.baseUrl + '/api/problems', {
            headers: { 'User-Agent': ((this.axiosConfig.headers as any)?.['User-Agent']) ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
            timeout: 180000,
        });
        const list = response.data?.data;
        this.problemCatalog = Array.isArray(list)
            ? list.map((p: any) => ({
                id: String(p.id ?? p.value),
                title: String(p.title ?? ''),
                isAc: p.is_ac === 1 || p.is_ac === true,
                tried: Number(p.my_count ?? 0) > 0,
            }))
            : [];
    }

    async searchProblems(keyword: string, page: number): Promise<ProblemListPage> {
        await this.ensureCatalog();
        const catalog = this.problemCatalog ?? [];
        const kw = keyword.trim().toLowerCase();
        const matched = kw
            ? catalog.filter(p => p.id.toLowerCase().includes(kw) || p.title.toLowerCase().includes(kw))
            : catalog;
        const pageSize = 20;
        const start = (page - 1) * pageSize;
        return {
            problems: matched.slice(start, start + pageSize).map(p => ({
                id: p.id,
                title: p.title,
                status: p.isAc ? '✓ 已AC' : (p.tried ? '已提交' : undefined),
            })),
            hasMore: start + pageSize < matched.length,
        };
    }


    listLanguages(): Array<{ value: number | string; label: string }> {
        return Object.entries((this.config.languages ?? defaultLanguageMap) as { [k: string]: number })
            .map(([ext, value]) => ({ value, label: ext.toUpperCase() + ' (' + value + ')' }));
    }

    // ---------------------------------------------------------------- submit

    async submit(sourceFile: SourceFile): Promise<Function> {
        const page = await this.fetchProblemPage({
            id: sourceFile.id,
            contestId: sourceFile.contestId,
        });
        const $ = page.$;

        const csrf = page.csrf ?? this.csrfToken;
        const body = this.buildSubmitBody(sourceFile, page);

        const response = await axios.post(
            this.baseUrl + '/submissions/create',
            body,
            Object.assign({}, this.axiosConfig, {
                headers: Object.assign({}, this.axiosConfig.headers, {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-CSRF-TOKEN': csrf,
                    'Referer': `${this.baseUrl}/problems/${sourceFile.id}`,
                    'X-Requested-With': 'XMLHttpRequest',
                }),
            })
        );

        const submissionId = this.extractSubmissionId(response.data);
        if (submissionId === undefined) {
            throw new Error(
                'OJ-Assistant: NEU OJ accepted the request but returned no submission id. ' +
                `Response: ${JSON.stringify(response.data).slice(0, 300)}`
            );
        }

        return () => this.pollSubmission(submissionId, sourceFile);
    }

    /**
     * Build the POST /submissions/create payload.
     *
     * Priority:
     *   1. config.submitBody - a template with {id} {contestId} {langId} {code}.
     *   2. hidden/visible inputs of the real <form> found on the problem page,
     *      with the language <select> resolved from its <option> list.
     *   3. a conventional default ({problem_id, language_id, code}).
     */
    private buildSubmitBody(sourceFile: SourceFile, page: ProblemPageInfo): any {
        const langId = sourceFile.languageOverride ?? this.resolveLanguageId(sourceFile.sourceType, page);

        if (this.config.submitBody && typeof this.config.submitBody === 'string') {
            return JSON.parse(
                (this.config.submitBody as string)
                    .replace(/\{id\}/g, JSON.stringify(sourceFile.id).slice(1, -1))
                    .replace(/\{contestId\}/g, JSON.stringify(sourceFile.contestId ?? '').slice(1, -1))
                    .replace(/\{langId\}/g, String(langId))
                    .replace(/\{code\}/g, JSON.stringify(sourceFile.code).slice(1, -1))
            );
        }

        if (page.submitForm) {
            const $ = page.$;
            const body: { [k: string]: any } = {};
            $(page.submitForm).find('input[name]').each((i, el) => {
                const name = $(el).attr('name')!;
                if (name === '_token') { return; }
                body[name] = $(el).attr('value') ?? '';
            });
            const selectName = $(page.submitForm).find('select[name]').attr('name');
            const textareaName = $(page.submitForm).find('textarea[name]').attr('name');

            if (selectName) { body[selectName] = langId; }
            // Prefer an obvious language field over a stray one if both exist.
            for (const key of ['language', 'language_id', 'lang', 'lang_id']) {
                if (body[key] !== undefined) { body[key] = langId; }
            }
            body[textareaName ?? 'code'] = sourceFile.code;

            if (body['problem_id'] === '' || body['problem_id'] === undefined) {
                body['problem_id'] = sourceFile.id;
            }
            if (sourceFile.contestId && body['contest_id'] === undefined) {
                body['contest_id'] = sourceFile.contestId;
            }
            return body;
        }

        const fallback: { [k: string]: any } = {
            problem_id: sourceFile.id,
            language_id: langId,
            code: sourceFile.code,
        };
        if (sourceFile.contestId) { fallback['contest_id'] = sourceFile.contestId; }
        return fallback;
    }

    /** Map a file extension to the language id the site expects. */
    private resolveLanguageId(extension: string, page: ProblemPageInfo): number | string {
        const configured = (this.config.languages ?? defaultLanguageMap)[extension];
        if (configured !== undefined) { return configured; }

        if (page.languageOptions.length > 0) {
            const ext = extension.toLowerCase();
            const keyword =
                /^(c|cc|cpp|cxx|c\+\+)$/.test(ext) ? /(c\+\+|g\+\+|cpp|c\+\+1|gcc)/i :
                /^java$/.test(ext) ? /java/i :
                /^py|^python/.test(ext) ? /python|py3/i :
                /^(js|javascript|node)$/.test(ext) ? /node|javascript|web/i :
                /^go$/.test(ext) ? /go(lang)?/i :
                /^cs|csharp$/.test(ext) ? /c#|csharp/i :
                undefined;
            if (keyword) {
                const hit = page.languageOptions.find(o => keyword.test(o.label) || keyword.test(o.value));
                if (hit) { return isNaN(Number(hit.value)) ? hit.value : Number(hit.value); }
            }
            // Last resort: first option (site default).
            return isNaN(Number(page.languageOptions[0].value))
                ? page.languageOptions[0].value
                : Number(page.languageOptions[0].value);
        }

        return configured !== undefined ? configured : (defaultLanguageMap[extension] ?? defaultLanguageMap['cpp']);
    }

    private extractSubmissionId(data: any): number | string | undefined {
        if (data === null || data === undefined) { return undefined; }
        if (typeof data === 'number' || typeof data === 'string') { return data; }
        for (const key of ['id', 'submission_id', 'submissionId', 'sid', 'record_id']) {
            if (data[key] !== undefined && data[key] !== null) { return data[key]; }
        }
        if (data.data !== undefined) { return this.extractSubmissionId(data.data); }
        return undefined;
    }

    /** Single poll of GET /api/v1/submission/{id}. */
    private async pollSubmission(id: number | string, sourceFile: SourceFile): Promise<ProblemSubmit> {
        const response = await axios.get(
            `${this.baseUrl}/api/v1/submission/${id}`,
            this.axiosConfig
        );
        const raw = String(response.data?.result ?? response.data?.status ?? 'pending');

        const submitResult = new ProblemSubmit();
        submitResult.id = Number(id) || 0;
        submitResult.pid = sourceFile.id;
        submitResult.user = this.user?.user ?? '-';
        submitResult.lang = String(sourceFile.languageOverride ?? sourceFile.sourceType);
        submitResult.date = new Date();
        submitResult.codelen = sourceFile.code.length;
        submitResult.time = String(response.data?.time ?? response.data?.exec_time ?? response.data?.real_time ?? '-');
        submitResult.memory = String(response.data?.memory ?? response.data?.mem ?? '-');
        submitResult.result = this.mapVerdict(raw);
        return submitResult;
    }

    /**
     * The status API answers with lowercase snake_case values (`pending`,
     * `judging`, `wrong_answer`, ...). The submit command loop treats these
     * three exact strings as "still running", so translate accordingly.
     */
    private mapVerdict(raw: string): string {
        const v = raw.trim().toLowerCase().replace(/\s+/g, '_');
        switch (v) {
            case 'pending':
            case 'queue':
            case 'queued':
            case 'waiting':
                return 'Pending...';
            case 'judging':
            case 'running':
            case 'compiling':
                return 'Judging...';
            case 'accepted':
            case 'ac':
            case 'ok':
            case 'success':
                return 'Accepted';
            case 'wrong_answer': case 'wa': return 'Wrong Answer';
            case 'time_limit_exceeded': case 'tle': return 'Time Limit Exceeded';
            case 'memory_limit_exceeded': case 'mle': return 'Memory Limit Exceeded';
            case 'runtime_error': case 're': return 'Runtime Error';
            case 'compile_error': case 'ce': case 'compilation_error': return 'Compile Error';
            case 'output_limit_exceeded': case 'ole': return 'Output Limit Exceeded';
            case 'presentation_error': case 'pe': return 'Presentation Error';
            case 'dangerous_code': case 'output_error': case 'system_error': case 'no_testdata':
                return v.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            default:
                return raw;
        }
    }

    // ---------------------------------------------------------------- utils

    private extractLoginSnapshot(html: string): string {
        const $ = cheerio.load(html);
        let snapshot: string | undefined;
        $('script, div').each((i, el) => {
            if (snapshot !== undefined) { return; }
            const attr = $(el).attr('wire:snapshot');
            if (!attr) { return; }
            try {
                const parsed = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
                if (parsed?.memo?.name === 'login.tab-login') {
                    // cheerio already decodes HTML entities in attribute values.
                    snapshot = attr;
                }
            } catch { /* not the component we are looking for */ }
        });
        if (snapshot === undefined) {
            // Fallback: grab any snapshot on the page whose name mentions login.
            const all = ($('div[wire\\:snapshot]').toArray()
                .map(el => $(el).attr('wire:snapshot'))
                .filter(Boolean) as string[]);
            snapshot = all.find(s => s.includes('login')) ?? all[0];
        }
        if (snapshot === undefined) {
            throw new Error('OJ-Assistant: Could not find the Livewire login component on oj.neu.edu.cn.');
        }
        return snapshot;
    }

    private extractLivewireUri(html: string): string {
        const match = html.match(/data-update-uri="([^"]+)"/);
        if (match) {
            const uri = match[1];
            try {
                const url = new URL(uri, this.baseUrl);
                return url.pathname;
            } catch {
                return uri;
            }
        }
        return '/livewire/update';
    }

    private extractMetaCsrf(html: string): string | undefined {
        return html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)?.[1]
            ?? html.match(/data-csrf="([^"]+)"/)?.[1];
    }

    private extractDataCsrf(html: string): string | undefined {
        return html.match(/data-csrf="([^"]+)"/)?.[1];
    }

    private readLivewireErrors(data: any): { [key: string]: string[] } {
        const errors: { [key: string]: string[] } = {};
        const components = data?.components;
        if (!Array.isArray(components)) { return errors; }
        for (const component of components) {
            let memoErrors = component?.snapshot && this.safeParse(component.snapshot)?.memo?.errors;
            if (!memoErrors && typeof component.snapshot === 'string') {
                memoErrors = this.safeParse(component.snapshot)?.memo?.errors;
            }
            if (memoErrors && typeof memoErrors === 'object') {
                for (const key of Object.keys(memoErrors)) {
                    const list = memoErrors[key];
                    if (Array.isArray(list) && list.length > 0) {
                        errors[key] = list.map(String);
                    }
                }
            }
            const effectErrors = component?.effects?.errors;
            if (effectErrors && typeof effectErrors === 'object') {
                for (const key of Object.keys(effectErrors)) {
                    const list = effectErrors[key];
                    errors[key] = (errors[key] ?? []).concat(Array.isArray(list) ? list.map(String) : [String(list)]);
                }
            }
        }
        return errors;
    }

    private safeParse(json: string): any | undefined {
        try { return JSON.parse(json); } catch { return undefined; }
    }

    private firstHtml($: cheerio.Root, selectors: string[]): string | undefined {
        for (const selector of selectors) {
            const el = $(selector).first();
            if (el.length > 0 && (el.html() ?? '').trim().length > 0) {
                return el.html()!;
            }
        }
        return undefined;
    }

    /**
     * Find a "标题" section in the statement: a heading element whose text is one
     * of `labels`, returning the HTML that follows it (paragraphs/pre until the
     * next heading).
     */
    private labeledSection($: cheerio.Root, labels: string[]): string | undefined {
        let result: string | undefined;
        $('h1, h2, h3, h4, h5, strong, b, .section-title, .title').each((i, el) => {
            if (result !== undefined) { return; }
            const text = $(el).text().trim().replace(/[:：\s]+$/, '');
            if (!labels.some(l => text === l || text.startsWith(l))) { return; }
            const parts: string[] = [];
            let node = $(el).next();
            while (node.length > 0) {
                const tag = node.prop('tagName')?.toUpperCase();
                if (/H[1-6]/.test(tag ?? '') || node.hasClass('section-title')) { break; }
                const html = node.html();
                if (html !== null) { parts.push(html); }
                node = node.next();
            }
            if (parts.length === 0) {
                // Heading and content wrapped inside a shared parent (e.g. .card).
                const parent = $(el).parent();
                const own = parent.html() ?? '';
                parts.push(own.replace(new RegExp(`^.*${text}`, 's'), ''));
            }
            if (parts.length > 0) { result = parts.join('\n'); }
        });
        return result;
    }

    /** Collect every sample pair from the page ("样例输入/输出" or "Sample Input/Output"). */
    private extractSamples($: cheerio.Root): Array<[string, string]> {
        const samples: Array<[string, string]> = [];

        // Layout A: paired blocks with 样例输入 / 样例输出 headings.
        const inputHeads = $('h1, h2, h3, h4, h5, strong, b, .title, .section-title').filter((i, el) =>
            /样例\s*输入|Sample\s*Input|输入样例/i.test($(el).text())
        );
        inputHeads.each((i, el) => {
            const inBlock = this.nextPreOrCode($, el);
            if (inBlock === undefined) { return; }
            // Look for the matching output heading after this input heading.
            let outBlock: string | undefined;
            let cursor = $(el).next();
            let guard = 0;
            while (cursor.length > 0 && guard++ < 30) {
                const text = cursor.text();
                if (/样例\s*输出|Sample\s*Output|输出样例/i.test(text) && cursor.find('pre, code').length > 0) {
                    outBlock = this.nextPreOrCode($, cursor);
                    break;
                }
                if (cursor.find('pre, code').length > 0 && /样例\s*输出|Sample\s*Output/i.test(cursor.next().text())) {
                    outBlock = this.nextPreOrCode($, cursor.next());
                    break;
                }
                cursor = cursor.next();
            }
            if (outBlock !== undefined) {
                samples.push([inBlock, outBlock]);
            }
        });

        if (samples.length > 0) { return samples; }

        // Layout B: every <pre> on the page, paired up in order (in, out, in, out...).
        const pres = $('pre').map((i, el) => $(el).text()).get();
        for (let i = 0; i + 1 < pres.length; i += 2) {
            samples.push([pres[i], pres[i + 1]]);
        }
        return samples;
    }

    private nextPreOrCode($: cheerio.Root, el: any): string | undefined {
        let node = $(el).next();
        let guard = 0;
        while (node.length > 0 && guard++ < 10) {
            if (node.is('pre') || node.is('code')) { return node.text(); }
            const pre = node.find('pre, code').first();
            if (pre.length > 0) { return pre.text(); }
            const tag = node.prop('tagName')?.toUpperCase() ?? '';
            if (/H[1-6]/.test(tag)) { break; }
            node = node.next();
        }
        return undefined;
    }
}


/** Split markdown into sections keyed by their `### heading` text. */
function splitMarkdownSections(md: string): { [heading: string]: string } {
    const result: { [heading: string]: string } = {};
    const re = new RegExp('^' + '#{2,4}\\s*(.+?)\\s*$', 'gm');
    const matches = [...md.matchAll(re)];
    for (let i = 0; i < matches.length; i++) {
        const heading = matches[i][1].replace(/[：:]$/, '');
        const bodyStart = matches[i].index! + matches[i][0].length;
        const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : md.length;
        if (result[heading] === undefined) {
            result[heading] = md.slice(bodyStart, bodyEnd).trim();
        }
    }
    return result;
}

function escapeText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pre(html: string): string {
    return '<pre>' + html + '</pre>';
}
