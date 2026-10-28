import { createEngine } from './engine.js';
import { registerSettings } from './settings.js';
import { createQuickToggle, quickToggleCSS } from './quick-toggle.js';
import { createMessageSwap } from './message-swap.js';
import { createNativeRenderer } from './native-render.js';

const ROW_MARK = 'x-rtv-row';
const BODY_MARK = 'x-rtv-body';
const MODE_MARK = 'x-rtv-show';
const css = `
.rtv-translation { display: none; overflow-wrap: anywhere; pointer-events: none; user-select: none; }
.chattext[x-rtv-show="translation"] > [data-painter-body] { display: none !important; }
.chattext[x-rtv-show="translation"] > .rtv-translation { display: block; }
.rtv-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .65em; margin: .6em 0; font-size: .8rem; color: inherit; }
.rtv-controls button { cursor: pointer; padding: .25em .6em; border: 1px solid currentColor; border-radius: .35em; background: transparent; color: inherit; }
.rtv-controls button:hover { opacity: .75; }
.rtv-status { opacity: .8; white-space: pre-wrap; overflow-wrap: anywhere; }
${quickToggleCSS}
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

// Translation HTML is separate. Native rendering uses a journaled temporary write
// and restores message.data before publishing the cache or returning an output hook.
export async function startTranslationViewer(api) {
    let disposed = false;
    let doc;
    let style;
    let observer;
    let engine;
    let swaps;
    let nativeRenderer;
    let settingsUI;
    let quickToggle;
    let timer;
    let poll;
    let refreshing = false;
    let refreshAgain = false;
    let sequence = 0;
    let selection = null;
    let uiError = '';
    let initialization = Promise.resolve();
    let recoveredSelection = '';
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
        // Start restoration before any DOM/settings cleanup; host unload is time-limited.
        const restoring = nativeRenderer?.dispose() ?? swaps?.dispose();
        pendingOutputs.clear();
        // Remove the hiding rule first, before the host's one-second unload deadline.
        await style?.remove();
        await Promise.allSettled([restoring, initialization, activeRefresh]);
        engine?.dispose();
        await swaps?.dispose();
        clearInterval(poll);
        await style?.remove();
        await Promise.allSettled([
            observer?.disconnect(),
            ...Array.from(views.values(), cleanupView),
            settingsUI?.dispose(),
            quickToggle?.dispose(),
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
        if (chat && swaps) {
            for (const message of chat.message ?? []) {
                const original = swaps.original({ characterId: character.chaId, chatId: chat.id, messageId: message.chatId });
                if (original !== undefined) message.data = original; // This getter returned a snapshot, not the live DB.
            }
        }
        return chat?.id && Array.isArray(chat.message)
            ? { characterIndex, chatIndex, character, chat } : null;
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
        const ready = entry && typeof entry.html === 'string';
        const showTranslation = Boolean(ready && engine.isEnabled(view.context.characterId)
            && !view.nativeTranslated && !snapshot.chat.isStreaming && !originalMode.has(view.key));
        if (ready && view.renderedHTML !== entry.html) {
            // SafeElement sanitizes again. Native scripts have already processed this HTML.
            await view.translation.setInnerHTML(entry.html);
            const images = await view.translation.querySelectorAll('img[class*="root-loaded-image"]');
            try {
                for (const image of await api.unwarpSafeArray(images)) {
                    try {
                        const classes = await image.getClassName();
                        await image.addClass('root-loaded-image');
                        if (classes.includes('root-loaded-image-dynamic')) await image.addClass('root-loaded-image-dynamic');
                    } finally { release(image); }
                }
            } finally { release(images); }
            view.renderedHTML = entry.html;
        }
        const mode = showTranslation ? 'translation' : 'original';
        if (view.mode !== mode) {
            await view.body.setAttribute(MODE_MARK, mode);
            view.mode = mode;
        }
        await setLabel(view, 'toggleLabel', view.toggle,
            view.nativeTranslated ? '내장 번역 끄기 필요' : !entry ? '번역' : !ready ? '후처리 재시도' : showTranslation ? '원문 보기' : '번역 보기');
        await setLabel(view, 'retryLabel', view.retry, busy ? '번역·후처리 중…' : '다시 번역');
        const error = swaps?.error || engine.error(view.context) || uiError;
        const status = view.nativeTranslated ? '앱의 번역 버튼과 자동 번역을 꺼 주세요.' : error || (busy ? '번역·표시 후처리 중 — 원문 복구 후 표시'
            : snapshot.chat.isStreaming ? '응답 완료 후 번역할 수 있습니다.'
            : entry && !ready ? '저장된 번역을 본체 표시 방식으로 후처리합니다. 추가 번역 요청은 보내지 않습니다.'
            : entry && entry.source !== view.context.source ? '원문 수정됨 · 기존 번역 유지'
            : showTranslation ? '번역문은 읽기 전용 · 편집은 원문 보기' : '');
        await setLabel(view, 'statusLabel', view.status, status);
        if (entry && !ready && !busy && !engine.error(view.context) && !view.nativeTranslated && !snapshot.chat.isStreaming) {
            void engine.render(view.context).catch(logError);
        }
    }

    async function freshContext(view) {
        const current = await readSelection();
        if (!current || current.chat.isStreaming || !engine.isEnabled(current.character.chaId)) return null;
        const message = current.chat.message.find(message => message.chatId === view.context.messageId);
        const context = contextFor(current.character, current.chat, message);
        return context && engine.key(context) === view.key ? context : null;
    }

    async function act(view, force) {
        if (disposed || nativeRenderer?.busy || swaps?.busy || view.nativeTranslated || engine.isBusy(view.context)) return;
        const context = await freshContext(view);
        if (!context || disposed) return;
        const entry = await engine.get(context);
        if (entry && typeof entry.html === 'string' && !force) {
            if (originalMode.has(view.key)) originalMode.delete(view.key);
            else originalMode.add(view.key);
            schedule();
            return;
        }
        try {
            const result = entry && !force ? await engine.render(context) : await engine.translate(context, { force });
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

    async function translateOutput(context) {
        const entry = await engine.get(context);
        if (disposed || !engine.settings.autoTranslate || !engine.isEnabled(context.characterId)) return;
        // A newly committed continuation is new generated content, not a source edit.
        // Ordinary edits never enter this path and keep their existing translation.
        await engine.translate(context, { force: Boolean(entry && entry.source !== context.source) });
    }

    async function onOutput(output) {
        if (disposed || !engine?.isEnabled(output.char?.chaId) || !engine.settings.autoTranslate) return;
        const message = output.chat?.message?.[output.messageIndex];
        const context = contextFor(output.char, output.chat, message);
        if (!context) return;
        const current = await readSelection();
        if (disposed) return;
        if (current?.character.chaId !== context.characterId || current.chat.id !== context.chatId) {
            // CBS needs the selected chat. Keep offscreen output until that chat is opened.
            pendingOutputs.set(engine.key(context), context);
            schedule();
            return;
        }
        pendingOutputs.delete(engine.key(context));
        try {
            // The host awaits this hook before auto-continue and automatic BardWiki writing.
            // Waiting here gives translation priority without the send button's wiki delay.
            await translateOutput(context);
        } catch (error) {
            logError(error);
        } finally {
            schedule();
        }
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
            if (nativeRenderer?.busy || swaps?.busy) {
                const status = swaps.error || '표시 후처리·원문 복구 중 — 대상 메시지 편집 잠금';
                for (const view of views.values()) await setLabel(view, 'statusLabel', view.status, status);
                return;
            }
            selection = await readSelection();
            if (disposed) return;
            const selectionKey = selection ? JSON.stringify([selection.character.chaId, selection.chat.id]) : '';
            if (selectionKey && selectionKey !== recoveredSelection) {
                recoveredSelection = selectionKey;
                await swaps.recover();
                selection = await readSelection();
                if (disposed) return;
            }
            settingsUI?.refreshPreference();
            await quickToggle?.refresh(selection);
            if (disposed) return;
            discardDisabledOutputs();
            // Only offscreen output is deferred. Visible committed output is translated
            // inside the awaited output hook, before automatic BardWiki writing starts.
            if (selection && !selection.chat.isStreaming) {
                for (const [key, context] of pendingOutputs) {
                    if (context.characterId !== selection.character.chaId || context.chatId !== selection.chat.id) continue;
                    pendingOutputs.delete(key);
                    const message = selection.chat.message.find(item => item.chatId === context.messageId);
                    const current = contextFor(selection.character, selection.chat, message);
                    if (current) {
                        // An edit made while this chat was offscreen is not a new output.
                        const translate = current.source === context.source
                            ? translateOutput(current) : engine.translate(current);
                        void translate.catch(logError);
                    }
                }
            }
            await reconcile(selection);
        } finally {
            refreshing = false;
            if (refreshAgain) { refreshAgain = false; schedule(); }
        }
    }

    function preferencesChanged() {
        uiError = '';
        discardDisabledOutputs();
        schedule();
    }

    initialization = (async () => {
        doc = await api.getRootDocument();
        if (disposed) return;
        if (!doc) throw new Error('메인 화면 접근 권한이 필요합니다. 권한을 허용하고 플러그인을 다시 불러오세요.');
        swaps = await createMessageSwap(api, schedule);
        if (disposed) { await swaps.dispose(); return; }
        nativeRenderer = createNativeRenderer(api, doc, swaps, schedule);
        engine = await createEngine(api, schedule, (context, text) => nativeRenderer.render(context, text));
        if (disposed) return;
        settingsUI = await registerSettings(api, engine, preferencesChanged);
        if (disposed) return;
        quickToggle = createQuickToggle(api, doc, engine, {
            readSelection, onChange: preferencesChanged, openSettings: () => settingsUI.open(), reportError: logError,
        });
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
