"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.playAudio = void 0;
const window_1 = require("../window");
function playAudio(src) {
    if (window_1.view === undefined) {
        return;
    }
    window_1.view.webview.postMessage({
        type: 'playAudio',
        src: src
    });
}
exports.playAudio = playAudio;
