'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const progress = require('./import-progress.cjs');

(async () => {
    const { id, moduleFile, method, input } = workerData;
    const stop = id === undefined ? () => {} : progress.listen(id, row => {
        parentPort.postMessage({ type: 'progress', row });
    });
    try {
        const result = await progress.withImportProgress(id, () => require(moduleFile)[method](input));
        parentPort.postMessage({ type: 'result', result });
    } catch (error) {
        parentPort.postMessage({ type: 'failure', error: {
            name: error?.name || 'Error', message: error?.message || String(error),
            importStage: error?.importStage,
            stack: error?.stack, code: error?.code, canonicalWriteMeta: error?.canonicalWriteMeta,
        } });
    } finally {
        stop();
        parentPort.close();
    }
})();
