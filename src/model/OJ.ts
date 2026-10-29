import { User } from './index';
import { SourceFile, Problem, ProblemInfo } from "./Problem";

/** One row in the built-in problem browser. */
export interface ProblemListEntry {
    id: string;
    title: string;
    /** Luogu 1-5, LeetCode Easy/Hard/... - shown as a tag in the tree. */
    difficulty?: string;
    /** CSECG: assignment id the problem belongs to (used for the file layout). */
    contestId?: string;
    /** Completion marker shown in the tree (e.g. "✓ 已AC"). */
    status?: string;
    /** CSECG: last submission time of this problem ("2026-09-22 19:40:05"). */
    submittedAt?: string;
    /** CSECG: assignment deadline ("2026-10-18 23:00:00"). */
    deadline?: string;
    /** CSECG: human assignment name ("第3次课后作业"). */
    assignmentName?: string;
    /** CSECG: the assignment is in its late-submission window (补交中). */
    late?: boolean;
    /** CSECG: assignment comes from the 历史作业 archive section. */
    history?: boolean;
}

export interface ProblemListPage {
    problems: ProblemListEntry[];
    hasMore: boolean;
}

/**
 * Everything related to this Online Judge Server.
 */
export interface OJ {
    /**
     * Attempt to login.
     */
    login(): Promise<User>;

    /**
     *  Submit a source file to the server.
     * @param sourceFile The source file related to this submit.
     */
    submit(sourceFile: SourceFile): Promise<Function>;
    /** Resume a known record without sending code again. */
    resumeSubmission?(recordId: string, sourceFile: SourceFile): Function;

    /**
     * Get problem detials
     * @param problemInfo The problem info related to this problem.
     */
    getProblem(problemInfo: ProblemInfo): Promise<Problem>;

    /**
     * Optional: search/list problems for the built-in problem browser.
     * @param keyword search keyword ("" = just list)
     * @param page 1-based page number
     */
    searchProblems?(keyword: string, page: number): Promise<ProblemListPage>;

    /**
     * Optional: languages the platform accepts, for the submit-time picker.
     * `value` goes into SourceFile.languageOverride, `label` is shown to the user.
     */
    listLanguages?(): Array<{ value: string | number; label: string }>;
}
