/** One registry shared by the picker, templates, source lookup and runner. */
export type PracticeLanguageId = 'cpp' | 'c' | 'py' | 'js' | 'java' | 'go' | 'rs';
export type ToolId = 'cpp' | 'c' | 'python' | 'node' | 'javac' | 'java' | 'go' | 'rust';
export const tools: { [id in ToolId]: { setting: string; command: string; versionArgs: string[] } } = {
    cpp: { setting: 'cppCompiler', command: 'g++', versionArgs: ['--version'] },
    c: { setting: 'cCompiler', command: 'gcc', versionArgs: ['--version'] },
    python: { setting: 'pythonCommand', command: 'python', versionArgs: ['--version'] },
    node: { setting: 'nodeCommand', command: 'node', versionArgs: ['--version'] },
    javac: { setting: 'javaCompiler', command: 'javac', versionArgs: ['-version'] },
    java: { setting: 'javaCommand', command: 'java', versionArgs: ['-version'] },
    go: { setting: 'goCommand', command: 'go', versionArgs: ['version'] },
    rust: { setting: 'rustCompiler', command: 'rustc', versionArgs: ['--version'] },
};
export interface PracticeLanguage {
    id: PracticeLanguageId;
    label: string;
    tools: ToolId[];
    template: string;
}
export const languages: PracticeLanguage[] = [
    {
        id: 'cpp', label: 'C++ 17', tools: ['cpp'],
        template: '#include <iostream>\n#include <vector>\n#include <algorithm>\n#include <string>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    // 在这里编写解题代码\n\n    return 0;\n}\n',
    },
    {
        id: 'c', label: 'C 11', tools: ['c'],
        template: '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n\nint main(void) {\n    /* 在这里编写解题代码 */\n\n    return 0;\n}\n',
    },
    {
        id: 'py', label: 'Python 3', tools: ['python'],
        template: 'import sys\n\n\ndef solve():\n    data = sys.stdin.buffer.read().split()\n    # 在这里编写解题代码\n\n\nif __name__ == "__main__":\n    solve()\n',
    },
    {
        id: 'js', label: 'JavaScript (Node.js)', tools: ['node'],
        template: "const fs = require('fs');\nconst input = fs.readFileSync(0, 'utf8').trim();\nconst tokens = input ? input.split(/\\s+/) : [];\n\n// 在这里编写解题代码\n",
    },
    {
        id: 'java', label: 'Java (Main)', tools: ['javac', 'java'],
        template: 'import java.io.*;\nimport java.util.*;\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n        Scanner in = new Scanner(new BufferedInputStream(System.in));\n        // 在这里编写解题代码\n    }\n}\n',
    },
    {
        id: 'go', label: 'Go', tools: ['go'],
        template: 'package main\n\nimport (\n    "bufio"\n    "fmt"\n    "os"\n)\n\nfunc main() {\n    in := bufio.NewReader(os.Stdin)\n    out := bufio.NewWriter(os.Stdout)\n    defer out.Flush()\n\n    // 在这里编写解题代码；示例为读入并输出一个字符串\n    var value string\n    if _, err := fmt.Fscan(in, &value); err == nil {\n        fmt.Fprintln(out, value)\n    }\n}\n',
    },
    {
        id: 'rs', label: 'Rust 2021', tools: ['rust'],
        template: 'use std::io::{self, Read};\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n    let mut tokens = input.split_whitespace();\n\n    // 在这里编写解题代码；示例为读入并输出一个字符串\n    if let Some(value) = tokens.next() {\n        println!("{}", value);\n    }\n}\n',
    },
];
export function languageById(id: unknown): PracticeLanguage | undefined {
    return languages.find(language => language.id === id);
}
export function languageForSource(source: string): PracticeLanguage | undefined {
    const extension = source.split('.').pop()?.toLowerCase();
    return languageById(extension === 'cc' || extension === 'cxx' ? 'cpp' : extension === 'py3' ? 'py' : extension);
}
