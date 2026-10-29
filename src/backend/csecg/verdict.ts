export interface CsecgVerdict {
    status: string;
    details: string;
}

/** CourseGrading deployments may return GBK JSON without a charset header. */
export function parseCsecgJudgeResponse(data: unknown, contentType = ''): CsecgVerdict {
    let payload: unknown = data;
    if (Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const declared = /charset\s*=\s*['"]?([^;'"\s]+)/i.exec(contentType)?.[1];
        const encodings = declared ? [declared, 'utf-8', 'gb18030'] : ['utf-8', 'gb18030'];
        let parsed = false;
        for (const encoding of new Set(encodings)) {
            try {
                payload = JSON.parse(new TextDecoder(encoding, { fatal: true }).decode(bytes));
                parsed = true;
                break;
            } catch { /* try the next encoding */ }
        }
        if (!parsed) { throw new Error('CSECG 返回的评测结果无法解析'); }
    } else if (typeof data === 'string') {
        try { payload = JSON.parse(data); }
        catch { throw new Error('CSECG 返回的评测结果无法解析'); }
    }
    if (!Array.isArray(payload)) { throw new Error('CSECG 返回的评测结果格式异常'); }
    const contents: string[] = [];
    let ret = '';
    for (const item of payload) {
        if (item && item.content !== undefined) { contents.push(String(item.content)); }
        if (item && item.ret !== undefined) { ret = String(item.ret); }
    }
    return parseCsecgVerdict(contents.join('\n'), ret);
}

/** Keep compiler diagnostics while removing the small amount of HTML used by CourseGrading. */
export function parseCsecgVerdict(content: string, ret: string): CsecgVerdict {
    const html = /<\/?(?:br|div|p|pre|table|tr|td|span|font|strong|b)\b/i.test(content);
    const readable = html
        ? content.replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(?:div|p|pre|tr)>/gi, '\n')
            .replace(/<\/?(?:div|p|pre|table|tr|td|span|font|strong|b)\b[^>]*>/gi, '')
        : content;
    const details = readable.replace(/&nbsp;|&#160;/gi, ' ').replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
    const t = details.replace(/[ \t]+/g, ' ');

    if (!t && ret === '1') { return { status: 'Pending...', details }; }
    if (/^(?:还未提交|尚未|排队|等待|评测中|正在|running|judging|pending|waiting)/i.test(t)) {
        return { status: 'Pending...', details };
    }
    if (/^编译中/.test(t)) { return { status: 'Judging...', details }; }
    if (/编译(?:错误|失败)|Compil(?:e|ation) (?:Error|Failed)|(?:fatal )?error\s*:/i.test(t)) {
        return { status: 'Compile Error', details };
    }
    if (/运行(?:时)?(?:错误|失败)|Runtime Error|Segmentation fault/i.test(t)) {
        return { status: 'Runtime Error', details };
    }
    if (/答案错误|Wrong Answer/i.test(t)) { return { status: 'Wrong Answer', details }; }
    if (/时间超限|运行超时|Time Limit Exceeded/i.test(t)) {
        return { status: 'Time Limit Exceeded', details };
    }
    // A generic "Memory" label is commonly a usage statistic, not the verdict.
    if (/内存(?:超限|超出限制|限制超出)|Memory Limit Exceeded|\bMLE\b/i.test(t)) {
        return { status: 'Memory Limit Exceeded', details };
    }
    if (/答案正确|全部通过|评测通过|(?:^|\n)通过(?:\s|$)|\bAccepted\b/i.test(t) && !/未通过/.test(t)) {
        return { status: 'Accepted', details };
    }
    return { status: t ? '评测结果未识别' : `评测结果未返回（状态 ${ret || '?'}）`, details };
}
