'use strict';

function createQueuedSaveDebounce({ timers, queue, delay, onError }) {
    return function schedule(key, persist) {
        if (timers[key]) clearTimeout(timers[key]);
        const timer = setTimeout(() => {
            queue(async () => {
                // A flush, full write or newer timer may have superseded us while
                // waiting for the single writer. Capture the write scope only now.
                if (timers[key] !== timer) return;
                try {
                    await persist();
                } finally {
                    if (timers[key] === timer) delete timers[key];
                }
            }).catch(onError);
        }, delay);
        timers[key] = timer;
    };
}

module.exports = { createQueuedSaveDebounce };
