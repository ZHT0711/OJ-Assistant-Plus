import axios, { AxiosRequestConfig } from 'axios';
import axiosCookieJarSupport from '@3846masa/axios-cookiejar-support';
import { stringify as qstringify } from 'qs';
import { CookieJar, Cookie } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as vm from 'vm';
import { URL } from 'url';
import {
    OJ, User, Configuration,
    SourceFile, ProblemSubmit, Problem, ProblemInfo, ProblemListEntry, ProblemListPage
} from '../../model';

axiosCookieJarSupport(axios);

/**
 * LeetCode CN (leetcode.cn)
 *
 * Verified facts (2026-10):
 *  - Aliyun WAF "alicfw" JS challenge may intercept any request: the page ships
 *    an obfuscated script that computes a cookie from host + parm_0 + parm_1 +
 *    viewport and reloads. We execute that script inside a Node `vm` sandbox,
 *    harvest the cookies it sets and replay the request (see solveChallenge).
 *  - Problem data: POST /graphql/ query `questionData($titleSlug)` ->
 *    data.question { questionId, translatedTitle, translatedContent (HTML),
 *    exampleTestcases, codeSnippets }.
 *  - CSRF: `csrftoken` cookie is issued by GraphQL POSTs; send it back as
 *    `x-csrftoken` header for login/submit (Django CSRF).
 *  - Login: POST /accounts/login/ form-urlencoded
 *    { login, password, remember, csrfmiddlewaretoken } (+ x-csrftoken header).
 *    Failure body: { form: { errors: ["您提供的用户名或密码不正确。"] } }.
 *    Login state check: POST /graphql/noj-go `query userStatus { userStatus
 *    { isSignedIn username } }`.
 *  - Submit: POST /problems/{slug}/submit/ body { lang, typed_code,
 *    question_id } -> { submission_id }. 403 when not authenticated.
 *  - Verdict: GET /submissions/detail/{id}/check/ -> { state: PENDING |
 *    STARTED | DONE, status_msg, status_code, status_runtime, status_memory,
 *    compile_error }.
 *  - Cookies (credentials.cookies) may be pasted instead of a password login.
 */

const defaultLanguages: { [ext: string]: string } = {
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'java': 'java',
    'py': 'python3',
    'py3': 'python3',
    'python': 'python3',
    'js': 'javascript',
    'ts': 'typescript',
    'go': 'golang',
    'cs': 'csharp',
    'rs': 'rust',
    'kt': 'kotlin',
    'swift': 'swift',
    'rb': 'ruby',
    'php': 'php',
    'scala': 'scala',
    'dart': 'dart',
};

const QUESTION_QUERY = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
        questionId questionFrontendId title titleSlug
        translatedTitle content translatedContent isPaidOnly difficulty
        hints sampleTestCase exampleTestcases
    }
}`;

const USER_STATUS_QUERY = `query userStatus { userStatus { isSignedIn username isPremium } }`;

class LeetCodeConfiguration implements Configuration {
    [key: string]: any;
    constructor(public credentials: any) { }
}

export class LeetCodeUser implements User {
    constructor(
        public user: string,
        public session: CookieJar,
    ) { }
}

export class LeetCodeOJ implements OJ {
    readonly baseUrl = (this.config.baseUrl as string) ?? 'https://leetcode.cn';

    user!: LeetCodeUser;
    private axiosConfig: AxiosRequestConfig = {};
    private cookieJar!: CookieJar;
    /** questionId cache, keyed by titleSlug (needed by submit). */
    private questionIds: { [slug: string]: string } = {};

    private static readonly browserUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    constructor(private config: LeetCodeConfiguration) { }

    // ------------------------------------------------------------------ login

    async login(): Promise<LeetCodeUser> {
        this.cookieJar = new CookieJar();
        this.axiosConfig = {
            jar: this.cookieJar,
            withCredentials: true,
            headers: { 'User-Agent': LeetCodeOJ.browserUA },
        };

        const credentials = this.config.credentials ?? {};

        if (credentials.cookies) {
            this.storeCookies(String(credentials.cookies));
        } else if (credentials.username && credentials.password) {
            await this.loginWithPassword(credentials.username, credentials.password);
        } else {
            throw new Error(
                'OJ-Assistant: leetcode requires credentials.cookies (run "OJ-Assist: Login via browser") ' +
                'or credentials.username + credentials.password in .ojassistconfig.json'
            );
        }

        const status = await this.userStatus();
        if (!status.isSignedIn) {
            throw new Error(
                'OJ-Assistant: leetcode session is not signed in. ' +
                (credentials.cookies
                    ? 'Run "OJ-Assist: Login via browser (save cookies)" to refresh credentials.cookies.'
                    : 'Password login failed to establish a session; try the browser login command instead.')
            );
        }

        this.user = new LeetCodeUser(status.username ?? credentials.username ?? '(unknown)', this.cookieJar);
        return this.user;
    }

    private async loginWithPassword(username: string, password: string): Promise<void> {
        // Django issues `csrftoken` on GraphQL POSTs; we need it before the
        // login POST (csrfmiddlewaretoken + x-csrftoken must match).
        await this.request('post', `${this.baseUrl}/graphql/`, {
            data: { query: USER_STATUS_QUERY },
            headers: { 'Content-Type': 'application/json', 'Origin': this.baseUrl },
            validateStatus: () => true,
        });
        const csrf = this.cookieValue('csrftoken');
        if (!csrf) {
            throw new Error('OJ-Assistant: could not obtain a leetcode csrftoken cookie.');
        }

        const response = await this.request('post', `${this.baseUrl}/accounts/login/`, {
            data: qstringify({
                login: username,
                password,
                remember: 'true',
                csrfmiddlewaretoken: csrf,
            }),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Referer': `${this.baseUrl}/accounts/login/`,
                'Origin': this.baseUrl,
                'x-csrftoken': csrf,
            },
            validateStatus: (s: number) => s < 500,
        });

        const errors = response.data?.form?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
            throw new Error(`OJ-Assistant: leetcode login failed: ${errors.join('；')}`);
        }
        if (response.status === 403) {
            throw new Error('OJ-Assistant: leetcode login was blocked (403), likely the Aliyun captcha. ' +
                'Paste credentials.cookies from your browser instead.');
        }
    }

    private async userStatus(): Promise<{ isSignedIn: boolean; username?: string }> {
        const response = await this.request('post', `${this.baseUrl}/graphql/noj-go`, {
            data: { query: USER_STATUS_QUERY },
            headers: { 'Content-Type': 'application/json', 'Origin': this.baseUrl, 'Referer': this.baseUrl + '/' },
            validateStatus: (s: number) => s < 500,
        });
        const status = response.data?.data?.userStatus;
        if (!status) {
            throw new Error('OJ-Assistant: leetcode userStatus query failed: ' +
                JSON.stringify(response.data ?? {}).slice(0, 200));
        }
        return { isSignedIn: !!status.isSignedIn, username: status.username };
    }

    private storeCookies(cookieString: string): void {
        for (const pair of cookieString.split(/;\s*/)) {
            if (!pair.trim()) { continue; }
            try {
                const parsed = Cookie.parse(pair.trim());
                if (!parsed) { continue; }
                for (const domain of ['leetcode.cn', '.leetcode.cn', 'www.leetcode.cn']) {
                    const clone = Cookie.parse(pair.trim())!;
                    clone.domain = domain;
                    clone.path = '/';
                    this.cookieJar.setCookieSync(clone, this.baseUrl + '/');
                }
            } catch { /* skip malformed pairs */ }
        }
    }

    private cookieValue(name: string): string | undefined {
        return this.cookieJar.getCookiesSync(this.baseUrl + '/')
            .find(c => c.key === name)?.value;
    }

    // --------------------------------------------------- http + WAF challenge

    /**
     * axios wrapper that detects the Aliyun `alicfw` JS challenge (served with
     * HTTP 200 as an HTML page) and transparently solves it by executing the
     * bundled script in a VM sandbox, then replaying the original request.
     */
    private async request(method: 'get' | 'post', url: string, options: AxiosRequestConfig): Promise<any> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const config: AxiosRequestConfig = Object.assign({}, this.axiosConfig, options, {
                headers: Object.assign({}, this.axiosConfig.headers, options.headers),
            });
            const response = await axios.request(Object.assign({ method, url }, config));

            if (typeof response.data === 'string' && isWafChallenge(response.data)) {
                const host = new URL(url).host;
                const cookies = solveWafChallenge(response.data, host);
                for (const pair of cookies) {
                    this.storeChallengeCookie(pair);
                }
                continue; // replay with the solved cookies
            }
            return response;
        }
        throw new Error('OJ-Assistant: leetcode kept returning the Aliyun WAF challenge after several attempts.');
    }

    private storeChallengeCookie(pair: string): void {
        try {
            const parsed = Cookie.parse(pair.split(';')[0]);
            if (parsed) {
                parsed.domain = 'leetcode.cn';
                parsed.path = '/';
                this.cookieJar.setCookieSync(parsed, this.baseUrl + '/');
            }
        } catch { /* ignore malformed challenge cookies */ }
    }

    // --------------------------------------------------------------- problems

    async getProblem(problemInfo: ProblemInfo): Promise<Problem> {
        const slug = problemInfo.id;
        const response = await this.request('post', `${this.baseUrl}/graphql/`, {
            data: { query: QUESTION_QUERY, variables: { titleSlug: slug } },
            headers: {
                'Content-Type': 'application/json',
                'Origin': this.baseUrl,
                'Referer': `${this.baseUrl}/problems/${slug}/`,
            },
        });
        const question = response.data?.data?.question;
        if (!question) {
            throw new Error(`OJ-Assistant: leetcode question "${slug}" not found: ` +
                JSON.stringify(response.data ?? {}).slice(0, 200));
        }
        this.questionIds[slug] = String(question.questionId);

        const html = question.translatedContent || question.content || '';
        const $ = cheerio.load(html || '<p></p>');

        // Pull the samples out of the statement: each <pre> holds
        //   <strong>输入：</strong>...\n<strong>输出：</strong>...
        const sampleInput: string[] = [];
        const sampleOutput: string[] = [];
        $('pre').each((i, el) => {
            const text = $(el).text();
            const inMatch = text.match(/^\s*输入[:：]\s*([\s\S]*?)(?=\n\s*输出[:：]|$)/);
            const outMatch = text.match(/输出[:：]\s*([\s\S]*?)(?=\n\s*解释[:：]|$)/);
            if (inMatch || outMatch) {
                sampleInput.push('<pre>' + escapeHtml((inMatch?.[1] ?? '').replace(/\n$/, '')) + '</pre>');
                sampleOutput.push(escapeHtml((outMatch?.[1] ?? '').replace(/\n$/, '')));
                // Remove the example block from the statement to avoid showing
                // every sample twice (the view renders them separately).
                $(el).prev('p').remove();
                $(el).remove();
            }
        });

        const difficulty = question.difficulty ?? '';
        const hints: string[] = Array.isArray(question.hints) ? question.hints : [];
        const noteParts: string[] = [];
        if (difficulty) { noteParts.push(`<p><strong>难度：</strong>${escapeHtml(difficulty)}</p>`); }
        hints.forEach((hint: string, i: number) => {
            noteParts.push(`<p><strong>提示 ${i + 1}：</strong>${escapeHtml(hint)}</p>`);
        });

        return new Problem(slug, problemInfo.contestId, {
            title: `${question.questionFrontendId ?? ''} ${question.translatedTitle ?? question.title ?? slug}`.trim(),
            desc: $.html()!.replace(/^<html><head><\/head><body>|<\/body><\/html>$/g, ''),
            input: '',
            output: '',
            sampleInput: sampleInput.length > 0 ? sampleInput : [''],
            sampleOutput: sampleOutput.length > 0 ? sampleOutput : [''],
            note: noteParts.join('\n'),
        });
    }

    /** Problem set search through the public questionList GraphQL query. */
    async searchProblems(keyword: string, page: number): Promise<ProblemListPage> {
        const pageSize = 20;
        // CN schema (2026): problemsetQuestionList takes QuestionListFilterInput
        // (searchKeywords works); each node is a QuestionLightNode carrying
        // only title/titleSlug/difficulty - no frontend id field.
        const query = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
            problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
                total
                questions { frontendQuestionId title titleSlug difficulty status }
            }
        }`;
        const response = await this.request('post', `${this.baseUrl}/graphql/`, {
            data: {
                query,
                variables: {
                    categorySlug: '',
                    limit: pageSize,
                    skip: (page - 1) * pageSize,
                    filters: keyword.trim() ? { searchKeywords: keyword.trim() } : {},
                },
            },
            headers: {
                'Content-Type': 'application/json',
                'Origin': this.baseUrl,
                'Referer': `${this.baseUrl}/problemset/algorithms/`,
            },
        });
        const data = response.data?.data?.problemsetQuestionList;
        const questions = data?.questions ?? [];
        const total = Number(data?.total ?? 0);
        return {
            problems: questions.map((q: any) => ({
                id: String(q.titleSlug),
                title: (q.frontendQuestionId ? q.frontendQuestionId + '. ' : '') + String(q.title ?? q.titleSlug),
                difficulty: q.difficulty ? String(q.difficulty) : undefined,
                status: q.status === 'AC' ? '✓ 已AC' : (q.status === 'TODO' ? '未做' : undefined),
            })),
            hasMore: (page - 1) * pageSize + questions.length < total,
        };
    }


    listLanguages(): Array<{ value: string; label: string }> {
        return [
            { value: 'cpp', label: 'C++' }, { value: 'c', label: 'C' },
            { value: 'java', label: 'Java' }, { value: 'python3', label: 'Python3' },
            { value: 'javascript', label: 'JavaScript' }, { value: 'typescript', label: 'TypeScript' },
            { value: 'golang', label: 'Go' }, { value: 'csharp', label: 'C#' },
            { value: 'kotlin', label: 'Kotlin' }, { value: 'swift', label: 'Swift' },
            { value: 'rust', label: 'Rust' }, { value: 'ruby', label: 'Ruby' },
            { value: 'php', label: 'PHP' }, { value: 'scala', label: 'Scala' },
        ];
    }

    // ---------------------------------------------------------------- submit

    async submit(sourceFile: SourceFile): Promise<Function> {
        const slug = sourceFile.id;

        if (!this.questionIds[slug]) {
            // Make sure we know the numeric questionId the submit API wants.
            await this.getProblem({ id: slug, contestId: sourceFile.contestId });
        }
        const questionId = this.questionIds[slug];
        const lang = String(sourceFile.languageOverride ?? (this.config.languages ?? defaultLanguages)[sourceFile.sourceType] ?? sourceFile.sourceType);

        const csrf = this.cookieValue('csrftoken');
        const response = await this.request('post', `${this.baseUrl}/problems/${slug}/submit/`, {
            data: {
                lang,
                typed_code: sourceFile.code,
                question_id: questionId,
            },
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Origin': this.baseUrl,
                'Referer': `${this.baseUrl}/problems/${slug}/`,
            }, csrf ? { 'x-csrftoken': csrf } : {}),
            validateStatus: (s: number) => s < 500,
        });

        if (response.status === 403) {
            throw new Error('OJ-Assistant: leetcode submit rejected (403 User is not authenticated) - ' +
                'check your login/cookies.');
        }
        if (response.status >= 400) {
            throw new Error(`OJ-Assistant: leetcode submit failed (HTTP ${response.status}): ` +
                JSON.stringify(response.data ?? '').slice(0, 300));
        }

        const submissionId = response.data?.submission_id ?? response.data?.record_id;
        if (submissionId === undefined) {
            throw new Error('OJ-Assistant: leetcode submit returned no submission_id: ' +
                JSON.stringify(response.data ?? '').slice(0, 300));
        }

        return () => this.checkSubmission(submissionId, sourceFile, lang);
    }

    private async checkSubmission(submissionId: any, sourceFile: SourceFile, lang: string): Promise<ProblemSubmit> {
        const response = await this.request('get',
            `${this.baseUrl}/submissions/detail/${submissionId}/check/`, {
            headers: { 'Accept': 'application/json', 'Referer': `${this.baseUrl}/problems/${sourceFile.id}/` },
            validateStatus: (s: number) => s < 500,
        });
        const data = response.data ?? {};

        const result = new ProblemSubmit();
        result.id = Number(submissionId) || 0;
        result.pid = sourceFile.id;
        result.user = this.user?.user ?? '-';
        result.lang = data.pretty_lang ?? data.lang ?? lang;
        result.date = new Date();
        result.codelen = sourceFile.code.length;
        result.time = data.status_runtime ?? '-';
        result.memory = data.status_memory ?? '-';

        const state = String(data.state ?? '').toUpperCase();
        if (state === 'PENDING' || state === 'STARTED') {
            result.result = state === 'PENDING' ? 'Pending...' : 'Judging...';
        } else {
            result.result = this.mapVerdict(data);
        }
        return result;
    }

    private mapVerdict(data: any): string {
        if (data.status_msg) {
            const msg = String(data.status_msg);
            // status_msg is already human readable ("Accepted", "Time Limit
            // Exceeded", "Compile Error", ...). Normalize the pending states.
            if (/pending/i.test(msg)) { return 'Pending...'; }
            if (/running|judg/i.test(msg)) { return 'Judging...'; }
            return msg;
        }
        // Fallback: leetcode status_code -> verdict (10 AC, 11 WA, 12 MLE,
        // 13 OLE, 14 TLE, 15 RE, 17 CE, 20 ???).
        const byCode: { [code: number]: string } = {
            10: 'Accepted',
            11: 'Wrong Answer',
            12: 'Memory Limit Exceeded',
            13: 'Output Limit Exceeded',
            14: 'Time Limit Exceeded',
            15: 'Runtime Error',
            16: 'Internal Error',
            17: 'Compile Error',
        };
        return byCode[Number(data.status_code)] ?? `Status #${data.status_code ?? '?'}`;
    }
}

// ------------------------------------------------------------ WAF challenge

function isWafChallenge(html: string): boolean {
    return html.includes('hash32') && html.includes('check()') && html.includes('parm_0');
}

/**
 * Execute the Aliyun `alicfw` challenge script in a sandbox that mimics the
 * DOM bits it touches (getElementById/cookie/location/documentElement) and
 * return the `name=value` pairs it tries to set via document.cookie.
 *
 * The computed value is bound to the challenge's parm_1, so the caller must
 * solve the exact page it just received and replay promptly.
 */
function solveWafChallenge(html: string, host: string, clientWidth = 1600, clientHeight = 900): string[] {
    const parms: { [id: string]: string } = {};
    for (const m of html.matchAll(/value=\s*([0-9]+)\s*id="(parm_\d+)"/g)) {
        parms[m[2]] = m[1];
    }
    if (!parms['parm_0']) {
        throw new Error('OJ-Assistant: WAF challenge page without parm_0, cannot solve it.');
    }

    const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
        .map(m => m[1])
        .filter(s => s.includes('hash32'));
    if (scripts.length === 0) {
        throw new Error('OJ-Assistant: WAF challenge script not found in response.');
    }

    const cookies: string[] = [];
    const location = { host, protocol: 'https:', reload: () => { /* no-op */ }, href: `https://${host}/` };
    const document: any = {
        location,
        documentElement: { clientWidth, clientHeight },
        getElementById: (id: string) => ({ value: parms[id] ?? '' }),
        querySelector: () => null,
    };
    Object.defineProperty(document, 'cookie', {
        get: () => cookies.join('; '),
        set: (value: string) => { cookies.push(String(value).split(';')[0]); },
    });

    const sandbox: any = {
        document,
        location,
        window: { location },
        console: { log: () => { /* silence page logging */ } },
        escape, unescape, parseInt, isNaN, Date, Math,
    };
    vm.createContext(sandbox);
    vm.runInContext(scripts.join('\n') + '\ncheck();', sandbox, { timeout: 5000 });

    if (cookies.length === 0) {
        throw new Error('OJ-Assistant: WAF challenge script produced no cookies.');
    }
    return cookies;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
