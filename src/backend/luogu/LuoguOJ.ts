import axios, { AxiosRequestConfig } from 'axios';
import axiosCookieJarSupport from '@3846masa/axios-cookiejar-support';
import { CookieJar, Cookie } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as vscode from 'vscode';
import {
    OJ, User, Configuration,
    SourceFile, ProblemSubmit, Problem, ProblemInfo, ProblemListEntry, ProblemListPage
} from '../../model';
import { markdownToHtml } from '../../utils';

axiosCookieJarSupport(axios);

/**
 * Luogu (www.luogu.com.cn)
 *
 * Verified facts (2026-10):
 *  - Anti-bot: first request may 302 and set a `C3VK` CDN cookie; retry with
 *    the cookie (the jar handles this - we follow manually, never -L).
 *  - Problem JSON: GET /problem/{pid} with header `x-lentille-request:
 *    content-only` -> { data: { problem: { name, content{...}, samples,
 *    acceptLanguages } } }. Statement is Markdown.
 *  - CSRF: <meta name="csrf-token"> on the problem page, sent as
 *    `X-CSRF-TOKEN` header; scoped per path (take it from the target page).
 *  - Submit: POST /fe/api/problem/submit/{pid} body {code, lang, enableO2},
 *    requires login (403 UserNotLoggedInException otherwise).
 *  - Verdicts: GET /record/{id} (content-only) -> status number:
 *    0 Waiting, 1 Judging, 2 CE, 3 OLE, 4 MLE, 5 TLE, 6 WA, 7 RE, 11 UKE,
 *    12 Accepted, 14 No Any Output.
 *  - Login is protected by Cloudflare Turnstile, so automated password login
 *    is not feasible: we take the session cookies (_uid + __client_id) that
 *    the user copies from an already logged-in browser.
 */

/** Luogu CodeLanguage ids from /_lfe/config (overridable via config.languages). */
const defaultLanguages: { [ext: string]: number } = {
    'c': 2,
    'cpp': 4,
    'cc': 4,
    'cxx': 4,
    'py': 7,
    'py3': 7,
    'python': 7,
    'java': 8,
    'js': 9,
    'node': 9,
    'pas': 1,
    'pascal': 1,
};

const recordStatuses: { [code: number]: string } = {
    0: 'Pending...',
    1: 'Judging...',
    2: 'Compile Error',
    3: 'Output Limit Exceeded',
    4: 'Memory Limit Exceeded',
    5: 'Time Limit Exceeded',
    6: 'Wrong Answer',
    7: 'Runtime Error',
    11: 'Unknown Error',
    12: 'Accepted',
    14: 'No Any Output',
    21: 'Hacked',
    22: 'Hacked',
};

class LuoguConfiguration implements Configuration {
    [key: string]: any;
    constructor(public credentials: any) { }
}

export class LuoguUser implements User {
    constructor(
        public user: string,
        public cookieHeader: string,
        public session: CookieJar,
    ) { }
}

export class LuoguOJ implements OJ {
    readonly baseUrl = (this.config.baseUrl as string) ?? 'https://www.luogu.com.cn';

    user!: LuoguUser;
    private axiosConfig: AxiosRequestConfig = {};
    private cookieJar!: CookieJar;

    constructor(private config: LuoguConfiguration) { }

    // ------------------------------------------------------------------ login

    async login(): Promise<LuoguUser> {
        this.cookieJar = new CookieJar();
        this.axiosConfig = {
            jar: this.cookieJar,
            withCredentials: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            },
        };

        let cookieString = (this.config.credentials?.cookies ?? '').trim();
        if (!cookieString) {
            cookieString = await this.askForCookies();
        }
        this.storeCookies(cookieString);

        const uid = this.cookieValue('_uid');
        if (!uid || uid === '0') {
            throw new Error(
                'OJ-Assistant: luogu session is not logged in (_uid missing or 0). ' +
                'Run "OJ-Assist: Login via browser (save cookies)", or log in on www.luogu.com.cn ' +
                'and paste the Cookie header into credentials.cookies.'
            );
        }

        this.user = new LuoguUser(uid, cookieString, this.cookieJar);
        return this.user;
    }

    private async askForCookies(): Promise<string> {
        await vscode.env.openExternal(vscode.Uri.parse(this.baseUrl + '/auth/login'));
        const cookieString = await vscode.window.showInputBox({
            prompt: '推荐：运行命令 "OJ-Assist: Login via browser (save cookies)" 自动获取 Cookie。' +
                '或在浏览器登录洛谷后按 F12 -> Network -> 任意请求 -> Request Headers，粘贴整段 Cookie：',
            placeHolder: 'C3VK=...; __client_id=...; _uid=...',
            ignoreFocusOut: true,
        });
        if (!cookieString) {
            throw new Error('OJ-Assistant: luogu login cancelled (no cookies provided).');
        }
        return cookieString;
    }

    private storeCookies(cookieString: string): void {
        for (const pair of cookieString.split(/;\s*/)) {
            if (!pair.trim()) { continue; }
            try {
                const cookie = Cookie.parse(pair.trim());
                if (cookie) {
                    // Store for both the bare and leading-dot domains so that
                    // tough-cookie matches www.luogu.com.cn requests.
                    for (const domain of ['www.luogu.com.cn', '.luogu.com.cn']) {
                        const clone = Cookie.parse(pair.trim())!;
                        clone.domain = domain;
                        clone.path = '/';
                        this.cookieJar.setCookieSync(clone, this.baseUrl + '/');
                    }
                }
            } catch { /* skip malformed pairs */ }
        }
    }

    private cookieValue(name: string): string | undefined {
        const cookies = this.cookieJar.getCookiesSync(this.baseUrl + '/');
        return cookies.find(c => c.key === name)?.value;
    }

    // ---------------------------------------------------- luogu http plumbing

    /**
     * GET that survives the C3VK CDN challenge: the first hit may 302 with a
     * Set-Cookie, the retry with the jar cookie answers 200. Never follow
     * redirects automatically (the challenge can loop).
     */
    private async luoguGet(url: string, headers: { [k: string]: string }, responseType?: 'arraybuffer'): Promise<any> {
        let lastStatus = 0;
        for (let attempt = 0; attempt < 5; attempt++) {
            const config: AxiosRequestConfig = Object.assign({}, this.axiosConfig, {
                headers: Object.assign({}, this.axiosConfig.headers, headers),
                maxRedirects: 0,
                validateStatus: (s: number) => s < 500,
                responseType,
            });
            const response = await axios.get(url, config);
            lastStatus = response.status;
            if (response.status === 302 || response.status === 401) {
                // 302: CDN challenge or login redirect - jar just got C3VK (or
                // needs one), retry. 401 on /record/* means cookies expired.
                if (response.status === 401) {
                    throw new Error('OJ-Assistant: luogu rejected the session (401) - refresh credentials.cookies.');
                }
                continue;
            }
            if (response.status >= 400) {
                throw new Error(`OJ-Assistant: luogu GET ${url} failed with HTTP ${response.status}`);
            }
            return response.data;
        }
        throw new Error(`OJ-Assistant: luogu GET ${url} stuck on the C3VK challenge (last status ${lastStatus}).`);
    }

    private async getProblemJson(pid: string): Promise<any> {
        const data = await this.luoguGet(
            `${this.baseUrl}/problem/${pid}`,
            { 'x-lentille-request': 'content-only', 'Accept': 'application/json' }
        );
        if (typeof data === 'string') {
            // Challenge answered with HTML: the payload sits in lentille-context.
            const match = data.match(/<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/);
            if (match) { return JSON.parse(match[1]); }
            throw new Error(`OJ-Assistant: luogu returned HTML instead of JSON for ${pid}.`);
        }
        return data;
    }

    // --------------------------------------------------------------- problems

    async getProblem(problemInfo: ProblemInfo): Promise<Problem> {
        const pid = problemInfo.id.toUpperCase();
        const payload = await this.getProblemJson(pid);
        const problem = payload?.data?.problem ?? payload?.currentData?.problem;
        if (!problem) {
            throw new Error(`OJ-Assistant: luogu returned no problem data for ${pid}: ` +
                JSON.stringify(payload).slice(0, 200));
        }

        const content = problem.contenu ?? problem.content ?? {};
        const sections: string[] = [];
        if (content.background) { sections.push(`<p><strong>背景</strong></p>\n${markdownToHtml(content.background)}`); }
        if (content.description) { sections.push(markdownToHtml(content.description)); }
        const desc = sections.join('\n') || markdownToHtml(content.description ?? '');

        const samples: string[][] = Array.isArray(problem.samples) ? problem.samples : [];

        return new Problem(pid, problemInfo.contestId, {
            title: `${problem.pid} ${problem.name ?? ''}`.trim(),
            desc,
            input: markdownToHtml(content.formatI ?? ''),
            output: markdownToHtml(content.formatO ?? ''),
            sampleInput: samples.map(s => String(Array.isArray(s) ? (s[0] ?? '') : s)),
            sampleOutput: samples.map(s => String(Array.isArray(s) ? (s[1] ?? '') : s)),
            note: markdownToHtml(content.hint ?? ''),
        });
    }

    /** Problem list via the Lentille content-only JSON endpoint. */
    async searchProblems(keyword: string, page: number): Promise<ProblemListPage> {
        const params = new URLSearchParams({ page: String(page) });
        if (keyword.trim()) { params.set('keyword', keyword.trim()); }
        const data = await this.luoguGet(
            `${this.baseUrl}/problem/list?${params.toString()}`,
            { 'x-lentille-request': 'content-only', 'Accept': 'application/json' }
        );
        // Lentille shape: data.problems = { perPage, count, result: [...] }
        const box = data?.data?.problems ?? data?.currentData?.problems ?? {};
        const problems: any[] = Array.isArray(box) ? box : (box.result ?? []);
        const count = Number(Array.isArray(box) ? problems.length : (box.count ?? 0));
        const perPage = Number(Array.isArray(box) ? 20 : (box.perPage ?? 20)) || 20;
        return {
            problems: problems.map((p: any) => ({
                id: String(p.pid ?? p.id),
                title: String(p.name ?? ''),
                difficulty: p.difficulty !== undefined && p.difficulty !== null ? String(p.difficulty) : undefined,
                status: p.accepted ? '✓ 已AC' : (p.submitted ? '已提交' : undefined),
            })),
            hasMore: page * perPage < count,
        };
    }


    // ---------------------------------------------------------------- submit

    async submit(sourceFile: SourceFile): Promise<Function> {
        const pid = sourceFile.id.toUpperCase();

        // The CSRF token is path scoped: fetch the *problem page* HTML first.
        const pageHtml = await this.luoguGet(`${this.baseUrl}/problem/${pid}`, { 'Accept': 'text/html' });
        const csrf = typeof pageHtml === 'string'
            ? pageHtml.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)?.[1]
            : undefined;
        if (!csrf) {
            throw new Error('OJ-Assistant: could not extract the luogu CSRF token (session may have expired).');
        }

        // Prefer a language the problem actually accepts.
        let payload: any;
        try {
            payload = await this.getProblemJson(pid);
        } catch { payload = undefined; }
        const acceptLanguages: number[] = payload?.data?.problem?.acceptLanguages ?? [];
        const lang = this.pickLanguage(sourceFile.sourceType, acceptLanguages);

        const submitUrl = `${this.baseUrl}/fe/api/problem/submit/${pid}`;
        const config: AxiosRequestConfig = Object.assign({}, this.axiosConfig, {
            headers: Object.assign({}, this.axiosConfig.headers, {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-CSRF-TOKEN': csrf,
                'Referer': `${this.baseUrl}/problem/${pid}`,
                'Origin': this.baseUrl,
                'x-lentille-request': 'content-only',
            }),
            maxRedirects: 0,
            validateStatus: (s: number) => s < 500,
        });
        const response = await axios.post(submitUrl, {
            code: sourceFile.code,
            lang,
            enableO2: 0,
        }, config);

        if (response.status === 403) {
            const msg = JSON.stringify(response.data ?? {}).slice(0, 200);
            throw new Error(`OJ-Assistant: luogu submit rejected (403 ${msg}). Refresh credentials.cookies.`);
        }
        if (response.status >= 400) {
            throw new Error(`OJ-Assistant: luogu submit failed (HTTP ${response.status}): ` +
                JSON.stringify(response.data ?? '').slice(0, 300));
        }

        const recordId = this.extractRecordId(response.data);
        if (recordId === undefined) {
            throw new Error('OJ-Assistant: luogu submit accepted but returned no record id: ' +
                JSON.stringify(response.data).slice(0, 300));
        }

        return () => this.pollRecord(recordId, sourceFile, lang);
    }

    private pickLanguage(extension: string, acceptLanguages: number[]): number {
        const configured = (this.config.languages ?? defaultLanguages)[extension];
        const pool = acceptLanguages.length > 0 ? acceptLanguages : undefined;
        if (configured !== undefined) {
            if (!pool || pool.includes(configured)) { return configured; }
            // Fall back to any accepted language from the same family.
            const family = this.languageFamily(extension);
            const near = pool.find(id => family.includes(id));
            if (near !== undefined) { return near; }
            return configured;
        }
        if (pool && pool.length > 0) { return pool[0]; }
        return defaultLanguages[extension] ?? defaultLanguages['cpp'];
    }

    private languageFamily(extension: string): number[] {
        const ext = extension.toLowerCase();
        if (/^(c|cc|cpp|cxx)$/.test(ext)) { return [3, 4, 11, 12, 13, 14]; }   // C++ family
        if (/^py|^python/.test(ext)) { return [7]; }                          // Python3
        if (/^java$/.test(ext)) { return [8]; }                               // Java
        if (/^(js|node)$/.test(ext)) { return [9]; }                          // Node.js
        if (/^pas/.test(ext)) { return [1]; }                                 // Pascal
        if (/^c$/.test(ext)) { return [2]; }                                  // C
        return [];
    }

    private extractRecordId(data: any): number | string | undefined {
        if (data === null || data === undefined) { return undefined; }
        if (typeof data === 'number') { return data; }
        if (typeof data === 'string' && /^\d+$/.test(data)) { return data; }
        for (const key of ['id', 'rid', 'recordId', 'submissionId', 'submission_id']) {
            if (data[key] !== undefined && data[key] !== null) { return data[key]; }
        }
        if (data.record !== undefined) { return this.extractRecordId(data.record); }
        if (data.data !== undefined) { return this.extractRecordId(data.data); }
        return undefined;
    }

    private async pollRecord(recordId: number | string, sourceFile: SourceFile, lang: number): Promise<ProblemSubmit> {
        const data = await this.luoguGet(
            `${this.baseUrl}/record/${recordId}`,
            { 'x-lentille-request': 'content-only', 'Accept': 'application/json' }
        );
        const record = data?.data?.record ?? data?.data ?? data?.currentData?.record ?? data ?? {};
        const status = Number(this.firstOf(record, ['status', 'status.code']) ?? 0);

        const submitResult = new ProblemSubmit();
        submitResult.id = Number(recordId) || 0;
        submitResult.pid = sourceFile.id;
        submitResult.user = String(record.user?.uid ?? this.user?.user ?? '-');
        submitResult.lang = String(record.language ?? lang);
        const timestamp = record.submitTime ?? record.createTime;
        submitResult.date = timestamp ? new Date(Number(timestamp) * 1000) : new Date();
        submitResult.time = record.time !== undefined ? `${record.time}ms` : '-';
        submitResult.memory = record.memory !== undefined ? `${Math.round(Number(record.memory) / 1024)}MB` : '-';
        submitResult.codelen = sourceFile.code.length;
        submitResult.result = recordStatuses[status] ?? `Status #${status}`;
        return submitResult;
    }

    private firstOf(obj: any, keys: string[]): any {
        for (const key of keys) {
            let cursor = obj;
            let ok = true;
            for (const seg of key.split('.')) {
                if (cursor && typeof cursor === 'object' && seg in cursor) { cursor = cursor[seg]; }
                else { ok = false; break; }
            }
            if (ok && cursor !== undefined && cursor !== null) { return cursor; }
        }
        return undefined;
    }
}
