'use strict';

// Notifications carry no file contents or paths. Reconciliation remains inside
// the authenticated writer queue when a client asks to synchronize.
function createLiveFileEvents({ getStatus }) {
    const clients = new Map();
    let pending;
    let heartbeat;
    let verification;

    function remove(res) {
        const listener = clients.get(res);
        if (listener) res.off('close', listener);
        clients.delete(res);
        if (!clients.size) {
            clearTimeout(pending); pending = undefined;
            clearInterval(heartbeat); heartbeat = undefined;
            clearInterval(verification); verification = undefined;
        }
    }
    function send(res, text) {
        try {
            if (!res.destroyed && !res.writableEnded && res.write(text)) return;
        } catch { /* A disconnected client must not fail a save or watcher. */ }
        remove(res);
        try { res.end(); } catch {}
    }
    function message(reason) {
        return `event: live-files\ndata: ${JSON.stringify({ ...getStatus(), reason })}\n\n`;
    }
    function publish(reason) {
        if (!clients.size) return;
        const text = message(reason);
        for (const res of clients.keys()) send(res, text);
    }
    function notify(reason = 'change') {
        if (!clients.size) return;
        if (reason === 'settings') {
            clearTimeout(pending); pending = undefined;
            publish(reason);
        } else if (!pending && getStatus().enabled) {
            // Collapse bursts without indefinitely postponing a notification.
            pending = setTimeout(() => {
                pending = undefined;
                if (getStatus().enabled) publish('change');
            }, 250);
            pending.unref?.();
        }
    }
    function connect(req, res) {
        req.setTimeout(0);
        res.setTimeout(0);
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-store',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        const onClose = () => remove(res);
        clients.set(res, onClose);
        res.on('close', onClose);
        send(res, message('ready'));
        if (clients.size && !heartbeat) {
            heartbeat = setInterval(() => {
                for (const client of clients.keys()) send(client, ': keepalive\n\n');
            }, 25_000);
            // OS watcher notifications can be lost. This replaces the old 750ms
            // polling, and disabled monitoring never asks for a verification.
            verification = setInterval(() => {
                if (getStatus().enabled) publish('verify');
            }, 60_000);
            heartbeat.unref?.(); verification.unref?.();
        }
    }
    function close() {
        for (const res of [...clients.keys()]) {
            remove(res);
            try { res.end(); } catch {}
        }
    }
    return { connect, notify, close };
}

module.exports = { createLiveFileEvents };
