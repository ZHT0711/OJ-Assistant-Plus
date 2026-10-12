"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimpleKeySecretCredential = exports.SimpleTokenCredential = exports.SimpleUserPasswordCredential = void 0;
class SimpleUserPasswordCredential {
    constructor(username, password) {
        this.username = username;
        this.password = password;
    }
}
exports.SimpleUserPasswordCredential = SimpleUserPasswordCredential;
class SimpleTokenCredential {
    constructor(token) {
        this.token = token;
    }
}
exports.SimpleTokenCredential = SimpleTokenCredential;
class SimpleKeySecretCredential {
    constructor(key, secret) {
        this.key = key;
        this.secret = secret;
    }
}
exports.SimpleKeySecretCredential = SimpleKeySecretCredential;
