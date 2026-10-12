import axios, { AxiosRequestConfig } from 'axios';
import axiosCookieJarSupport from '@3846masa/axios-cookiejar-support';
import { stringify as qstringify } from 'qs';
import { CookieJar, Cookie } from 'tough-cookie';
import { createCipheriv } from 'crypto';
import * as cheerio from 'cheerio';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
    OJ, User, Configuration,
    SourceFile, ProblemSubmit, Problem, ProblemInfo,
    ProblemListEntry, ProblemListPage
} from '../../model';

axiosCookieJarSupport(axios);

/**
 * CSECG - neucsecg.neu.edu.cn "CourseGrading" 实验/作业平台 (JSP mode).
 *
 * Verified with a real student session (2026-10):
 *  - Web UI = server-rendered JSP on the JSESSIONID session; no JWT needed.
 *  - Login: POST /login/loginproc.jsp (IndexStyle=1, stid, pwd=AES-128-ECB
 *    with key "Client8Sess!06ID", captchaCode; image at GET /cgjiaoyan).
 *  - Auth probe: GET /assignment/ - guests get 302 or 200 EMPTY body; only a
 *    real login serves the large assignment page.
 *  - Problem list rows: <a href="/assignment/programList.jsp?proNum=N&assignID=X">title</a>
 *  - Problem page: programList.jsp 302 -> programList_ce.jsp; hidden inputs
 *    doSubmit/byCE/wtime/javaMainCLass/problemID/assignID; textarea
 *    name="cgsoucecode"; language select: c/c++/java/python/c#.
 *  - Submit: POST /assignment/showProcessMsg.jsp (urlencoded).
 *  - Verdict: GET /assignment/longtimerunJSON.jsp?assignID=&problemID=
 *    -> [{"ret":"..."},{"content":"..."}]
 */

const AES_KEY = 'Client8Sess!06ID';
const BS = String.fromCharCode(92); // regex-safe backslash

const defaultLanguages: { [ext: string]: string } = {
    'c': 'c',
    'cpp': 'c++',
    'cc': 'c++',
    'cxx': 'c++',
    'java': 'java',
    'py': 'python',
    'py3': 'python',
    'python': 'python',
    'cs': 'c#',
};

class CSECGConfiguration implements Configuration {
    [key: string]: any;
    constructor(public credentials: any) { }
}

export class CSECGUser implements User {
    constructor(
        public user: string,
        public password: string,
        public session: CookieJar,
    ) { }
}

export class CSECG implements OJ {
    readonly baseUrl = (this.config.baseUrl as string) ?? 'http://neucsecg.neu.edu.cn';

    user!: CSECGUser;
    private axiosConfig: AxiosRequestConfig = {};
    private cookieJar!: CookieJar;
    /** `${assignID}.${proNum}` -> platform problemID (hidden input). */
    private problemIdCache: { [key: string]: string } = {};
    private languageOptions: Array<{ value: string; label: string }> = [];
    /** assignID -> { name, deadline, late } learned from list pages. */
    private assignmentMeta: { [assignID: string]: { name?: string; deadline?: string; late?: boolean; history?: boolean } } = {};

    private static readonly browserUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    constructor(private config: CSECGConfiguration) { }

    // ------------------------------------------------------------------ login

    async login(): Promise<CSECGUser> {
        this.cookieJar = new CookieJar();
        this.axiosConfig = {
            jar: this.cookieJar,
            withCredentials: true,
            headers: { 'User-Agent': CSECG.browserUA },
        };

        const credentials = this.config.credentials ?? {};
        if (credentials.cookies) {
            this.storeCookies(String(credentials.cookies));
        } else if (credentials.username && credentials.password) {
            await this.loginViaJsp(credentials.username, credentials.password);
        } else {
            throw new Error(
                'OJ-Assistant: csecg requires credentials.cookies (run "OJ-Assist: Login via browser") ' +
                'or credentials.username + credentials.password in .ojassistconfig.json');
        }

        await this.assertSessionAlive();
        this.user = new CSECGUser(credentials.username ?? '(session)', credentials.password ?? '', this.cookieJar);
        return this.user;
    }

    /** Load a cookie string ("a=1; b=2") captured from the browser. */
    private storeCookies(cookieString: string): void {
        for (const pair of cookieString.split(/;\s*/)) {
            if (!pair.trim()) { continue; }
            try {
                const cookie = Cookie.parse(pair.trim());
                if (!cookie) { continue; }
                for (const domain of ['neucsecg.neu.edu.cn', '.neucsecg.neu.edu.cn']) {
                    const clone = Cookie.parse(pair.trim())!;
                    clone.domain = domain;
                    clone.path = '/';
                    this.cookieJar.setCookieSync(clone, this.baseUrl + '/');
                }
            } catch { /* skip malformed pairs */ }
        }
    }

    /**
     * GET /assignment/: guests get 302 or a 200 with an EMPTY body; only a
     * real login serves the (large) assignment page.
     */
    private async assertSessionAlive(): Promise<void> {
        const probe = await axios.get(
            this.baseUrl + '/assignment/',
            Object.assign({}, this.axiosConfig, {
                headers: Object.assign({}, this.axiosConfig.headers, { 'Accept': 'text/html' }),
                maxRedirects: 0,
                validateStatus: (s: number) => s < 500,
            })
        );
        const body = typeof probe.data === 'string' ? probe.data : String(probe.data ?? '');
        if (probe.status < 200 || probe.status >= 300 || body.length <= 500) {
            throw new Error(
                'OJ-Assistant: CSECG session is not logged in. ' +
                'Run "OJ-Assist: Login via browser" and sign in on the page that opens.');
        }
    }

    /** GET /cgjiaoyan (same session) -> show image -> POST loginproc.jsp. */
    private async loginViaJsp(username: string, password: string): Promise<void> {
        const attempts = Math.max(1, Number(this.config.captchaAttempts ?? 3));
        let lastError = '';
        for (let i = 0; i < attempts; i++) {
            const captcha = await this.fetchAndAskCaptcha();
            const response = await axios.post(
                this.baseUrl + '/login/loginproc.jsp',
                qstringify({
                    IndexStyle: '1',
                    stid: username,
                    pwd: encryptPassword(password),
                    captchaCode: captcha,
                }),
                Object.assign({}, this.axiosConfig, {
                    headers: Object.assign({}, this.axiosConfig.headers, {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': this.baseUrl + '/indexcs/simple.jsp',
                    }),
                    maxRedirects: 0,
                    validateStatus: (s: number) => s >= 200 && s < 400,
                })
            );
            const location = String(response.headers['location'] ?? '');
            const errMatch = location.match(new RegExp('loginErr=' + BS + 'd+'));
            if (errMatch) {
                lastError = errMatch[0];
                continue;
            }
            if (response.status >= 300 && response.status < 400) {
                return; // success: redirected into the authenticated area
            }
            lastError = 'HTTP ' + response.status;
        }
        throw new Error('OJ-Assistant: CSECG login failed (' + lastError + ').');
    }

    private async fetchAndAskCaptcha(): Promise<string> {
        const response = await axios.get(
            this.baseUrl + '/cgjiaoyan',
            Object.assign({}, this.axiosConfig, { responseType: 'arraybuffer' })
        );
        const captchaFile = path.join(os.tmpdir(), 'ojassist-csecg-captcha.png');
        await fs.writeFile(captchaFile, Buffer.from(response.data));
        await vscode.env.openExternal(vscode.Uri.file(captchaFile));
        const code = await vscode.window.showInputBox({
            prompt: 'CSECG 验证码（图片已用系统查看器打开）',
            placeHolder: '输入图片中的字符',
            ignoreFocusOut: true,
        });
        if (code === undefined || code === '') {
            throw new Error('OJ-Assistant: Login cancelled (no captcha given).');
        }
        return code.trim();
    }

    // ------------------------------------------------------- problem browsing

    /** Parse an assignment page into (assignID, proNum, title) rows. */
    /** Sidebar: <a ...assignID=N> 名称 <span class="badge">补交中</span> </a> */
    private parseSidebarAssignments(pageHtml: string): { [assignID: string]: { name: string; late: boolean; history: boolean } } {
        const $ = cheerio.load(pageHtml);
        const result: { [assignID: string]: { name: string; late: boolean; history: boolean } } = {};
        // Sidebar sections: <span>当前作业|历史作业</span> followed by a
        // list-group of index.jsp links. Walk the sidebar in document order so
        // every assignment knows whether it is history (已结束归档).
        let currentSection = '';
        $('.col-2 span.text-muted, .col-2 .list-group a[href*="index.jsp"][href*="assignID="]').each((i, el) => {
            const tag = (el as any).tagName ?? '';
            if (tag === 'span' || $(el).hasClass('text-muted')) {
                const heading = $(el).text();
                currentSection = heading.includes('历史') ? 'history' : (heading.includes('当前') ? 'current' : currentSection);
                return;
            }
            const href = $(el).attr('href') ?? '';
            const m = href.match(new RegExp('assignID=(' + BS + 'd+)'));
            if (!m) { return; }
            const badge = $(el).find('.badge').text();
            const name = $(el).clone().children().remove().end().text().trim();
            if (name) {
                result[m[1]] = { name, late: /补交/.test(badge), history: currentSection === 'history' };
            }
        });
        return result;
    }

    private parseProblemRows(pageHtml: string): AssignmentProblem[] {
        const $ = cheerio.load(pageHtml);
        const problems: AssignmentProblem[] = [];
        const seen = new Set<string>();
        // 作业时间：... 至 ... (assignment header). The HTML splits the
        // pieces across tags, so match on the tag-stripped text.
        const pageText = pageHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const timeMatch = pageText.match(/作业时间[:：]\s*([\d-]+\s+[\d:]+)\s*至\s*([\d-]+\s+[\d:]+)/);
        const deadline = timeMatch ? timeMatch[2].trim() : undefined;
        // <h4>第3次课后作业</h4> right above 作业时间
        const nameMatch = pageText.match(/(第\s*\d+\s*次[^ ]{0,12}作业|[一-龥]{2,12}作业)\s*作业时间/);
        const assignmentName = nameMatch ? nameMatch[1].trim() : undefined;
        $('a[href*="programList.jsp"]').each((i, el) => {
            const href = $(el).attr('href') ?? '';
            const m = href.match(new RegExp('proNum=(' + BS + 'd+)&(amp;)?assignID=(' + BS + 'd+)'));
            if (!m) { return; }
            const key = m[3] + '.' + m[1];
            if (seen.has(key)) { return; }
            seen.add(key);
            const title = $(el).text().trim().replace(new RegExp('^' + BS + 'd+[.、]'), '').trim();
            const row = $(el).closest('tr');
            const td = row.children('td').last(); // children only: nested judge tables would pollute find('td')
            const smallText = td.find('small').first().text().replace(/\s+/g, ' ');
            const submittedMatch = smallText.match(/最后一次提交时间[:：]\s*([\d-]+\s+[\d:]+)/);
            const submittedAt = submittedMatch ? submittedMatch[1].trim() : undefined;
            let status = '';
            if (!/还未提交|尚未|未提交/.test(smallText) && smallText) {
                // Submitted rows carry: 最后一次提交时间 / 得分：X / per-test results.
                const score = smallText.match(/得分[：:]\s*([\d.]+)/);
                const passed = (smallText.match(/完全正确/g) || []).length;
                const failed = (smallText.match(/未通过|答案错误|部分正确|运行错误|超时/g) || []).length;
                if (score) {
                    status = (passed > 0 && failed === 0 ? '✓ ' : (failed > 0 ? '⚠ ' : '')) + score[1] + '分';
                } else {
                    status = '已提交';
                }
            }
            // The 详细 link also carries the platform problemID - cache it so
            // submit does not need an extra page fetch later.
            const detailHref = td.find('a[href*="judgeDetailsRedirect"]').attr('href') ?? '';
            const pm = detailHref.match(new RegExp('problemID=(' + BS + 'd+)'));
            if (pm) { this.problemIdCache[m[3] + '.' + m[1]] = pm[1]; }
            problems.push({ assignID: m[3], proNum: m[1], title: title || ('Problem ' + m[1]), status, submittedAt, deadline, assignmentName });
        });
        return problems;
    }

    private async fetchHtml(url: string): Promise<string> {
        const response = await axios.get(url, Object.assign({}, this.axiosConfig, {
            headers: Object.assign({}, this.axiosConfig.headers, { 'Accept': 'text/html' }),
            validateStatus: (s: number) => s === 200,
        }));
        const html = String(response.data ?? '');
        // Guests/expired sessions get an EMPTY 200 - fail loudly instead of
        // parsing the blank page into a fake "no content" problem.
        if (html.length <= 500) {
            throw new Error(
                'OJ-Assistant: CSECG 会话已过期（页面返回空白）。请 Ctrl+Shift+P -> "Login via browser" 重新登录。');
        }
        return html;
    }

    /**
     * The root /assignment/ page lists the current assignment's problems;
     * the course dropdown links the other assignments, which we also pull
     * (capped) so the tree covers the whole course.
     */
    async searchProblems(keyword: string, page: number): Promise<ProblemListPage> {
        const rootHtml = await this.fetchHtml(this.baseUrl + '/assignment/');
        const sidebar = this.parseSidebarAssignments(rootHtml);
        const all: AssignmentProblem[] = this.parseProblemRows(rootHtml);
        const known = new Set(all.map(p => p.assignID + '.' + p.proNum));

        const $ = cheerio.load(rootHtml);
        const assignmentUrls = new Set<string>();
        $('a[href*="index.jsp"]').each((i, el) => {
            const href = $(el).attr('href') ?? '';
            if (href.includes('assignID=')) { assignmentUrls.add(href); }
        });

        let fetched = 0;
        for (const href of Array.from(assignmentUrls)) {
            if (fetched >= 10) { break; }
            const url = href.startsWith('http') ? href : this.baseUrl + '/assignment/' + href.replace(new RegExp('^.*/assignment/'), '');
            try {
                const pageHtml = await this.fetchHtml(url);
                for (const p of this.parseProblemRows(pageHtml)) {
                    const key = p.assignID + '.' + p.proNum;
                    if (!known.has(key)) { known.add(key); all.push(p); }
                }
                fetched += 1;
            } catch { /* skip unreachable assignment pages */ }
        }

        // Sidebar carries the human names and the 补交中 badge for every
        // assignment - overlay them onto the collected rows.
        for (const p of all) {
            const meta = sidebar[p.assignID];
            if (meta) {
                p.assignmentName = meta.name;
                p.late = meta.late;
                p.history = meta.history;
            }
            this.assignmentMeta[p.assignID] = {
                name: p.assignmentName ?? this.assignmentMeta[p.assignID]?.name,
                deadline: p.deadline ?? this.assignmentMeta[p.assignID]?.deadline,
                late: p.late ?? this.assignmentMeta[p.assignID]?.late,
                history: p.history ?? this.assignmentMeta[p.assignID]?.history,
            };
        }

        const kw = keyword.trim().toLowerCase();
        const matched = kw
            ? all.filter(p => (p.proNum + p.title + p.assignID).toLowerCase().includes(kw))
            : all;
        const pageSize = 20;
        const start = (page - 1) * pageSize;
        return {
            problems: matched.slice(start, start + pageSize).map(p => ({
                id: p.proNum,
                title: p.title,
                contestId: p.assignID,
                status: p.status || undefined,
                submittedAt: p.submittedAt,
                deadline: p.deadline,
                assignmentName: p.assignmentName,
                late: p.late,
                history: p.history,
            })),
            hasMore: start + pageSize < matched.length,
        };
    }

    // ---------------------------------------------------------------- problem

    /** Fetch + parse a problem page; caches the platform problemID. */
    private async fetchProblemPage(proNum: string, assignID: string): Promise<cheerio.Root> {
        // programList.jsp 302-redirects to programList_ce.jsp; axios follows.
        const html = await this.fetchHtml(
            this.baseUrl + '/assignment/programList.jsp?proNum=' + proNum + '&assignID=' + assignID);
        const $ = cheerio.load(html);
        const problemId = $('input[name="problemID"]').first().attr('value');
        if (problemId) {
            this.problemIdCache[assignID + '.' + proNum] = problemId;
        }
        this.languageOptions = [];
        $('#language option').each((i, el) => {
            const value = $(el).attr('value');
            if (value) { this.languageOptions.push({ value, label: $(el).text().trim() }); }
        });
        return $ as cheerio.Root;
    }

    async getProblem(problemInfo: ProblemInfo): Promise<Problem> {
        const assignID = String(problemInfo.contestId ?? '');
        const proNum = String(problemInfo.id);
        if (!assignID) {
            throw new Error('OJ-Assistant: csecg needs an assignment id - use the problem browser, or name files a/<assignID>/<proNum>.cpp');
        }
        const $ = await this.fetchProblemPage(proNum, assignID);

        // Two templates exist: the editor page puts the title in an <h4>;
        // the file-upload variant (no editor) only has it in the breadcrumb.
        const stripNo = (t: string) => t.trim().replace(new RegExp('^' + BS + 'd+[.、]\s*'), '').trim();
        const h4Title = stripNo($('h4').first().text() || '');
        const crumbTitle = stripNo($('.breadcrumb-item.active').text() || '');
        const title = h4Title || crumbTitle || ('作业 ' + assignID + ' 第 ' + proNum + ' 题');

        const container = $('.cgProblemContentClass').first();
        const statementHtml = container.length > 0 ? container.html() ?? '' : '';

        // Samples: <pre> blocks after 【样例输入】/【样例输出】 - take them in order.
        const pres: string[] = [];
        container.find('pre').each((i, el) => { pres.push($(el).text()); });
        const sampleInput: string[] = [];
        const sampleOutput: string[] = [];
        if (pres.length >= 2) {
            sampleInput.push(pres[0]);
            sampleOutput.push(pres[1]);
        } else if (pres.length === 1) {
            sampleInput.push(pres[0]);
            sampleOutput.push('');
        }

        // Statement minus the sample <pre> blocks (they render separately).
        container.find('pre').remove();
        const desc = container.html() ?? statementHtml;

        const sectionOf = (label: string): string => {
            let result = '';
            container.find('strong, b').each((i, el) => {
                if (result) { return; }
                if ($(el).text().includes(label)) {
                    result = $(el).parent().html() ?? '';
                }
            });
            return result;
        };

        const am = this.assignmentMeta[assignID] ?? {};
        const metaParts: string[] = [];
        if (am.name) { metaParts.push(am.name); }
        if (am.late) { metaParts.push('补交中'); }
        if (am.deadline) {
            const dm = am.deadline.match(/\d{4}-(\d{2}-\d{2})/);
            metaParts.push(dm ? '截' + dm[1] : '截止');
        }
        const viewMeta = metaParts.join(' · ');

        return new Problem(proNum, assignID, {
            title,
            viewMeta,
            desc: desc || '<p>(无题面内容)</p>',
            input: sectionOf('输入形式') || sectionOf('输入'),
            output: sectionOf('输出形式') || sectionOf('输出'),
            sampleInput,
            sampleOutput,
            note: '',
        });
    }

    listLanguages(): Array<{ value: string; label: string }> {
        if (this.languageOptions.length > 0) { return this.languageOptions.slice(); }
        return [
            { value: 'c', label: 'C' }, { value: 'c++', label: 'C++' },
            { value: 'java', label: 'JAVA' }, { value: 'python', label: 'PYTHON' },
            { value: 'c#', label: 'C#' },
        ];
    }

    // ----------------------------------------------------------------- submit

    async submit(sourceFile: SourceFile): Promise<Function> {
        const assignID = String(sourceFile.contestId ?? '');
        const proNum = String(sourceFile.id);
        if (!assignID) {
            throw new Error('OJ-Assistant: csecg needs an assignment id (file layout a/<assignID>/<proNum>.cpp).');
        }

        // Fresh page fetch guarantees a current platform problemID.
        await this.fetchProblemPage(proNum, assignID);
        const problemID = this.problemIdCache[assignID + '.' + proNum];
        if (!problemID) {
            throw new Error('OJ-Assistant: csecg problemID not found for assignment ' + assignID + ' problem ' + proNum + '.');
        }

        const lang = String(sourceFile.languageOverride ?? (this.config.languages ?? defaultLanguages)[sourceFile.sourceType] ?? 'c++');
        const response = await axios.post(
            this.baseUrl + '/assignment/showProcessMsg.jsp',
            qstringify({
                doSubmit: 'true',
                byCE: 'true',
                wtime: '0',
                javaMainCLass: 'Main',
                progLanguage: lang,
                problemID,
                assignID,
                cgsoucecode: sourceFile.code,
            }),
            Object.assign({}, this.axiosConfig, {
                headers: Object.assign({}, this.axiosConfig.headers, {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': this.baseUrl + '/assignment/programList.jsp?proNum=' + proNum + '&assignID=' + assignID,
                }),
                validateStatus: (s: number) => s < 500,
            })
        );
        if (response.status >= 400) {
            throw new Error('OJ-Assistant: csecg submit failed (HTTP ' + response.status + ').');
        }

        return () => this.pollVerdict(assignID, problemID, sourceFile, lang);
    }

    private async pollVerdict(assignID: string, problemID: string, sourceFile: SourceFile, lang: string): Promise<ProblemSubmit> {
        const response = await axios.get(
            this.baseUrl + '/assignment/longtimerunJSON.jsp?assignID=' + assignID + '&problemID=' + problemID,
            Object.assign({}, this.axiosConfig, {
                headers: { 'Accept': 'application/json', 'User-Agent': CSECG.browserUA },
                validateStatus: (s: number) => s < 500,
            })
        );
        let content = '';
        let ret = '';
        try {
            const arr = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
            if (Array.isArray(arr)) {
                for (const item of arr) {
                    if (item && item.content !== undefined) { content = String(item.content); }
                    if (item && item.ret !== undefined) { ret = String(item.ret); }
                }
            }
        } catch { /* non-json body: keep empty content */ }

        const result = new ProblemSubmit();
        result.id = Number(problemID) || 0;
        result.pid = assignID + '.' + sourceFile.id;
        result.user = this.user?.user ?? '-';
        result.lang = lang;
        result.date = new Date();
        result.codelen = sourceFile.code.length;
        result.time = '-';
        result.memory = '-';
        result.result = this.mapVerdict(content, ret);
        return result;
    }

    private mapVerdict(content: string, ret: string): string {
        const t = content.trim();
        if (t === '' && ret === '1') { return 'Pending...'; }
        if (/还未提交|尚未|排队|等待|评测中|正在|running|judging|pending|waiting/i.test(t)) {
            return 'Pending...';
        }
        if (/编译中/.test(t)) { return 'Judging...'; }
        if (/通过|正确|Accepted/.test(t)) { return 'Accepted'; }
        if (/编译错误|Compile/i.test(t)) { return 'Compile Error'; }
        if (/答案错误|Wrong/i.test(t)) { return 'Wrong Answer'; }
        if (/运行错误|Runtime/i.test(t)) { return 'Runtime Error'; }
        if (/超时|Time Limit/i.test(t)) { return 'Time Limit Exceeded'; }
        if (/内存|Memory/i.test(t)) { return 'Memory Limit Exceeded'; }
        return t || ('Status ' + (ret || '?'));
    }
}

/** CryptoJS-compatible AES-128-ECB/PKCS7 encryption used by loginencode.js. */
function encryptPassword(plain: string): string {
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'utf8'), null);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return encrypted.toString('base64');
}

interface AssignmentProblem {
    assignID: string;
    proNum: string;
    title: string;
    status?: string;
    submittedAt?: string;
    deadline?: string;
    assignmentName?: string;
    late?: boolean;
    history?: boolean;
}
