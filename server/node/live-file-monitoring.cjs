'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { commitTransaction, recoverTransactions, readVerifiedJson } = require('./file-store.cjs');
const { createLiveCharacterFiles } = require('./live-character-files.cjs');
const CONFIG = 'config/live-file-monitoring.json';

function createLiveFileMonitoring(options) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const defaultEnabled = platform !== 'android' && !String(env.PREFIX || '').includes('com.termux');
    const root = options.repository.dataRoot;
    recoverTransactions(root);
    const saved = fs.existsSync(path.join(root, CONFIG))
        ? readVerifiedJson(root, CONFIG, { allowBackup: false }) : null;
    if (saved && typeof saved.enabled !== 'boolean') throw new Error('Invalid live file monitoring setting');
    const monitor = createLiveCharacterFiles({ ...options, enabled: saved?.enabled ?? defaultEnabled });
    const status = () => ({ enabled: monitor.isEnabled(), defaultEnabled });
    return {
        ...monitor,
        status,
        setEnabled(enabled) {
            if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
            recoverTransactions(root);
            const previous = monitor.isEnabled();
            monitor.setEnabled(enabled);
            try { commitTransaction(root, [{ path: CONFIG, data: Buffer.from(`${JSON.stringify({ enabled })}\n`) }]); }
            catch (error) { monitor.setEnabled(previous); throw error; }
            return status();
        },
    };
}

module.exports = { createLiveFileMonitoring };
