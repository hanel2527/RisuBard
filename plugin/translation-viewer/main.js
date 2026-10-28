import MarkdownIt from 'markdown-it';
import { createEngine } from './engine.js';
import { registerSettings } from './settings.js';

const ROW_MARK = 'x-rtv-row';
const BODY_MARK = 'x-rtv-body';
const MODE_MARK = 'x-rtv-show';
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false });
const css = `
.rtv-translation { display: none; overflow-wrap: anywhere; pointer-events: none; user-select: none; }
.chattext[x-rtv-show="translation"] > [data-painter-body] { display: none !important; }
.chattext[x-rtv-show="translation"] > .rtv-translation { display: block; }
.rtv-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .65em; margin: .6em 0; font-size: .8rem; color: inherit; }
.rtv-controls button { cursor: pointer; padding: .25em .6em; border: 1px solid currentColor; border-radius: .35em; background: transparent; color: inherit; }
.rtv-controls button:hover { opacity: .75; }
.rtv-status { opacity: .8; white-space: pre-wrap; overflow-wrap: anywhere; }
`;

function contextFor(character, chat, message) {
    if (![character?.chaId, chat?.id, message?.chatId].every(id => typeof id === 'string' && id)
        || message.role !== 'char' || message.isComment
        || typeof message.data !== 'string' || !message.data.trim()) return null;
    return {
        characterId: character.chaId,
        chatId: chat.id,
        messageId: message.chatId,
        source: message.data,
        translatorNote: character.type === 'character' ? character.translatorNote ?? '' : '',
    };
}

function rowSelector(index, id) {
    return `.risu-chat[data-chat-index="${index}"][data-chat-id="${CSS.escape(id)}"]`;
}

// Only plugin-owned nodes and x- attributes are changed. No chat write API is used.
export async function startTranslationViewer(api) {
    let disposed = false;
    let doc;
    let style;
    let observer;
    let engine;
    let settingsCleanup;
    let timer;
    let poll;
    let refreshing = false;
    let refreshAgain = false;
    let sequence = 0;
    let selection = null;
    let uiError = '';
    let initialization = Promise.resolve();
    let activeRefresh = Promise.resolve();
    const views = new Map();
    const originalMode = new Set();
    const pendingOutputs = new Map();
    const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const release = object => { object?.release?.(); };

    const logError = (error) => {
        uiError = error instanceof Error ? error.message : String(error);
        console.error('[원문 보존 번역]', error);
    };
    const cleanupView = async (view) => {
        views.delete(view.token);
        // Removing our display attribute restores the core's original display:contents.
        await Promise.allSettled([
            view.body.setAttribute(MODE_MARK, ''),
            view.body.setAttribute(BODY_MARK, ''),
            view.row.setAttribute(ROW_MARK, ''),
            view.translation.remove(),
            view.controls.remove(),
            ...view.listeners.map(([button, id]) => button.removeEventListener('click', id)),
        ]);
        for (const element of [view.row, view.body, view.translation, view.controls,
            view.toggle, view.retry, view.status]) release(element);
    };
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        clearInterval(poll);
        engine?.dispose();
        pendingOutputs.clear();
        // Remove the hiding rule first, before the host's one-second unload deadline.
        await style?.remove();
        await Promise.allSettled([initialization, activeRefresh]);
        engine?.dispose();
        clearInterval(poll);
        await style?.remove();
        await Promise.allSettled([
            observer?.disconnect(),
            ...Array.from(views.values(), cleanupView),
            settingsCleanup?.(),
            api.removeRisuChatListener('output', onOutput),
        ]);
    };
    await api.onUnload(dispose);

    function schedule(mutations) {
        release(mutations);
        if (disposed || timer) return;
        timer = setTimeout(() => {
            timer = null;
            if (refreshing) { refreshAgain = true; return; }
            activeRefresh = refresh().catch(logError);
        }, 100);
    }

    async function readSelection() {
        const characterIndex = await api.getCurrentCharacterIndex();
        if (characterIndex === null || characterIndex === undefined || characterIndex < 0) return null;
        const chatIndex = await api.getCurrentChatIndex();
        const character = await api.getCharacter();
        if (disposed || characterIndex !== await api.getCurrentCharacterIndex()
            || chatIndex !== await api.getCurrentChatIndex()) return null;
        const chat = character?.chats?.[chatIndex];
        return chat?.id && Array.isArray(chat.message)
            ? { characterIndex, chatIndex, character, chat } : null;
    }

    async function generationIdle() {
        const ready = await doc.querySelector('.button-icon-send');
        const idle = Boolean(ready);
        release(ready);
        return idle;
    }

    async function setLabel(view, field, element, value) {
        if (view[field] === value) return;
        await element.setTextContent(value);
        view[field] = value;
    }

    async function paint(view, snapshot) {
        const entry = await engine.get(view.context);
        if (disposed) return;
        const busy = engine.isBusy(view.context);
        const nativeButton = await view.row.querySelector('.button-icon-translate.text-info');
        view.nativeTranslated = Boolean(nativeButton);
        release(nativeButton);
        const showTranslation = Boolean(entry && engine.isEnabled(view.context.characterId)
            && !view.nativeTranslated && !snapshot.chat.isStreaming && !originalMode.has(view.key));
        if (entry && view.renderedText !== entry.text) {
            // SafeElement sanitizes the HTML too; Markdown's raw HTML is intentionally off.
            await view.translation.setInnerHTML(markdown.render(entry.text));
            view.renderedText = entry.text;
        }
        const mode = showTranslation ? 'translation' : 'original';
        if (view.mode !== mode) {
            await view.body.setAttribute(MODE_MARK, mode);
            view.mode = mode;
        }
        await setLabel(view, 'toggleLabel', view.toggle,
            view.nativeTranslated ? '내장 번역 끄기 필요' : !entry ? '번역' : showTranslation ? '원문 보기' : '번역 보기');
        await setLabel(view, 'retryLabel', view.retry, busy ? '번역 중…' : '다시 번역');
        const error = engine.error(view.context) || uiError;
        const status = view.nativeTranslated ? '앱의 번역 버튼과 자동 번역을 꺼 주세요.' : error || (busy ? '번역 중 — 기존 표시 유지'
            : snapshot.chat.isStreaming ? '응답 완료 후 번역할 수 있습니다.'
            : entry && entry.source !== view.context.source ? '원문 수정됨 · 기존 번역 유지'
            : showTranslation ? '번역문은 읽기 전용 · 편집은 원문 보기' : '');
        await setLabel(view, 'statusLabel', view.status, status);
    }

    async function freshContext(view) {
        const current = await readSelection();
        if (!current || current.chat.isStreaming || !engine.isEnabled(current.character.chaId) || !await generationIdle()) return null;
        const message = current.chat.message.find(message => message.chatId === view.context.messageId);
        const context = contextFor(current.character, current.chat, message);
        return context && engine.key(context) === view.key ? context : null;
    }

    async function act(view, force) {
        if (disposed || view.nativeTranslated || engine.isBusy(view.context)) return;
        const context = await freshContext(view);
        if (!context || disposed) return;
        const entry = await engine.get(context);
        if (entry && !force) {
            if (originalMode.has(view.key)) originalMode.delete(view.key);
            else originalMode.add(view.key);
            schedule();
            return;
        }
        try {
            const result = await engine.translate(context, { force });
            if (result && !disposed && !engine.error(context)) originalMode.delete(view.key);
        } catch (error) {
            logError(error);
        }
        schedule();
    }

    async function mount(row, body, index, context) {
        const token = `${session}-${++sequence}`;
        const translation = await doc.createElement('span');
        await translation.setClassName('rtv-translation');
        const controls = await doc.createElement('div');
        await controls.setClassName('rtv-controls');
        await controls.setAttribute('x-rtv-controls', token);
        const toggle = await doc.createElement('button');
        const retry = await doc.createElement('button');
        const status = await doc.createElement('span');
        await toggle.setAttribute('x-rtv-action', 'toggle');
        await retry.setAttribute('x-rtv-action', 'retry');
        await status.setClassName('rtv-status');
        await controls.appendChild(toggle);
        await controls.appendChild(retry);
        await controls.appendChild(status);
        const view = { token, row, body, index, context, key: engine.key(context),
            translation, controls, toggle, retry, status, listeners: [] };
        views.set(token, view);
        try {
            await row.setAttribute(ROW_MARK, token);
            await body.setAttribute(BODY_MARK, token);
            await body.appendChild(translation);
            // Outside .chattext: SafeElement click callbacks cannot stop native click-to-edit.
            const parent = await body.getParent();
            await parent.appendChild(controls);
            release(parent);
            view.listeners.push([toggle, await toggle.addEventListener('click', () => {
                void act(view, false).catch(logError);
            })]);
            view.listeners.push([retry, await retry.addEventListener('click', () => {
                void act(view, true).catch(logError);
            })]);
            if (disposed) await cleanupView(view);
            return view;
        } catch (error) {
            await cleanupView(view);
            throw error;
        }
    }

    async function reconcile(snapshot) {
        const seen = new Set();
        if (snapshot && engine.isEnabled(snapshot.character.chaId)) {
            const safeRows = await doc.querySelectorAll('.risu-chat[data-chat-index]');
            const rows = await api.unwarpSafeArray(safeRows);
            release(safeRows);
            for (const row of rows) {
                let body;
                let original;
                let retained = false;
                try {
                    if (disposed || !engine.isEnabled(snapshot.character.chaId)) continue;
                    const token = await row.getAttribute(ROW_MARK);
                    let view = views.get(token);
                    let index = view?.index;
                    let message = snapshot.chat.message[index];
                    if (!view || !message || !await row.matches(rowSelector(index, message.chatId))) {
                        // SafeElement cannot read data-* directly; parse only the opening tag.
                        const html = await row.getOuterHTML();
                        const tag = new DOMParser().parseFromString(html.slice(0, html.indexOf('>') + 1), 'text/html').body.firstElementChild;
                        index = Number(tag?.getAttribute('data-chat-index'));
                        message = snapshot.chat.message[index];
                        if (!Number.isInteger(index) || index < 0 || !message
                            || tag?.getAttribute('data-chat-id') !== message.chatId) continue;
                    }
                    const context = contextFor(snapshot.character, snapshot.chat, message);
                    if (!context) continue;
                    body = await row.querySelector('.chattext');
                    original = body && await body.querySelector(':scope > [data-painter-body]');
                    if (!original) continue;
                    const bodyToken = await body.getAttribute(BODY_MARK);
                    if (view && (view.key !== engine.key(context) || bodyToken !== token)) {
                        await cleanupView(view);
                        view = null;
                    }
                    if (!view) {
                        view = await mount(row, body, index, context);
                        retained = true;
                    }
                    if (disposed) continue;
                    view.context = context;
                    view.index = index;
                    seen.add(view.token);
                    await paint(view, snapshot);
                } finally {
                    release(original);
                    if (!retained) { release(row); release(body); }
                }
            }
        }
        await Promise.all(Array.from(views.values()).filter(view => !seen.has(view.token)).map(cleanupView));
    }

    function onOutput(output) {
        if (disposed || !engine?.isEnabled(output.char?.chaId) || !engine.settings.autoTranslate) return;
        const message = output.chat?.message?.[output.messageIndex];
        const context = contextFor(output.char, output.chat, message);
        if (!context) return;
        pendingOutputs.set(engine.key(context), context);
        // Never await a network request inside the host's awaited output callback.
        schedule();
    }

    function discardDisabledOutputs() {
        for (const [key, context] of pendingOutputs) {
            if (!engine.settings.autoTranslate || !engine.isEnabled(context.characterId)) pendingOutputs.delete(key);
        }
    }

    async function refresh() {
        if (disposed || !doc || !engine) return;
        if (refreshing) { refreshAgain = true; return; }
        refreshing = true;
        try {
            selection = await readSelection();
            if (disposed) return;
            discardDisabledOutputs();
            // The output hook precedes auto-continue. The send control only returns after
            // the whole generation chain ends, including non-streaming continuations.
            // Offscreen chats wait until opened; never infer completion from isStreaming alone.
            if (selection && !selection.chat.isStreaming && await generationIdle()) {
                for (const [key, context] of pendingOutputs) {
                    if (context.characterId !== selection.character.chaId || context.chatId !== selection.chat.id) continue;
                    pendingOutputs.delete(key);
                    const message = selection.chat.message.find(item => item.chatId === context.messageId);
                    const current = contextFor(selection.character, selection.chat, message);
                    if (current) void engine.translate(current).catch(logError);
                }
            }
            await reconcile(selection);
        } finally {
            refreshing = false;
            if (refreshAgain) { refreshAgain = false; schedule(); }
        }
    }

    initialization = (async () => {
        engine = await createEngine(api, schedule);
        if (disposed) return;
        settingsCleanup = await registerSettings(api, engine, () => { uiError = ''; discardDisabledOutputs(); schedule(); });
        if (disposed) return;
        doc = await api.getRootDocument();
        if (disposed) return;
        if (!doc) throw new Error('메인 화면 접근 권한이 필요합니다. 권한을 허용하고 플러그인을 다시 불러오세요.');
        style = await doc.createElement('style');
        if (disposed) return;
        await style.setTextContent(css);
        const head = await doc.querySelector('head');
        if (!disposed) await head.appendChild(style);
        release(head);
        if (disposed) return;
        await api.addRisuChatListener('output', onOutput);
        if (disposed) return;
        observer = await api.createMutationObserver(schedule);
        const body = await doc.querySelector('body');
        if (!disposed) await observer.observe(body, { childList: true, subtree: true });
        release(body);
        if (disposed) return;
        poll = setInterval(schedule, 1500);
        activeRefresh = refresh();
        await activeRefresh;
    })();
    try {
        await initialization;
        return dispose;
    } catch (error) {
        await dispose();
        throw error;
    }
}
