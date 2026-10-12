import axios, { AxiosRequestConfig } from 'axios';
import axiosCookieJarSupport from '@3846masa/axios-cookiejar-support';
import { stringify as qstringify } from 'qs';
import { CookieJar, Cookie } from 'tough-cookie';
import * as cheerio from 'cheerio';
import {
    OJ, User, Configuration,
    SourceFile, ProblemSubmit, Problem, ProblemInfo,
    ProblemListEntry, ProblemListPage
} from '../../model';

axiosCookieJarSupport(axios);

/**
 * HDOJ - Hangzhou Dianzi University Online Judge (acm.hdu.edu.cn).
 *
 * Verified by anonymous probing (2026-10, pages are GB18030-encoded PHP):
 *  - Login: POST /userloginex.php?action=login { username, userpass } - NO captcha.
 *  - Problem page: GET /showproblem.php?pid=N -> <h1> title + .panel_title /
 *    .panel_content sections (Description / Input / Output / Sample Input /
 *    Sample Output / Author).
 *  - Browse: GET /listproblem.php?vol=N (74 volumes x100) renders rows via
 *    inline JS calls p(status,pid,_,title,ac,sub).
 *  - Search: GET /search.php?field=problem&key=<kw> -> rows
 *    <a href="/showproblem.php?pid=N">Title</a> plus a "Total Problem: n".
 *  - Languages (authoritative from status.php filter):
 *      1=G++ 2=GCC 3=C++ 4=C 5=Pascal 6=Java 7=C#
 *  - Submit: GET /submit.php?pid=N (after login) -> parse the REAL form, then
 *    POST it back with language + code (same runtime-form strategy as CSECG).
 *  - Verdict: GET /status.php?user=<me>&pid=<pid>&lang=<lang>&last=1 ->
 *    first <tr align=center> row: runId / time / <font>verdict</font> /
 *    pid / ms / K / B / language / author.
 * All responses are decoded with TextDecoder('gb18030').
 */

const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** ext -> HDU language id (from the status.php filter, authoritative). */
const defaultLanguages: { [ext: string]: number } = {
    'cpp': 1, 'cc': 1, 'cxx': 1,   // G++
    'c': 4,                        // C
    'java': 6,
    'pas': 5, 'pascal': 5,
    'cs': 7,
    'gcc': 2,
};

const GB = new TextDecoder('gb18030');

class HDOJConfiguration implements Configuration {
    [key: string]: any;
    constructor(public credentials: any) { }
}

export class HDOJUser implements User {
    constructor(
        public user: string,
        public password: string,
        public session: CookieJar,
    ) { }
}

export class HDOJ implements OJ {
    readonly baseUrl = String((this.config.baseUrl as string) ?? 'http://acm.hdu.edu.cn').replace(/\/+$/, '');

    user!: HDOJUser;
    private axiosConfig: AxiosRequestConfig = {};
    private cookieJar!: CookieJar;
    /** Cached problem set volume count (parsed from listproblem nav). */
    private volumeCount = 0;

    constructor(private config: HDOJConfiguration) { }

    // ------------------------------------------------------------------ login

    async login(): Promise<HDOJUser> {
        this.cookieJar = new CookieJar();
        this.axiosConfig = {
            jar: this.cookieJar,
            withCredentials: true,
            headers: { 'User-Agent': browserUA },
        };

        const credentials = this.config.credentials ?? {};
        if (credentials.cookies) {
            this.storeCookies(String(credentials.cookies));
        } else if (credentials.username && credentials.password) {
            const response = await axios.post(
                this.baseUrl + '/userloginex.php?action=login',
                qstringify({ username: credentials.username, userpass: credentials.password }),
                Object.assign({}, this.axiosConfig, {
                    headers: Object.assign({}, this.axiosConfig.headers, {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': this.baseUrl + '/',
                    }),
                    maxRedirects: 0,
                    validateStatus: (s: number) => s >= 200 && s < 400,
                })
            );
            // Wrong credentials answer with an error page instead of a redirect.
            if (response.status >= 400) {
                throw new Error('OJ-Assistant: HDOJ login failed (HTTP ' + response.status + ').');
            }
        } else {
            throw new Error(
                'OJ-Assistant: hdoj requires credentials.cookies (run "OJ-Assist: Login via browser") ' +
                'or credentials.username + credentials.password in .ojassistconfig.json');
        }

        await this.assertSessionAlive();
        this.user = new HDOJUser(credentials.username ?? '(session)', credentials.password ?? '', this.cookieJar);
        return this.user;
    }

    private storeCookies(cookieString: string): void {
        for (const pair of cookieString.split(/;\s*/)) {
            if (!pair.trim()) { continue; }
            try {
                const cookie = Cookie.parse(pair.trim());
                if (!cookie) { continue; }
                for (const domain of ['acm.hdu.edu.cn', '.acm.hdu.edu.cn']) {
                    const clone = Cookie.parse(pair.trim())!;
                    clone.domain = domain;
                    clone.path = '/';
                    this.cookieJar.setCookieSync(clone, this.baseUrl + '/');
                }
            } catch { /* skip malformed pairs */ }
        }
    }

    /** Logged-in homepage contains the logout link. */
    private async assertSessionAlive(): Promise<void> {
        const html = await this.httpGet(this.baseUrl + '/');
        if (!/action=logout/i.test(html)) {
            throw new Error(
                'OJ-Assistant: HDOJ session is not logged in. ' +
                'Run "OJ-Assist: Login via browser" and sign in (no captcha).');
        }
    }

    // --------------------------------------------------------------- plumbing

    /** GET with GB18030 decoding (HDOJ serves GBK pages). */
    private async httpGet(url: string, responseType: 'text' | 'buffer' = 'text'): Promise<any> {
        const response = await axios.get(url, Object.assign({}, this.axiosConfig, {
            responseType: responseType === 'buffer' ? 'arraybuffer' : 'text',
            validateStatus: (s: number) => s < 500,
        }));
        if (responseType === 'buffer') {
            return GB.decode(new Uint8Array(response.data as ArrayBuffer));
        }
        // axios text path may mis-decode GBK; always fetch binary for HTML pages.
        return String(response.data ?? '');
    }

    /** GET returning properly decoded HTML (binary + GB18030). */
    private async httpGetHtml(url: string): Promise<string> {
        const response = await axios.get(url, Object.assign({}, this.axiosConfig, {
            responseType: 'arraybuffer',
            validateStatus: (s: number) => s < 500,
        }));
        return GB.decode(new Uint8Array(response.data as ArrayBuffer));
    }

    // --------------------------------------------------------------- problems

    async getProblem(problemInfo: ProblemInfo): Promise<Problem> {
        const pid = String(problemInfo.id);
        const html = await this.httpGetHtml(this.baseUrl + '/showproblem.php?pid=' + encodeURIComponent(pid));
        const $ = cheerio.load(html);

        const title = ($('h1').first().text() || '').trim() || ('Problem ' + pid);

        // Sections are pairs: .panel_title (label) followed by .panel_content.
        const sections: { [label: string]: string } = {};
        $('div.panel_title').each((i, el) => {
            const label = $(el).text().trim();
            const content = $(el).next('div.panel_content');
            if (content.length > 0) {
                sections[label] = content.html() ?? '';
            }
        });

        const pickSection = (...labels: string[]): string => {
            for (const label of labels) {
                for (const key of Object.keys(sections)) {
                    if (key.toLowerCase().includes(label.toLowerCase())) {
                        return sections[key];
                    }
                }
            }
            return '';
        };

        const sampleIn = pickSection('Sample Input');
        const sampleOut = pickSection('Sample Output');
        const toText = (htmlStr: string): string => {
            const $c = cheerio.load('<div>' + htmlStr + '</div>');
            return $c('div').first().text();
        };

        const desc = pickSection('Description', '题目描述') || pickSection('Background');
        return new Problem(pid, problemInfo.contestId, {
            title,
            desc: desc || '<p>(无题面内容)</p>',
            input: pickSection('Input'),
            output: pickSection('Output'),
            sampleInput: sampleIn ? [escapeHtml(toText(sampleIn))] : [],
            sampleOutput: sampleOut ? [escapeHtml(toText(sampleOut))] : [],
            note: pickSection('Hint', 'Note', 'Author', 'Source'),
        });
    }

    /**
     * Browse = volume pages (listproblem.php?vol=N, inline p() rows);
     * keyword = the site's own search (search.php?field=problem&key=).
     */
    async searchProblems(keyword: string, page: number): Promise<ProblemListPage> {
        const kw = keyword.trim();
        if (kw) {
            const html = await this.httpGetHtml(
                this.baseUrl + '/search.php?field=problem&key=' + encodeURIComponent(kw));
            const $ = cheerio.load(html);
            const problems: ProblemListEntry[] = [];
            const seen = new Set<string>();
            $('a[href*="showproblem.php?pid="]').each((i, el) => {
                const href = $(el).attr('href') ?? '';
                const m = href.match(/pid=(\d+)/);
                if (!m || seen.has(m[1])) { return; }
                const title = $(el).text().trim();
                if (!title) { return; }
                seen.add(m[1]);
                problems.push({ id: m[1], title });
            });
            return { problems, hasMore: false };
        }

        const vol = Math.max(1, page);
        const html = await this.httpGetHtml(this.baseUrl + '/listproblem.php?vol=' + vol);
        if (this.volumeCount === 0) {
            const vols = html.match(/listproblem\.php\?vol=(\d+)/g) ?? [];
            let max = 0;
            for (const v of vols) {
                const n = Number((v.match(/(\d+)$/) ?? [])[1] ?? 0);
                if (n > max) { max = n; }
            }
            this.volumeCount = max;
        }
        // Rows are rendered via inline JS: p(status,pid,_,title,ac,sub);
        const problems: ProblemListEntry[] = [];
        const re = /p\(\s*\d+\s*,\s*(\d+)\s*,\s*-?\d+\s*,\s*"((?:[^"\\]|\\.)*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
            const title = m[2].replace(/\'/g, "'").replace(/\\"/g, '"');
            problems.push({ id: m[1], title });
        }
        return { problems, hasMore: vol < this.volumeCount };
    }

    listLanguages(): Array<{ value: number; label: string }> {
        return [
            { value: 1, label: 'G++' }, { value: 2, label: 'GCC' },
            { value: 3, label: 'C++' }, { value: 4, label: 'C' },
            { value: 5, label: 'Pascal' }, { value: 6, label: 'Java' },
            { value: 7, label: 'C#' },
        ];
    }

    // ----------------------------------------------------------------- submit

    /** Fetch the REAL submit form (after login) and learn its field names. */
    private async fetchSubmitForm(pid: string): Promise<{ action: string; fields: { [k: string]: string }; languageSelect: string | undefined; codeField: string }> {
        const html = await this.httpGetHtml(this.baseUrl + '/submit.php?pid=' + encodeURIComponent(pid));
        if (/userloginex\.php\?action=login/.test(html) && !/usercode/i.test(html)) {
            throw new Error('OJ-Assistant: HDOJ 会话已过期，请 Ctrl+Shift+P -> "Login via browser" 重新登录。');
        }
        const $ = cheerio.load(html);
        const form = $('form').filter((i, el) => {
            const action = $(el).attr('action') ?? '';
            return /submit/i.test(action);
        }).first();
        if (form.length === 0) {
            throw new Error('OJ-Assistant: HDOJ submit form not found (session or page changed).');
        }
        const action = form.attr('action') ?? 'submit.php';
        const fields: { [k: string]: string } = {};
        form.find('input[name]').each((i, el) => {
            const name = $(el).attr('name');
            if (!name) { return; }
            if ($(el).attr('type') === 'radio') {
                if ($(el).attr('checked') !== undefined) { fields[name] = $(el).attr('value') ?? ''; }
            } else {
                fields[name] = $(el).attr('value') ?? '';
            }
        });
        let languageSelect: string | undefined;
        form.find('select[name]').each((i, el) => {
            if (languageSelect === undefined) { languageSelect = $(el).attr('name'); }
        });
        let codeField: string | undefined;
        form.find('textarea[name]').each((i, el) => {
            if (codeField === undefined) { codeField = $(el).attr('name'); }
        });
        return { action, fields, languageSelect, codeField: codeField ?? 'usercode' };
    }

    async submit(sourceFile: SourceFile): Promise<Function> {
        const pid = String(sourceFile.id);
        const spec = await this.fetchSubmitForm(pid);

        const langId = Number(sourceFile.languageOverride
            ?? (this.config.languages ?? defaultLanguages)[sourceFile.sourceType] ?? 1);
        const body: { [k: string]: string } = Object.assign({}, spec.fields);
        if (spec.languageSelect) { body[spec.languageSelect] = String(langId); }
        body[spec.codeField] = sourceFile.code;
        // A stray pid field must match the target problem.
        if ('pid' in body) { body['pid'] = pid; }

        const actionUrl = spec.action.startsWith('http')
            ? spec.action
            : this.baseUrl + (spec.action.startsWith('/') ? '' : '/') + spec.action;

        const response = await axios.post(actionUrl, qstringify(body),
            Object.assign({}, this.axiosConfig, {
                headers: Object.assign({}, this.axiosConfig.headers, {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': this.baseUrl + '/submit.php?pid=' + encodeURIComponent(pid),
                }),
                responseType: 'arraybuffer',
                maxRedirects: 5,
                validateStatus: (s: number) => s < 500,
            }));
        const resultPage = GB.decode(new Uint8Array(response.data as ArrayBuffer));
        if (/userloginex\.php\?action=login/.test(resultPage)) {
            throw new Error('OJ-Assistant: HDOJ session expired during submit - re-login via browser.');
        }

        return () => this.pollVerdict(pid, langId, sourceFile, String(langId));
    }

    /** Newest row of MY submissions for this problem (status.php last=1). */
    private async pollVerdict(pid: string, langId: number, sourceFile: SourceFile, lang: string): Promise<ProblemSubmit> {
        const author = this.user?.user ?? '';
        const html = await this.httpGetHtml(
            this.baseUrl + '/status.php?first=1&user=' + encodeURIComponent(author) +
            '&pid=' + encodeURIComponent(pid) + '&lang=' + langId + '&status=0&last=1');

        const $ = cheerio.load(html);
        const submitResult = new ProblemSubmit();
        submitResult.pid = pid;
        submitResult.user = author;
        submitResult.lang = lang;
        submitResult.date = new Date();
        submitResult.codelen = sourceFile.code.length;

        // Rows: <tr align=center><td>runId</td><td>time</td><td><font>verdict</font></td>...
        let row: cheerio.Element | undefined;
        $('tr').each((i, el) => {
            if (row !== undefined) { return; }
            const tds = $(el).children('td');
            if (tds.length >= 9 && /^\d+$/.test(tds.eq(0).text().trim())) {
                row = el;
            }
        });
        if (!row) {
            submitResult.result = 'Pending...';
            return submitResult;
        }
        const tds = $(row).children('td');
        submitResult.id = Number(tds.eq(0).text().trim()) || 0;
        const verdict = tds.eq(2).text().trim();
        submitResult.time = tds.eq(4).text().trim() || '-';
        submitResult.memory = tds.eq(5).text().trim() || '-';
        submitResult.result = this.mapVerdict(verdict);
        return submitResult;
    }

    private mapVerdict(raw: string): string {
        const v = raw.trim();
        if (/^Accepted$/i.test(v)) { return 'Accepted'; }
        if (/Compilation Error|Compile Error/i.test(v)) { return 'Compile Error'; }
        if (/Wrong Answer/i.test(v)) { return 'Wrong Answer'; }
        if (/Time Limit Exceeded/i.test(v)) { return 'Time Limit Exceeded'; }
        if (/Memory Limit Exceeded/i.test(v)) { return 'Memory Limit Exceeded'; }
        if (/Runtime Error/i.test(v)) { return 'Runtime Error'; }
        if (/Output Limit Exceeded/i.test(v)) { return 'Output Limit Exceeded'; }
        if (/Presentation Error/i.test(v)) { return 'Presentation Error'; }
        if (/Waiting|Queue|Compiling|Running|Judging|Pending/i.test(v)) {
            return /Compiling|Running|Judging/i.test(v) ? 'Judging...' : 'Pending...';
        }
        return v || 'Pending...';
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
