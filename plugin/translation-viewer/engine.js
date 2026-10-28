export const DEFAULT_PROMPT = 'You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoTranslate: true,
    disabledCharacterIds: Object.freeze([]),
    model: '',
    targetLanguage: 'ko',
    sourceLanguage: 'en',
    prompt: DEFAULT_PROMPT,
});

const PREFIX = 'risubard-translation-viewer:';
const SETTINGS_KEY = `${PREFIX}settings`;

function normalizeSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('번역 설정 형식이 올바르지 않습니다.');
    }
    const settings = { ...DEFAULT_SETTINGS };
    for (const field of ['enabled', 'autoTranslate']) {
        if (typeof value[field] !== 'boolean') throw new Error('번역 사용 설정을 확인해 주세요.');
        settings[field] = value[field];
    }
    const disabled = value.disabledCharacterIds === undefined ? [] : value.disabledCharacterIds;
    if (!Array.isArray(disabled) || disabled.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error('챗봇별 번역 설정을 확인해 주세요.');
    }
    settings.disabledCharacterIds = Object.freeze([...disabled]);
    for (const [field, label] of [['model', '모델'], ['targetLanguage', '대상 언어'], ['sourceLanguage', '원본 언어'], ['prompt', '번역 프롬프트']]) {
        if (typeof value[field] !== 'string') throw new Error(`${label}은(는) 문자열이어야 합니다.`);
        settings[field] = field === 'prompt' ? value[field] : value[field].trim();
        if (field !== 'model' && !settings[field].trim()) throw new Error(`${label}을(를) 입력해 주세요.`);
    }
    if (settings.model.startsWith('[PM]')) settings.model = `pluginmodel:::${settings.model}`;
    if (settings.model === 'pluginmodel:::') throw new Error('사용할 모델 이름을 입력해 주세요.');
    return Object.freeze(settings);
}

function identity(context) {
    const parts = [context?.characterId, context?.chatId, context?.messageId];
    if (parts.some((part) => typeof part !== 'string' || !part.trim())) return null;
    return `${PREFIX}cache:${JSON.stringify(parts)}`;
}

// Split the expanded template before inserting source, so source stays literal.
function parseChatML(prompt) {
    const start = '<|im_start|>';
    const separator = '<|im_sep|>';
    const end = '<|im_end|>';
    const trimmed = prompt.trim();
    if (!trimmed.startsWith(start)) return null;
    return trimmed.split(start).filter((part) => part !== '').map((part) => {
        let role = 'user';
        for (const candidate of ['user', 'system', 'assistant']) {
            const boundary = [separator, ' ', '\n'].find((suffix) => part.startsWith(candidate + suffix));
            if (boundary !== undefined) {
                role = candidate;
                part = part.substring(candidate.length + boundary.length);
                break;
            }
        }
        part = part.trim();
        if (part.endsWith(end)) part = part.substring(0, part.length - end.length);
        const thoughts = [];
        part = part.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_, thought) => {
            thoughts.push(thought);
            return '';
        });
        return { role, content: part, thoughts };
    });
}

async function expandPrompt(api, context, template) {
    const macros = template.replace(/\{\{(?:slot|solt)::content\}\}/g, '');
    if (!/\{\{|<(?:user|char|bot)>/i.test(macros)) return template;

    // parseRisuChat always uses the active chat. Never borrow another chat's toggles
    // if selection changes while a translation is queued or an RPC is in flight.
    const messageIndex = async () => {
        const character = await api.getCharacter();
        const chat = character?.chats?.[character.chatPage];
        const index = chat?.message?.findIndex((message) => message.chatId === context.messageId);
        if (character?.chaId !== context.characterId || chat?.id !== context.chatId || !(index >= 0)) {
            throw new Error('번역 대상 채팅으로 돌아온 뒤 다시 번역해 주세요. 다른 채팅의 토글은 사용하지 않습니다.');
        }
        return index;
    };
    const before = await messageIndex();
    const expanded = await api.parseRisuChat(template, {
        messageIndex: before, role: 'char', processRegex: false, runVar: false, rmVar: true,
    });
    if (await messageIndex() !== before) {
        throw new Error('프롬프트 해석 중 메시지 위치가 바뀌었습니다. 다시 번역해 주세요.');
    }
    return expanded;
}

async function prepareRequest(api, context, settings) {
    const styles = [];
    const source = context.source.replace(/<risu-style>(.+?)<\/risu-style>/gms, (_, style) => {
        styles.push(style);
        return `<style-data style-index="${styles.length - 1}"></style-data>`;
    });
    const note = typeof context.translatorNote === 'string' ? context.translatorNote : '';
    const template = settings.prompt.replaceAll('{{slot::from}}', settings.sourceLanguage)
        .replaceAll('{{slot}}', settings.targetLanguage).replaceAll('{{slot::tnote}}', note);
    const prompt = await expandPrompt(api, context, template);
    const chatML = parseChatML(prompt);
    // Only prompts and notes execute read-only CBS. Message text is not a template.
    const insertSource = (text) => text.replace(/\{\{(?:slot|solt)::content\}\}/g, () => source);
    const messages = chatML ? chatML.map((message) => ({
        ...message, content: insertSource(message.content), thoughts: message.thoughts.map(insertSource),
    })) : [
        { role: 'system', content: prompt },
        { role: 'user', content: source },
    ];
    return { messages, styles };
}

function recoverStyles(text, styles) {
    return text.replace(/<style-data style-index="(\d+)" ?\/?>/g, (_, index) => styles[Number(index)] ?? '')
        .replace(/<\/style-data>/g, '');
}

function errorMessage(error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `번역하지 못했습니다: ${detail}`;
}

function validEntry(entry) {
    return entry && typeof entry.text === 'string' && entry.text.trim() &&
        typeof entry.source === 'string' && Number.isFinite(entry.updatedAt);
}

export async function createEngine(api, onChange = () => {}, render) {
    const storage = await api.getLocalPluginStorage();
    const savedSettings = await storage.getItem(SETTINGS_KEY);
    let settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(savedSettings ?? {}) });
    let disabledCharacters = new Set(settings.disabledCharacterIds);
    let disposed = false;
    let generationQueue = Promise.resolve();
    let settingsQueue = Promise.resolve();
    let activeReader = null;
    const cache = new Map();
    const reads = new Map();
    const pending = new Map();
    const errors = new Map();

    function isEnabled(characterId) {
        return !disposed && settings.enabled && typeof characterId === 'string' && Boolean(characterId)
            && !disabledCharacters.has(characterId);
    }

    function notify() {
        if (disposed) return;
        try {
            // UI refresh must not hold the generation queue or turn success into failure.
            Promise.resolve(onChange()).catch(() => {});
        } catch { /* The renderer owns its errors. */ }
    }

    async function readEntry(key) {
        if (disposed) return null;
        if (cache.has(key)) return cache.get(key);
        if (reads.has(key)) return reads.get(key);
        const reading = (async () => {
            const stored = await storage.getItem(key);
            if (disposed) return null;
            const entry = validEntry(stored) ? Object.freeze({
                text: stored.text, source: stored.source, updatedAt: stored.updatedAt,
                ...(stored.htmlVersion === 1 && typeof stored.html === 'string'
                    ? { html: stored.html, htmlVersion: 1 } : {}),
            }) : null;
            cache.set(key, entry);
            return entry;
        })();
        reads.set(key, reading);
        try {
            return await reading;
        } finally {
            if (!disposed) reads.delete(key);
        }
    }

    async function responseText(response) {
        if (!response || typeof response !== 'object') throw new Error('모델 응답 형식이 올바르지 않습니다.');
        if (response.type === 'fail') throw new Error(typeof response.result === 'string' ? response.result : '모델 요청이 실패했습니다.');
        if (response.type === 'success') {
            if (typeof response.result !== 'string') throw new Error('모델의 번역 응답이 문자열이 아닙니다.');
            return response.result;
        }
        if (response.type === 'multiline') {
            if (!Array.isArray(response.result) || response.result.some((part) =>
                !Array.isArray(part) || !['user', 'char'].includes(part[0]) || typeof part[1] !== 'string')) {
                throw new Error('모델의 여러 줄 응답 형식이 올바르지 않습니다.');
            }
            return response.result.filter(([role]) => role === 'char').map(([, text]) => text).join('\n\n');
        }
        if (response.type !== 'streaming' || typeof response.result?.getReader !== 'function') {
            throw new Error('지원하지 않는 모델 응답 형식입니다.');
        }
        const reader = response.result.getReader();
        activeReader = reader;
        let text = '';
        try {
            while (!disposed) {
                const chunk = await reader.read();
                if (disposed || chunk.done) break;
                const snapshot = chunk.value;
                if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
                    throw new Error('모델의 스트리밍 응답 형식이 올바르지 않습니다.');
                }
                const first = Object.hasOwn(snapshot, '0') ? '0' : Object.keys(snapshot)[0];
                if (typeof snapshot[first] !== 'string') throw new Error('모델의 스트리밍 번역이 문자열이 아닙니다.');
                text = snapshot[first];
            }
            return text;
        } catch (error) {
            try { await reader.cancel(); } catch { /* Preserve the original stream error. */ }
            throw error;
        } finally {
            reader.releaseLock();
            if (!disposed) activeReader = null;
        }
    }

    return {
        get settings() { return settings; },
        key: identity,
        isEnabled,
        isBusy(context) { return !disposed && pending.has(identity(context)); },
        error(context) { return disposed ? '' : errors.get(identity(context)) ?? ''; },
        async saveSettings(value) {
            if (disposed) return;
            const saving = settingsQueue.then(async () => {
                if (disposed) return;
                // Functional updates merge with the latest queued settings, not a stale UI snapshot.
                const next = normalizeSettings(typeof value === 'function' ? value(settings) : value);
                try {
                    await storage.setItem(SETTINGS_KEY, next);
                } catch (error) {
                    // The host updates its memory before durable storage succeeds.
                    try { await storage.setItem(SETTINGS_KEY, settings); }
                    catch (rollbackError) {
                        throw new Error(`${String(error)}; 설정 복구도 실패했습니다: ${String(rollbackError)}`);
                    }
                    throw error;
                }
                if (disposed) return;
                settings = next;
                disabledCharacters = new Set(next.disabledCharacterIds);
                notify();
            });
            settingsQueue = saving.catch(() => {});
            await saving;
        },
        async get(context) {
            const key = identity(context);
            if (!key || disposed) return null;
            try {
                return await readEntry(key);
            } catch (error) {
                if (!disposed) {
                    errors.set(key, errorMessage(error));
                    notify();
                }
                return null;
            }
        },
        async render(context) {
            // Upgrade an existing text-only cache without purchasing another translation.
            return await this.translate(context, { cachedOnly: true });
        },
        async translate(context, { force = false, cachedOnly = false } = {}) {
            const key = identity(context);
            if (!key || !isEnabled(context.characterId)) return null;
            if (pending.has(key)) return await pending.get(key);
            // Capture the caller's current message without ever modifying its snapshot.
            const snapshot = { ...context };
            const requestSettings = settings;
            const task = generationQueue.then(async () => {
                if (!isEnabled(snapshot.characterId)) return null;
                let previous = null;
                try {
                    previous = await readEntry(key);
                    if (!isEnabled(snapshot.characterId)) return null;
                    if (cachedOnly && !previous) return null;
                    if (previous && !force && (!render || typeof previous.html === 'string')) return previous;
                    let text = previous?.text;
                    let source = previous?.source;
                    let updatedAt = previous?.updatedAt;
                    if (!previous || force) {
                        if (typeof snapshot.source !== 'string' || !snapshot.source.trim()) throw new Error('번역할 원문이 없습니다.');
                        const { messages, styles } = await prepareRequest(api, snapshot, requestSettings);
                        if (!isEnabled(snapshot.characterId)) return null;
                        const options = { mode: 'translate', allowPlugins: true, messages };
                        if (requestSettings.model) options.staticModel = requestSettings.model;
                        const response = await api.runLLMModel(options);
                        if (disposed) {
                            if (response?.type === 'streaming' && typeof response.result?.cancel === 'function') {
                                try { await response.result.cancel(); } catch { /* Already closed. */ }
                            }
                            return null;
                        }
                        text = recoverStyles(await responseText(response), styles);
                        source = snapshot.source;
                        updatedAt = Date.now();
                    }
                    if (disposed) return null;
                    if (!text.trim()) throw new Error('모델이 빈 번역을 반환했습니다.');
                    let html;
                    if (render && isEnabled(snapshot.characterId)) {
                        // render resolves only after the native message has been restored.
                        html = await render(snapshot, text);
                        if (typeof html !== 'string') throw new Error('표시 후처리 결과가 올바르지 않습니다.');
                    }
                    if (disposed) return null;
                    const entry = Object.freeze({
                        text, source, updatedAt,
                        ...(html === undefined ? {} : { html, htmlVersion: 1 }),
                    });
                    try {
                        await storage.setItem(key, entry);
                    } catch (error) {
                        // Host storage updates its shared memory before durable persistence.
                        // Roll back that visible value too, not just this engine's private map.
                        try {
                            if (previous) await storage.setItem(key, previous);
                            else await storage.removeItem(key);
                        } catch (rollbackError) {
                            throw new Error(`${errorMessage(error)}; 캐시 복구도 실패했습니다: ${String(rollbackError)}`);
                        }
                        throw error;
                    }
                    if (disposed) return null;
                    cache.set(key, entry);
                    errors.delete(key);
                    return entry;
                } catch (error) {
                    if (disposed) return null;
                    errors.set(key, errorMessage(error));
                    return previous;
                }
            });
            pending.set(key, task);
            errors.delete(key);
            generationQueue = task.catch(() => {});
            notify();
            try {
                return await task;
            } finally {
                if (!disposed) {
                    pending.delete(key);
                    notify();
                }
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (activeReader) {
                const reader = activeReader;
                void (async () => {
                    try { await reader.cancel(); } catch { /* Unloading must not publish errors. */ }
                })();
            }
            cache.clear();
            reads.clear();
            pending.clear();
            errors.clear();
            activeReader = null;
        },
    };
}
