"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSourceFile = void 0;
const model_1 = require("../model");
function parseSourceFile(uri, baseCfg, code) {
    let cfg = Object.assign({
        pathParseRule: {
            contestProblem: "c\\/(\\d+)\\/(\\w+)[\\.\\w]*\\.(\\w+)$",
            problemProblem: "p\\/(\\w+)[\\.\\w]*\.(\\w+)$"
        }
    }, baseCfg);
    let matches;
    let path = uri.toString(true);
    if (matches = path.match(cfg.pathParseRule.contestProblem)) {
        if (matches !== null) {
            return new model_1.SourceFile(matches[2], matches[1], matches[3], code = code, uri = uri);
        }
    }
    else if (matches = path.match(cfg.pathParseRule.normalProblem)) {
        if (matches !== null) {
            return new model_1.SourceFile(matches[1], undefined, matches[2], code = code, uri = uri);
        }
    }
    return null;
}
exports.parseSourceFile = parseSourceFile;
