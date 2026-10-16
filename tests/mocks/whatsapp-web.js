/**
 * A stand-in for whatsapp-web.js, wired in via jest.config.js
 * moduleNameMapper.
 *
 * Why mock at this level rather than mocking src/whatsapp-client.js: the
 * client module contains logic worth testing for real — session isolation
 * per tenant, the SSE client registry and its caps, the JID construction that
 * stops a caller from sending to a group, backoff and the give-up threshold.
 * Replacing that module wholesale would leave all of it untested. Replacing
 * only the library keeps our code in the test and takes Chrome out of it.
 *
 * The fake Client is event-driven like the real one, so tests can drive
 * 'qr' / 'ready' / 'disconnected' / 'auth_failure' and assert what the
 * application does with each.
 */
const { EventEmitter } = require('events');

const instances = [];

class FakeClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.initialized = false;
        this.destroyed = false;
        this.sent = [];
        this.info = null;
        this.state = 'OPENING';
        instances.push(this);
    }

    async initialize() {
        this.initialized = true;
        if (FakeClient.autoReady) {
            // Asynchronous, like the real thing: the caller must not depend
            // on 'ready' having fired by the time initialize() resolves.
            setImmediate(() => this.becomeReady());
        }
        return this;
    }

    becomeReady(phone = '911234567890') {
        this.info = { wid: { user: phone } };
        this.state = 'CONNECTED';
        this.emit('authenticated');
        this.emit('ready');
    }

    emitQr(data = 'fake-qr-payload') {
        this.emit('qr', data);
    }

    async getState() {
        if (FakeClient.getStateError) throw new Error(FakeClient.getStateError);
        return this.state;
    }

    async sendMessage(chatId, text) {
        if (FakeClient.sendError) throw new Error(FakeClient.sendError);
        this.sent.push({ chatId, text });
        return { id: { _serialized: `fake_${this.sent.length}_${Date.now()}` } };
    }

    async logout() {
        this.state = 'DISCONNECTED';
    }

    async destroy() {
        this.destroyed = true;
        this.state = 'DISCONNECTED';
        this.info = null;
    }
}

// Test-controlled behaviour switches.
FakeClient.autoReady = false;
FakeClient.sendError = null;
FakeClient.getStateError = null;

class LocalAuth {
    constructor(options = {}) {
        this.options = options;
        this.dataPath = options.dataPath;
    }
}

class MessageMedia {
    constructor(mimetype, data, filename = null) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
    }

    static fromFilePath(filePath) {
        const fs = require('fs');
        const path = require('path');
        const data = fs.readFileSync(filePath).toString('base64');
        const ext = path.extname(filePath).toLowerCase();
        let mimetype = 'application/octet-stream';
        if (ext === '.jpg' || ext === '.jpeg') mimetype = 'image/jpeg';
        else if (ext === '.png') mimetype = 'image/png';
        else if (ext === '.webp') mimetype = 'image/webp';
        return new MessageMedia(mimetype, data, path.basename(filePath));
    }
}

module.exports = {
    Client: FakeClient,
    LocalAuth,
    MessageMedia,
    // Test helpers (not part of the real library's surface).
    __instances: instances,
    __reset() {
        instances.length = 0;
        FakeClient.autoReady = false;
        FakeClient.sendError = null;
        FakeClient.getStateError = null;
    },
    __last() {
        return instances[instances.length - 1];
    },
    __setAutoReady(value) { FakeClient.autoReady = value; },
    __setSendError(msg) { FakeClient.sendError = msg; },
    __setGetStateError(msg) { FakeClient.getStateError = msg; }
};
