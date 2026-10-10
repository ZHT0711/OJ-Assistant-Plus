'use strict';
// Bundle KaTeX styling (CSS + woff2/woff fonts) into assets/katex so the
// problem webview renders math fully offline - no CDN dependency.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'katex', 'dist');
const dst = path.join(__dirname, '..', 'assets', 'katex');

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'fonts'), { recursive: true });

fs.copyFileSync(path.join(src, 'katex.min.css'), path.join(dst, 'katex.min.css'));

const fontsDir = path.join(src, 'fonts');
let copied = 0, bytes = 0;
for (const name of fs.readdirSync(fontsDir)) {
    // woff2 + woff cover every VS Code/Electron build; drop the ttf payloads.
    if (!/\.(woff2|woff)$/.test(name)) { continue; }
    const from = path.join(fontsDir, name);
    fs.copyFileSync(from, path.join(dst, 'fonts', name));
    copied += 1;
    bytes += fs.statSync(from).size;
}
console.log(`katex assets copied: katex.min.css + ${copied} fonts (${(bytes / 1024).toFixed(0)} KB) -> assets/katex/`);
