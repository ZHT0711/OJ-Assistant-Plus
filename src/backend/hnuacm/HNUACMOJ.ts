import axios, { AxiosRequestConfig } from 'axios';
import axiosCookieJarSupport from '@3846masa/axios-cookiejar-support';
import { CookieJar, Cookie } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { stringify as qstringify } from 'qs';
import {
    OJ, User, Configuration, SourceFile, ProblemSubmit, Problem, ProblemInfo,
    ProblemListEntry, ProblemListPage,
} from '../../model';

axiosCookieJarSupport(axios);

const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const languageMap: { [ext: string]: number } = { c: 0, cpp: 1, cc: 1, cxx: 1, java: 2, pas: 3, pascal: 3 };

class HNUACMConfiguration implements Configuration { [key: string]: any; constructor(public credentials: any) { } }

export class HNUACMUser implements User {
    constructor(public user: string, public password: string, public session: CookieJar) { }
}

/** Adapter for Hunan University's legacy ACM/ICPC Judge Online. */
export class HNUACMOJ implements OJ {
    readonly baseUrl = String((this.config.baseUrl as string) ?? 'http://acm.hnu.edu.cn/online').replace(/\/+$/, '');
    private axiosConfig: AxiosRequestConfig = {};
    private cookieJar!: CookieJar;
    user!: HNUACMUser;

    constructor(private config: HNUACMConfiguration) { }

    async login(): Promise<HNUACMUser> {
        this.cookieJar = new CookieJar();
        this.axiosConfig = {
            jar: this.cookieJar,
            withCredentials: true,
            headers: { 'User-Agent': browserUA },
        };
        const credentials = this.config.credentials ?? {};
        if (credentials.cookies) {
            this.storeCookies(String(credentials.cookies));
            const probe = await axios.get(this.baseUrl + '/?action=form&type=submitproblem', Object.assign({}, this.axiosConfig, {
                headers: Object.assign({}, this.axiosConfig.headers, { Accept: 'text/html' }),
                validateStatus: (s: number) => s < 500,
            }));
            if (probe.status >= 400 || /Your Login Information|name=["']userid["']/i.test(String(probe.data ?? ''))) {
                throw new Error('OJ-Assistant: HNU ACM session has expired. Run "OJ-Assist: Login via browser" to refresh cookies.');
            }
        } else if (credentials.username && credentials.password) {
            await this.loginWithPassword(String(credentials.username), String(credentials.password));
        }
        // The problem catalogue is public. This deliberately does not reject
        // an empty credential so users can browse before signing in.
        this.user = new HNUACMUser(credentials.username ?? '(anonymous)', credentials.password ?? '', this.cookieJar);
        return this.user;
    }

    private storeCookies(cookieString: string): void {
        for (const pair of cookieString.split(/;\s*/)) {
            const parsed = Cookie.parse(pair.trim());
            if (!parsed) { continue; }
            for (const domain of ['acm.hnu.edu.cn', '.acm.hnu.edu.cn']) {
                const copy = Cookie.parse(pair.trim());
                if (!copy) { continue; }
                copy.domain = domain;
                copy.path = '/';
                this.cookieJar.setCookieSync(copy, this.baseUrl + '/');
            }
        }
    }

    private async loginWithPassword(username: string, password: string): Promise<void> {
        const response = await axios.post(
            this.baseUrl + '/?action=user&type=login',
            qstringify({ preuel: './?', action: 'login', userid: username, password, submit: 'Login(L)' }),
            Object.assign({}, this.axiosConfig, {
                headers: Object.assign({}, this.axiosConfig.headers, { 'Content-Type': 'application/x-www-form-urlencoded' }),
                maxRedirects: 0,
                validateStatus: (s: number) => s < 500,
            })
        );
        const body = String(response.data ?? '');
        if (response.status >= 400 || /Your Login Information|name=["']userid["']/i.test(body)) {
            throw new Error('OJ-Assistant: HNU ACM login failed. Check credentials or run browser login.');
        }
    }

    private async getHtml(url: string): Promise<string> {
        const response = await axios.get(url, Object.assign({}, this.axiosConfig, {
            responseType: 'arraybuffer',
            headers: Object.assign({}, this.axiosConfig.headers, { Accept: 'text/html' }),
            validateStatus: (s: number) => s < 500,
        }));
        if (response.status >= 400) { throw new Error(`OJ-Assistant: HNU ACM HTTP ${response.status}.`); }
        // The legacy server declares gb2312/gbk. Node's ICU decoder handles it
        // without adding a large runtime dependency; fall back to UTF-8 for
        // mirrors that already transcode the page.
        try {
            const Decoder = require('util').TextDecoder;
            return new Decoder('gb18030').decode(Buffer.from(response.data));
        } catch {
            return Buffer.from(response.data).toString('utf8');
        }
    }

    async searchProblems(keyword: string, page: number): Promise<ProblemListPage> {
        const params = new URLSearchParams({ action: 'problem', type: 'list', courseid: '0', querytext: keyword.trim(), pageno: String(Math.max(1, page)) });
        const html = await this.getHtml(this.baseUrl + '/?' + params.toString());
        const $ = cheerio.load(html);
        const problems: ProblemListEntry[] = [];
        const seen = new Set<string>();
        $('a[href*="action=problem"][href*="type=show"][href*="id="]').each((_, el) => {
            const href = $(el).attr('href') ?? '';
            const id = href.match(/[?&]id=(\d+)/)?.[1];
            if (!id || seen.has(id)) { return; }
            seen.add(id);
            const title = $(el).text().replace(/\s+/g, ' ').trim();
            const row = $(el).closest('tr');
            const cells = row.children('td');
            const solved = cells.eq(0).text().trim();
            const ratio = cells.eq(2).text().replace(/\s+/g, ' ').trim();
            problems.push({ id, title: title || `Problem ${id}`, status: solved ? '✓ AC' : (ratio ? ratio : undefined) });
        });
        const pageNumbers = $('a[href*="pageno="]').toArray().map(el => Number($(el).attr('href')?.match(/[?&]pageno=(\d+)/)?.[1] ?? 0)).filter(n => n > 0);
        const maxPage = pageNumbers.length ? Math.max(...pageNumbers) : page;
        return { problems, hasMore: page < maxPage };
    }

    async getProblem(problemInfo: ProblemInfo): Promise<Problem> {
        const html = await this.getHtml(this.baseUrl + '/?action=problem&type=show&id=' + encodeURIComponent(problemInfo.id) + '&courseid=' + encodeURIComponent(problemInfo.contestId ?? '0'));
        const $ = cheerio.load(html);
        const contentTable = $('td').filter((_, el) => $(el).find('b').text().includes('Problem description')).first().closest('table');
        const root = contentTable.length ? contentTable : $('table').last();
        const sections: { [key: string]: string } = {};
        const samples: { input?: string; output?: string } = {};
        root.find('tr').each((_, tr) => {
            const cells = $(tr).children('td');
            if (cells.length < 1) { return; }
            const label = cells.first().find('b').first().text().trim().toLowerCase();
            const value = cells.last().html() ?? '';
            if (/problem description/.test(label)) { sections.desc = value; }
            else if (label === 'input') { sections.input = value; }
            else if (label === 'output') { sections.output = value; }
            else if (/sample input/.test(label)) { samples.input = cells.last().find('pre').first().text() ?? ''; }
            else if (/sample output/.test(label)) { samples.output = cells.last().find('pre').first().text() ?? ''; }
        });
        const title = root.find('tr').first().text().replace(/\s+/g, ' ').trim() || `Problem ${problemInfo.id}`;
        const heading = $('td[align="center"] font[size="5"]').first().text().trim() || title;
        return new Problem(problemInfo.id, problemInfo.contestId, {
            title: heading,
            desc: sections.desc ?? '', input: sections.input ?? '', output: sections.output ?? '',
            sampleInput: [samples.input ?? ''], sampleOutput: [samples.output ?? ''], note: '',
        });
    }

    async submit(sourceFile: SourceFile): Promise<Function> {
        const formHtml = await this.getHtml(this.baseUrl + '/?action=form&type=submitproblem&id=' + encodeURIComponent(sourceFile.id));
        const $ = cheerio.load(formHtml);
        const form = $('form').filter((_, el) => /submit/i.test($(el).attr('action') ?? '') || $(el).find('textarea,select').length > 0).first();
        if (!form.length || /Your Login Information/i.test(formHtml)) {
            throw new Error('OJ-Assistant: HNU ACM session expired. Run "OJ-Assist: Login via browser" to refresh cookies.');
        }
        const action = form.attr('action') ?? './?action=submit';
        const body: { [key: string]: any } = {};
        form.find('input[name]').each((_, el) => { body[$(el).attr('name')!] = $(el).attr('value') ?? ''; });
        const problemField = Object.keys(body).find(k => /problem/i.test(k));
        if (problemField) { body[problemField] = sourceFile.id; } else { body.problemid = sourceFile.id; }
        // Different revisions of this JSP used `problemid` or `pid`; sending
        // the stable legacy name as well keeps hand-written/custom forms
        // compatible without changing the visible form fields.
        body.problemid = sourceFile.id;
        const language = languageMap[sourceFile.sourceType.toLowerCase()] ?? 1;
        const select = form.find('select[name]').first();
        if (select.length) { body[select.attr('name')!] = String(language); }
        else { body.language = language; }
        const area = form.find('textarea[name]').first();
        body[area.attr('name') ?? 'source'] = sourceFile.code;
        if (!body.source) { body.source = sourceFile.code; }
        const response = await axios.post(new URL(action, this.baseUrl + '/').toString(), qstringify(body), Object.assign({}, this.axiosConfig, {
            headers: Object.assign({}, this.axiosConfig.headers, { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.baseUrl + '/?action=form&type=submitproblem' }),
            validateStatus: (s: number) => s < 500,
        }));
        if (response.status >= 400 || /Login Information|login required/i.test(String(response.data ?? ''))) {
            throw new Error('OJ-Assistant: HNU ACM submission was rejected; the session may have expired.');
        }
        return () => this.pollStatus(sourceFile);
    }

    private async pollStatus(sourceFile: SourceFile): Promise<ProblemSubmit> {
        const url = this.baseUrl + '/?action=status&problemid=' + encodeURIComponent(sourceFile.id) + '&courseid=' + encodeURIComponent(sourceFile.contestId ?? '0');
        const html = await this.getHtml(url);
        const $ = cheerio.load(html);
        const row = $('tr').filter((_, tr) => $(tr).find('a[href*="problem&type=show"]').text().trim() === sourceFile.id).first();
        const cells = row.children('td');
        const result = new ProblemSubmit();
        result.id = Number(cells.eq(0).text().trim()) || 0;
        result.user = cells.eq(1).text().trim() || this.user?.user || '-';
        result.pid = sourceFile.id;
        result.lang = cells.eq(3).text().trim() || sourceFile.sourceType;
        result.result = cells.eq(4).text().trim() || 'Pending...';
        result.memory = cells.eq(5).text().trim() || '-'; result.time = cells.eq(6).text().trim() || '-';
        result.codelen = Number(cells.eq(7).text().trim()) || sourceFile.code.length;
        result.date = new Date(cells.eq(8).text().trim() || Date.now());
        return result;
    }
}
