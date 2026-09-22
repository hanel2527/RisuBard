function createProxyAbortController({ request, response, timeoutMs }) {
    const controller = new AbortController();
    let clientDisconnected = false;
    let upstreamFailed = false;
    let timedOut = false;
    let timer = null;

    const abortForClientDisconnect = () => {
        clientDisconnected = true;
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };
    const onResponseClose = () => {
        if (!response.writableFinished && !upstreamFailed && !timedOut) {
            abortForClientDisconnect();
        }
    };

    request.once('aborted', abortForClientDisconnect);
    response.once('close', onResponseClose);
    if (request.aborted || response.destroyed) {
        abortForClientDisconnect();
    }
    if (timeoutMs) {
        timer = setTimeout(() => {
            timedOut = true;
            if (!controller.signal.aborted) {
                controller.abort();
            }
        }, timeoutMs);
    }

    return {
        signal: controller.signal,
        clientDisconnected: () => clientDisconnected,
        timedOut: () => timedOut,
        markUpstreamFailure: () => { upstreamFailed = true; },
        cleanup: () => {
            if (timer) clearTimeout(timer);
            request.removeListener('aborted', abortForClientDisconnect);
            response.removeListener('close', onResponseClose);
        }
    };
}

module.exports = { createProxyAbortController };
