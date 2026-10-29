import * as path from 'path';
import axios from 'axios';
import type { ProblemInfo } from '../model/Problem';
import type { ProblemListEntry } from '../model/OJ';

/**
 * Everything the extension needs to know about a platform that is *not*
 * part of the problem-fetch/submit API: where its web pages live, how
 * solution files are laid out on disk, and how browser login is verified.
 *
 * Keeping this here means a new backend only touches its own adapter plus
 * one registry entry - not the command table, the tree provider and the
 * browser-login command as well.
 */

export interface LoginSpec {
    /** Page that shows the login form. */
    loginUrl: string;
    /** Suffix used to filter cookies belonging to this platform. */
    domainSuffix: string;
    /** Cheap cookie-level check (evaluated every polling tick). */
    cookieCheck(cookies: { [key: string]: string }): boolean;
    /**
     * Optional HTTP verification with the harvested cookies - needed where a
     * session cookie is issued before login (NEU OJ, CSECG).
     */
    probe?(cookieHeader: string): Promise<boolean>;
}

export interface PlatformAdapter {
    /** Canonical backend id used in .ojassistconfig.json. */
    id: string;
    /** Readable/legacy names accepted in hand-written configuration files. */
    aliases: string[];
    /** Public problem page, if the platform has a stable URL rule. */
    webUrl(info: ProblemInfo): string | undefined;
    /** Relative path of the solution file inside the workspace folder. */
    solutionPath(entry: ProblemListEntry, ext: string): string;
    /** Whether sampleInput/sampleOutput are HTML fragments (default true). */
    sampleHtml: boolean;
    /** Browser login descriptor; omitted when the platform does not support it. */
    login?: LoginSpec;
}

export const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function rootFile(entry: ProblemListEntry, ext: string): string {
    return `${entry.id}.${ext}`;
}

function problemFile(entry: ProblemListEntry, ext: string): string {
    return path.join('problems', `${entry.id}.${ext}`);
}

function assignmentFile(entry: ProblemListEntry, ext: string): string {
    return path.join('a', String(entry.contestId ?? '0'), `${entry.id}.${ext}`);
}

function cookie(name: string): (cookies: { [key: string]: string }) => boolean {
    return cookies => !!cookies[name];
}

/** luogu: `_uid` is present but "0" while anonymous. */
function luoguCookieCheck(cookies: { [key: string]: string }): boolean {
    return !!cookies['_uid'] && cookies['_uid'] !== '0';
}

export const platformAdapters: PlatformAdapter[] = [
    {
        id: 'luogu',
        aliases: [],
        webUrl: info => 'https://www.luogu.com.cn/problem/' + info.id.toUpperCase(),
        solutionPath: rootFile,
        sampleHtml: false,
        login: {
            loginUrl: 'https://www.luogu.com.cn/auth/login',
            domainSuffix: 'luogu.com.cn',
            cookieCheck: luoguCookieCheck,
        },
    },
    {
        id: 'leetcode',
        aliases: [],
        webUrl: info => 'https://leetcode.cn/problems/' + info.id + '/',
        solutionPath: problemFile,
        sampleHtml: false,
        login: {
            loginUrl: 'https://leetcode.cn/accounts/login',
            domainSuffix: 'leetcode.cn',
            cookieCheck: cookie('LEETCODE_SESSION'),
            probe: async cookieHeader => {
                const response = await axios.post('https://leetcode.cn/graphql/noj-go',
                    { query: 'query userStatus { userStatus { isSignedIn username } }' },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': browserUA,
                            'Origin': 'https://leetcode.cn',
                            'Referer': 'https://leetcode.cn/',
                            'Cookie': cookieHeader,
                        },
                        timeout: 20000,
                        validateStatus: () => true,
                    });
                return response.data?.data?.userStatus?.isSignedIn === true;
            },
        },
    },
    {
        id: 'neuoj',
        aliases: [],
        webUrl: info => info.contestId
            ? 'https://oj.neu.edu.cn/contests/' + info.contestId
            : 'https://oj.neu.edu.cn/problems/' + info.id,
        solutionPath: problemFile,
        sampleHtml: true,
        login: {
            loginUrl: 'https://oj.neu.edu.cn/login',
            domainSuffix: 'oj.neu.edu.cn',
            // Session cookie exists before logging in, so always probe.
            cookieCheck: cookie('f_onlinejudge_session'),
            probe: async cookieHeader => {
                const response = await axios.get('https://oj.neu.edu.cn/problems/data?page=1&per_page=1', {
                    headers: { 'User-Agent': browserUA, 'Cookie': cookieHeader },
                    timeout: 20000,
                    maxRedirects: 0,
                    validateStatus: () => true,
                });
                return response.status === 200;
            },
        },
    },
    {
        id: 'csecg',
        aliases: [],
        webUrl: info => info.contestId
            ? 'http://neucsecg.neu.edu.cn/assignment/programList.jsp?proNum=' + info.id + '&assignID=' + info.contestId
            : 'http://neucsecg.neu.edu.cn/assignment/',
        solutionPath: assignmentFile,
        sampleHtml: false,
        login: {
            loginUrl: 'http://neucsecg.neu.edu.cn/',
            domainSuffix: 'neucsecg.neu.edu.cn',
            // JSESSIONID is issued before logging in, so always probe.
            cookieCheck: cookie('JSESSIONID'),
            probe: async cookieHeader => {
                const response = await axios.get('http://neucsecg.neu.edu.cn/assignment/', {
                    headers: { 'User-Agent': browserUA, 'Accept': 'text/html', 'Cookie': cookieHeader },
                    timeout: 20000,
                    maxRedirects: 0,
                    validateStatus: () => true,
                });
                // Unauthenticated visits answer 302, and established-but-guest
                // sessions answer 200 with an EMPTY body - only a real login
                // serves the (large) SPA shell. Content length is the tell.
                if (response.status < 200 || response.status >= 300) { return false; }
                const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
                return body.length > 500;
            },
        },
    },
    {
        id: 'hnuacm',
        aliases: ['hnu-acm'],
        webUrl: info => 'http://acm.hnu.edu.cn/online/?action=problem&type=show&id=' + info.id,
        solutionPath: problemFile,
        sampleHtml: true,
        login: {
            loginUrl: 'http://acm.hnu.edu.cn/online/?action=form&type=login',
            domainSuffix: 'acm.hnu.edu.cn',
            // JSESSIONID exists for guests too; verify that the submit page no
            // longer contains the legacy login form before saving it.
            cookieCheck: cookie('JSESSIONID'),
            probe: async cookieHeader => {
                const response = await axios.get('http://acm.hnu.edu.cn/online/?action=form&type=submitproblem', {
                    headers: { 'User-Agent': browserUA, 'Cookie': cookieHeader, 'Accept': 'text/html' },
                    timeout: 20000,
                    validateStatus: () => true,
                });
                const body = String(response.data ?? '');
                return response.status === 200 && !/Your Login Information|name=["']userid["']/i.test(body);
            },
        },
    },
    {
        id: 'hnucg',
        aliases: ['hnu-cg'],
        webUrl: info => info.contestId
            ? 'https://cg.hnu.edu.cn/assignment/programList.jsp?proNum=' + info.id + '&assignID=' + info.contestId
            : 'https://cg.hnu.edu.cn/assignment/',
        solutionPath: assignmentFile,
        sampleHtml: false,
        login: {
            loginUrl: 'https://cg.hnu.edu.cn/indexcs/simple.jsp?loginErr=0',
            domainSuffix: 'cg.hnu.edu.cn',
            cookieCheck: cookie('JSESSIONID'),
            probe: async cookieHeader => {
                const response = await axios.get('https://cg.hnu.edu.cn/assignment/', {
                    headers: { 'User-Agent': browserUA, 'Cookie': cookieHeader, 'Accept': 'text/html' },
                    timeout: 20000,
                    maxRedirects: 0,
                    validateStatus: () => true,
                });
                const body = String(response.data ?? '');
                return response.status === 200 && body.length > 500;
            },
        },
    },
    {
        id: 'hdoj',
        aliases: ['hduoj'],
        webUrl: info => 'http://acm.hdu.edu.cn/showproblem.php?pid=' + info.id,
        solutionPath: problemFile,
        sampleHtml: true,
        login: {
            loginUrl: 'http://acm.hdu.edu.cn/',
            domainSuffix: 'acm.hdu.edu.cn',
            // PHPSESSID exists before logging in too -> verify server-side.
            cookieCheck: cookie('PHPSESSID'),
            probe: async cookieHeader => {
                const response = await axios.get('http://acm.hdu.edu.cn/', {
                    headers: { 'User-Agent': browserUA, 'Cookie': cookieHeader },
                    timeout: 20000,
                    responseType: 'arraybuffer',
                    validateStatus: () => true,
                });
                const text = new TextDecoder('gb18030').decode(new Uint8Array(response.data));
                // Logged-in homepage carries the logout link.
                return /action=logout/i.test(text);
            },
        },
    },
    {
        id: 'codeforces',
        aliases: [],
        webUrl: info => {
            if (info.contestId) {
                return 'https://codeforces.com/problemset/problem/' + info.contestId + '/' + info.id;
            }
            const match = info.id.match(/^(\d+)(.*)$/);
            return match ? 'https://codeforces.com/problemset/problem/' + match[1] + '/' + match[2] : undefined;
        },
        solutionPath: rootFile,
        sampleHtml: true,
    },
    {
        id: 'fjutacm',
        aliases: [],
        webUrl: info => 'http://www.fjutacm.com/Problem.jsp?pid=' + info.id,
        solutionPath: rootFile,
        sampleHtml: true,
    },
];

const byName = new Map<string, PlatformAdapter>();
for (const adapter of platformAdapters) {
    byName.set(adapter.id.toLowerCase(), adapter);
    for (const alias of adapter.aliases) { byName.set(alias.toLowerCase(), adapter); }
}

/** Resolve a canonical id or readable alias. Case-insensitive. */
export function adapterFor(name: string | undefined | null): PlatformAdapter | undefined {
    return name ? byName.get(name.toLowerCase()) : undefined;
}
