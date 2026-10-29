import * as vscode from "vscode";

export class ProblemSubmit {
    id!: number;
    user!: string;
    pid!: any;
    lang!: string;
    time!: string;
    memory!: string;
    codelen!: number;
    date!: Date;
    result!: string;
    details?: string;
}
export interface ProblemInfo {
    id: string;
    contestId: string | undefined;
}
export class Problem implements ProblemInfo {
    constructor(
        public id: string,
        public contestId: string | undefined,
        public content: {
            "title": string;
            "desc": string;
            "input": string;
            "output": string;
            "sampleInput": Array<string>;
            "sampleOutput": Array<string>;
            [key: string] : any;
        }
    ) { }
    
}
export class SourceFile implements ProblemInfo {
    constructor(
        public id: string,
        public contestId: string | undefined,
        public sourceType: string,
        public code: string,
        public uri: vscode.Uri,
        /** Language chosen by the submit-time picker (overrides auto-map). */
        public languageOverride?: string | number,
    ) { }

    public get dataInputFile(): vscode.Uri {
        // Code Runner reads $dirWithoutTrailingSlash/$fileNameWithoutExt.in.
        // Keep the input beside the source, including contest/problem folders.
        const stem = this.uri.path.split('/').pop()!.replace(/\.[^.]+$/, '');
        return vscode.Uri.joinPath(this.uri, '..', `${stem}.in`);
    }
}
