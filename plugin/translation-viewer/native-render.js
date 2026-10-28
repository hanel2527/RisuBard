import { TEMPORARY_MARK } from './message-swap.js';

const BODY_STAMP = 'x-rtv-capture';
const PROBE = 'x-rtv-render-probe';
const TIMEOUT = 30000;
const release = value => { value?.release?.(); };
const cancelled = () => new Error('표시 후처리가 중단되었습니다. 원문을 복구합니다.');
const rowSelector = (index, id) => `.risu-chat[data-chat-index="${index}"][data-chat-id="${CSS.escape(id)}"]`;

function pause(signal, milliseconds = 60) {
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(cancelled()); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
        signal.addEventListener('abort', abort, { once: true });
    });
}

// These tokens pass unchanged through Chat.displaya's initial CBS parser. For
// arbitrary CBS an unchanged msgDisplay can retain an older pending render. A
// remount proves a new render; without one we refuse that ambiguous capture.
function literalDisplayInput(text) {
    return !/\{\{|\{#|<(?:user|char|bot)>/i.test(text.replace(
        /\{\{(?:asset|emotion|audio|bg|bgm|video|video-img|image|img|path|raw|inlay|inlayed|inlayeddata|source)::[^{}]*\}\}/gi, '',
    ));
}
let htmlDocument;
function parseHTML(html) {
    htmlDocument ??= document.implementation.createHTMLDocument('');
    const body = htmlDocument.createElement('div');
    body.innerHTML = html;
    return body;
}

function nativeAssetKey(url) {
    const match = url.match(/^(?:https?:\/\/[^/]+)?\/(?:api\/asset|sw\/img)\/([a-f\d]+)(?:[?#].*)?$/i);
    if (!match || match[1].length % 2) return null;
    return new TextDecoder().decode(Uint8Array.from(match[1].match(/../g), byte => parseInt(byte, 16)));
}

function dataURL(bytes, type) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('어셋 데이터를 읽지 못했습니다.'));
        reader.readAsDataURL(new Blob([bytes], { type }));
    });
}

// Only materialize resources the native renderer actually kept. Never resurrect
// assets removed by display scripts or the host's image-hiding preference.
async function materialize(api, html, signal) {
    const body = parseHTML(html);
    const resources = new Map();
    const inlays = new Map();
    const readInlay = id => {
        if (!inlays.has(id)) inlays.set(id, (async () => {
            const asset = await api.readInlay(id);
            if (!asset || typeof asset.data !== 'string' || !asset.data.startsWith('data:')) {
                throw new Error('인레이를 읽지 못했습니다. 인레이 접근 권한과 원본 파일을 확인해 주세요.');
            }
            return asset;
        })());
        return inlays.get(id);
    };
    const resource = async url => {
        if (signal.aborted) throw cancelled();
        if (!url || /^(?:data:|https?:|\/)/i.test(url) && !nativeAssetKey(url)) return url;
        if (!resources.has(url)) resources.set(url, (async () => {
            const key = nativeAssetKey(url);
            if (key?.startsWith('inlay/')) return (await readInlay(key.slice(6))).data;
            if (key?.startsWith('assets/')) {
                const bytes = await api.readImage(key);
                if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error('어셋 파일을 읽지 못했습니다.');
                const extension = key.split('.').at(-1).toLowerCase();
                const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' }[extension] ?? 'image/png';
                return await dataURL(bytes, type);
            }
            if (/^(?:blob:|file:|tauri:|asset:)/i.test(url)) {
                throw new Error('이 어셋의 임시 URL을 안전하게 저장할 수 없습니다. 원문을 복구했습니다.');
            }
            return url;
        })());
        return await resources.get(url);
    };

    for (const node of body.querySelectorAll('[data-inlay-id]')) {
        const id = node.getAttribute('data-inlay-id');
        const asset = await readInlay(id);
        const media = body.ownerDocument.createElement(asset.type === 'video' ? 'video' : asset.type === 'audio' ? 'audio' : 'img');
        media.setAttribute('src', asset.data);
        if (media.tagName !== 'IMG') media.setAttribute('controls', '');
        if (media.tagName === 'IMG') {
            media.setAttribute('data-inlay-image-id', id);
            media.setAttribute('data-inlay-occurrence', node.getAttribute('data-inlay-occurrence') ?? '0');
        }
        node.replaceWith(media);
    }
    for (const image of body.querySelectorAll('img[data-inlay-image-id]')) {
        image.setAttribute('src', (await readInlay(image.getAttribute('data-inlay-image-id'))).data);
        image.style.removeProperty('animation');
    }
    for (const node of body.querySelectorAll('[src], [poster]')) {
        for (const name of ['src', 'poster']) {
            if (node.hasAttribute(name)) node.setAttribute(name, await resource(node.getAttribute(name)));
        }
    }
    for (const node of body.querySelectorAll('[srcset]')) {
        let set = node.getAttribute('srcset');
        for (const match of [...set.matchAll(/(?:https?:\/\/[^/\s,]+)?\/(?:api\/asset|sw\/img)\/[a-f\d]+(?:[?#][^\s,]*)?/gi)]) {
            set = set.replaceAll(match[0], await resource(match[0]));
        }
        if (/(?:blob:|file:|tauri:|asset:)/i.test(set)) {
            throw new Error('어셋의 임시 srcset URL을 안전하게 저장할 수 없습니다.');
        }
        node.setAttribute('srcset', set);
    }
    const rewriteCSS = async css => {
        const matches = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)];
        for (const match of matches) {
            const replacement = await resource(match[2]);
            if (replacement !== match[2]) css = css.replace(match[0], `url("${replacement}")`);
        }
        return css;
    };
    for (const node of body.querySelectorAll('[style]')) node.setAttribute('style', await rewriteCSS(node.getAttribute('style')));
    for (const node of body.querySelectorAll('style')) node.textContent = await rewriteCSS(node.textContent);
    for (const node of body.querySelectorAll('.inlay-image-remove')) node.remove();
    for (const node of body.querySelectorAll('.inlay-image-control')) node.replaceWith(...node.childNodes);
    if (signal.aborted) throw cancelled();
    return body.innerHTML;
}

export function createNativeRenderer(api, doc, swaps, onChange = () => {}) {
    let disposed = false;
    let active;
    let rendering;
    let gate;
    let error = '';
    const notify = () => { try { onChange(); } catch { /* UI owns its errors. */ } };
    const closeGate = () => {
        if (disposed || gate) return;
        let open;
        const promise = new Promise(resolve => { open = resolve; });
        gate = { promise, open };
    };
    const openGate = () => { const previous = gate; gate = null; previous?.open(); };
    const displayGate = async text => { const barrier = gate; if (barrier) await barrier.promise; return text; };

    async function target(context, signal, token) {
        if (disposed || signal.aborted) throw cancelled();
        const characterIndex = await api.getCurrentCharacterIndex();
        const chatIndex = await api.getCurrentChatIndex();
        const character = await api.getCharacter();
        const chat = character?.chats?.[chatIndex];
        const index = chat?.message?.findIndex(message => message.chatId === context.messageId);
        if (character?.chaId !== context.characterId || chat?.id !== context.chatId || !(index >= 0)
            || characterIndex !== await api.getCurrentCharacterIndex() || chatIndex !== await api.getCurrentChatIndex()) {
            throw new Error('후처리 중 대화가 바뀌었습니다. 원문을 복구합니다.');
        }
        const message = chat.message[index];
        if (chat.isStreaming || message.role !== 'char' || message.isComment || token && message[TEMPORARY_MARK] !== token) {
            throw new Error('후처리 대상 메시지가 변경되었습니다. 원문을 복구합니다.');
        }
        const row = await doc.querySelector(rowSelector(index, context.messageId));
        let body;
        let original;
        let nativeTranslation;
        try {
            body = row && await row.querySelector('.chattext');
            original = body && await body.querySelector(':scope > [data-painter-body]');
            nativeTranslation = row && await row.querySelector('.button-icon-translate.text-info');
            if (!original || nativeTranslation) throw new Error('원문 메시지 화면에서 후처리할 수 있습니다. 편집·내장 번역을 끄고 대상 메시지를 열어 주세요.');
            return { row, body, original, index, message };
        } catch (cause) {
            release(row); release(body); release(original);
            throw cause;
        } finally { release(nativeTranslation); }
    }
    const releaseTarget = found => { if (found) for (const element of [found.row, found.body, found.original]) release(element); };

    async function probeCommit(context, signal, stamp, token) {
        const found = await target(context, signal, token);
        const probe = await doc.createElement('span');
        try {
            await found.original.setAttribute(BODY_STAMP, stamp);
            await probe.setAttribute(PROBE, stamp);
            await probe.setStyle('display', 'none');
            await found.original.appendChild(probe);
        } finally { release(probe); releaseTarget(found); }
        openGate();
        const deadline = Date.now() + TIMEOUT;
        while (Date.now() < deadline) {
            const current = await target(context, signal, token);
            let pending;
            try {
                if (await current.original.getAttribute(BODY_STAMP) !== stamp) {
                    throw new Error('후처리 도중 표시 영역이 교체되었습니다. 다시 시도해 주세요.');
                }
                pending = await current.original.querySelector(`[${PROBE}="${stamp}"]`);
                if (!pending) return await current.original.getInnerHTML();
            } finally { release(pending); releaseTarget(current); }
            await pause(signal);
        }
        throw new Error('본체의 표시 후처리 완료를 확인하지 못했습니다. 원문을 복구합니다.');
    }

    return {
        get busy() { return Boolean(active); },
        get error() { return error || swaps.error; },
        async render(context, text) {
            if (disposed) throw cancelled();
            if (active) throw new Error('다른 메시지의 후처리와 원문 복구가 진행 중입니다.');
            const controller = new AbortController();
            let finish;
            rendering = new Promise(resolve => { finish = resolve; });
            active = controller;
            error = '';
            notify();
            const stamp = `rtv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            let style;
            let registered = false;
            let restored = false;
            let swapped = false;
            try {
                const before = await target(context, controller.signal);
                try {
                    if (before.message.data !== context.source) throw new Error('번역 중 원문이 수정되었습니다. 현재 원문으로 다시 시도해 주세요.');
                    await before.original.setAttribute(BODY_STAMP, stamp);
                    style = await doc.createElement('style');
                    await style.setTextContent(`${rowSelector(before.index, context.messageId)} { pointer-events: none !important; } ${rowSelector(before.index, context.messageId)} .chattext > [data-painter-body] { visibility: hidden !important; }`);
                    const head = await doc.querySelector('head');
                    try { await head.appendChild(style); } finally { release(head); }
                } finally { releaseTarget(before); }
                closeGate();
                await api.addRisuScriptHandler('display', displayGate);
                registered = true;
                const html = await swaps.run(context, text, async ({ signal, token }) => {
                    swapped = true;
                    const abort = () => controller.abort();
                    signal.addEventListener('abort', abort, { once: true });
                    if (signal.aborted) controller.abort();
                    try {
                        const current = await target(context, controller.signal, token);
                        try {
                            const remounted = await current.original.getAttribute(BODY_STAMP) !== stamp;
                            if (!remounted && (text === context.source || !literalDisplayInput(context.source) || !literalDisplayInput(text))) {
                                throw new Error('본문 CBS가 같아지거나 같은 원문을 반환하여 새 렌더링을 식별할 수 없습니다. 안전을 위해 원문을 복구합니다.');
                            }
                        } finally { releaseTarget(current); }
                        await probeCommit(context, controller.signal, stamp, token);
                        // checkImg runs after the commit, without awaiting its asset reads.
                        const deadline = Date.now() + TIMEOUT;
                        let html;
                        while (Date.now() < deadline) {
                            const found = await target(context, controller.signal, token);
                            try {
                                if (await found.original.getAttribute(BODY_STAMP) !== stamp) throw new Error('후처리 표시 영역이 교체되었습니다.');
                                html = await found.original.getInnerHTML();
                            } finally { releaseTarget(found); }
                            const body = parseHTML(html);
                            const unresolved = [...body.querySelectorAll('img[src]:not([noimage])')].some(image => {
                                const src = image.getAttribute('src');
                                return src && !/^(?:data:|https?:|blob:|file:|tauri:|\/)/i.test(src);
                            });
                            if (!unresolved) return await materialize(api, html, controller.signal);
                            await pause(controller.signal);
                        }
                        throw new Error('어셋 주소가 준비되지 않았습니다. 원문을 복구합니다.');
                    } finally {
                        signal.removeEventListener('abort', abort);
                        // Keep restoration's native render behind a second DOM-only probe.
                        closeGate();
                    }
                });
                restored = true;
                return html;
            } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause);
                throw cause;
            } finally {
                try {
                    // run also restores before rejecting. Do not hide the original indefinitely
                    // on a switched/unmounted chat; the new view will render restored data.
                    if (swapped && !disposed && !controller.signal.aborted && !swaps.busy) {
                        try {
                            await probeCommit(context, controller.signal, `${stamp}-restore`);
                            restored = true;
                        } catch (cause) {
                            if (!restored) error = cause instanceof Error ? cause.message : String(cause);
                        }
                    }
                    openGate();
                    if (registered) await api.removeRisuScriptHandler('display', displayGate).catch(() => {});
                    const probes = await doc.querySelectorAll(`[${PROBE}="${stamp}"], [${PROBE}="${stamp}-restore"]`).catch(() => null);
                    if (probes) {
                        try {
                            for (const probe of await api.unwarpSafeArray(probes)) { await probe.remove().catch(() => {}); release(probe); }
                        } finally { release(probes); }
                    }
                    const bodies = await doc.querySelectorAll(`[${BODY_STAMP}="${stamp}"], [${BODY_STAMP}="${stamp}-restore"]`).catch(() => null);
                    if (bodies) {
                        try {
                            for (const body of await api.unwarpSafeArray(bodies)) { await body.setAttribute(BODY_STAMP, '').catch(() => {}); release(body); }
                        } finally { release(bodies); }
                    }
                } finally {
                    await style?.remove().catch(() => {});
                    release(style);
                    active = null;
                    finish();
                    notify();
                }
            }
        },
        async dispose() {
            disposed = true;
            active?.abort();
            openGate();
            await swaps.dispose();
            await rendering;
        },
    };
}
