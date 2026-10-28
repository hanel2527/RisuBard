import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, DEFAULT_SETTINGS } from './engine.js';

const context = (overrides = {}) => ({
    characterId: 'character-a', chatId: 'chat-a', messageId: 'message-a',
    source: 'The rain has stopped.', translatorNote: '', ...overrides,
});
const success = (result) => ({ type: 'success', result });
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function fixture({ data = new Map(), respond = () => success('비가 그쳤다.'), onChange = () => {}, getItem } = {}) {
    const requests = [];
    const writes = [];
    const storage = {
        async getItem(key) { return getItem ? await getItem(key, data) : structuredClone(data.get(key) ?? null); },
        async setItem(key, value) {
            const copy = structuredClone(value);
            writes.push({ key, value: copy });
            data.set(key, copy);
        },
        async removeItem(key) { data.delete(key); },
    };
    const api = {
        async getLocalPluginStorage() { return storage; },
        async runLLMModel(options) {
            requests.push(structuredClone(options));
            return await respond(options, requests.length);
        },
    };
    const engine = await createEngine(api, onChange);
    return { engine, requests, writes, data, api };
}

test('edited source retains a persisted identity translation without another generation, including after reload', async () => {
    const f = await fixture();
    const original = context();
    const entry = await f.engine.translate(original);
    assert.equal(entry.text, '비가 그쳤다.');
    const edited = context({ source: 'The storm has just begun.' });
    assert.deepEqual(await f.engine.get(edited), entry);
    assert.deepEqual(await f.engine.translate(edited), entry);
    assert.equal(f.requests.length, 1);
    assert.equal(entry.source, original.source);
    f.engine.dispose();
    const reloaded = await fixture({ data: f.data });
    assert.deepEqual(await reloaded.engine.translate(edited), entry);
    assert.equal(reloaded.requests.length, 0);
    assert.equal(reloaded.writes.length, 0);
});

test('chatbot opt-out survives reload, covers every chat, and preserves cached translations for re-enabling', async () => {
    const legacySettings = { ...DEFAULT_SETTINGS };
    delete legacySettings.disabledCharacterIds;
    const f = await fixture({ data: new Map([['risubard-translation-viewer:settings', legacySettings]]) });
    const entry = await f.engine.translate(context());
    await f.engine.saveSettings({ ...f.engine.settings, disabledCharacterIds: ['character-a'] });
    assert.equal(await f.engine.translate(context(), { force: true }), null);
    assert.equal(await f.engine.translate(context({ chatId: 'another-chat' })), null);
    assert.deepEqual(await f.engine.get(context()), entry);
    assert.equal((await f.engine.translate(context({ characterId: 'character-b' }))).text, '비가 그쳤다.');
    assert.equal(f.requests.length, 2);
    f.engine.dispose();

    const reloaded = await fixture({ data: f.data });
    assert.equal(reloaded.engine.isEnabled('character-a'), false);
    assert.equal(await reloaded.engine.translate(context({ chatId: 'new-chat' })), null);
    await reloaded.engine.saveSettings({ ...reloaded.engine.settings, disabledCharacterIds: [] });
    assert.deepEqual(await reloaded.engine.translate(context({ source: 'Edited source.' })), entry);
    assert.equal(reloaded.requests.length, 0);
    reloaded.engine.dispose();
});

test('global off overrides chatbot preferences without erasing them', async () => {
    const f = await fixture();
    await f.engine.saveSettings({ ...f.engine.settings, enabled: false, disabledCharacterIds: ['character-a'] });
    assert.equal(f.engine.isEnabled('character-b'), false);
    assert.equal(await f.engine.translate(context({ characterId: 'character-b' }), { force: true }), null);
    await f.engine.saveSettings({ ...f.engine.settings, enabled: true });
    assert.equal(await f.engine.translate(context()), null);
    assert.equal((await f.engine.translate(context({ characterId: 'character-b' }))).text, '비가 그쳤다.');
    assert.equal(f.requests.length, 1);
    f.engine.dispose();
});

test('opting out skips queued requests but keeps an already-sent result and lets other chatbots proceed', async () => {
    const started = deferred();
    const release = deferred();
    const f = await fixture({ respond: async (_, count) => {
        if (count === 1) { started.resolve(); await release.promise; }
        return success(`완료된 번역 ${count}`);
    } });
    const first = f.engine.translate(context());
    await started.promise;
    const queued = f.engine.translate(context({ messageId: 'queued' }));
    const other = f.engine.translate(context({ characterId: 'character-b' }));
    await f.engine.saveSettings({ ...f.engine.settings, disabledCharacterIds: ['character-a'] });
    release.resolve();
    const [saved, skipped, translated] = await Promise.all([first, queued, other]);
    assert.equal(saved.text, '완료된 번역 1');
    assert.equal(skipped, null);
    assert.equal(translated.text, '완료된 번역 2');
    assert.deepEqual(await f.engine.get(context()), saved);
    assert.equal(await f.engine.get(context({ messageId: 'queued' })), null);
    assert.equal(f.requests.length, 2);
    f.engine.dispose();
});

test('forced retranslation uses the edited source and replaces only its own entry', async () => {
    const f = await fixture({ respond: (_, count) => success(count === 1 ? '비가 그쳤다.' : '폭풍이 시작됐다.') });
    await f.engine.translate(context());
    const edited = Object.freeze(context({ source: 'The storm has just begun.' }));
    const translated = await f.engine.translate(edited, { force: true });
    assert.equal(translated.text, '폭풍이 시작됐다.');
    assert.equal(translated.source, edited.source);
    assert.equal(f.requests[1].messages[1].content, edited.source);
    assert.deepEqual(await f.engine.get(context()), translated);
    assert.equal(edited.source, 'The storm has just begun.');
});

test('failed, empty, and broken streaming retranslations preserve the previous cache across reloads', async () => {
    let response = success('보존할 번역');
    const f = await fixture({ respond: () => response });
    const previous = await f.engine.translate(context());
    const failures = [
        { type: 'fail', result: 'provider unavailable' },
        success('   '),
        { type: 'streaming', result: new ReadableStream({ start(controller) { controller.error(new Error('stream interrupted')); } }) },
    ];
    for (const failure of failures) {
        response = failure;
        assert.deepEqual(await f.engine.translate(context({ source: 'Edited' }), { force: true }), previous);
        assert.deepEqual(await f.engine.get(context()), previous);
        assert.match(f.engine.error(context()), /번역하지 못했습니다:/);
        assert.equal(f.engine.isBusy(context()), false);
    }
    assert.equal(f.writes.length, 1);
    assert.equal(f.requests.length, 4, 'each explicit action makes only one request');
    f.engine.dispose();
    const reloaded = await fixture({ data: f.data });
    assert.deepEqual(await reloaded.engine.get(context()), previous);
});

test('failed persistence rolls back the host memory-first cache and survives reload', async () => {
    const data = new Map();
    let fail = false;
    const storage = {
        getItem: async key => structuredClone(data.get(key) ?? null),
        setItem: async (key, value) => {
            data.set(key, structuredClone(value));
            if (fail) { fail = false; throw new Error('disk unavailable'); }
        },
        removeItem: async key => { data.delete(key); },
    };
    const api = { getLocalPluginStorage: async () => storage, runLLMModel: async () => success('기존 번역') };
    const engine = await createEngine(api);
    const previous = await engine.translate(context());
    api.runLLMModel = async () => success('저장 실패할 번역');
    fail = true;
    assert.deepEqual(await engine.translate(context({ source: 'Edited' }), { force: true }), previous);
    assert.match(engine.error(context()), /disk unavailable/);
    engine.dispose();
    const reloaded = await createEngine(api);
    assert.deepEqual(await reloaded.get(context()), previous);
    fail = true;
    assert.equal(await reloaded.translate(context({ messageId: 'new' })), null);
    reloaded.dispose();
    assert.equal(await (await createEngine(api)).get(context({ messageId: 'new' })), null);
});

test('same text in different messages, chats, and characters has separate persistent entries', async () => {
    const f = await fixture({ respond: (_, count) => success(`번역 ${count}`) });
    const messages = [context(), context({ messageId: 'message-b' }), context({ chatId: 'chat-b' }), context({ characterId: 'character-b' })];
    for (let index = 0; index < messages.length; index++) {
        assert.equal((await f.engine.translate(messages[index])).text, `번역 ${index + 1}`);
    }
    assert.equal(new Set(messages.map((message) => f.engine.key(message))).size, 4);
    assert.equal(f.data.size, 4);
    assert.notEqual(f.engine.key(context({ characterId: 'a:b', chatId: 'c' })), f.engine.key(context({ characterId: 'a', chatId: 'b:c' })));
});

test('missing persistent IDs do not fall back to source or array index', async () => {
    const f = await fixture();
    for (const field of ['characterId', 'chatId', 'messageId']) {
        for (const value of ['', '  ', undefined, null, 0]) {
            const invalid = context({ [field]: value, index: 3 });
            assert.equal(f.engine.key(invalid), null);
            assert.equal(await f.engine.translate(invalid), null);
            assert.equal(await f.engine.get(invalid), null);
        }
    }
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes.length, 0);
});

test('concurrent duplicate requests share generation and different identities run serially', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let active = 0;
    let peak = 0;
    const f = await fixture({ respond: async (_, count) => {
        active++;
        peak = Math.max(peak, active);
        if (count === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
        }
        active--;
        return success(`직렬 번역 ${count}`);
    } });
    const first = f.engine.translate(context());
    await firstStarted.promise;
    const duplicate = f.engine.translate(context({ source: 'Do not replace a running generation.' }), { force: true });
    const second = f.engine.translate(context({ messageId: 'second' }));
    assert.equal(f.engine.isBusy(context()), true);
    assert.equal(f.engine.isBusy(context({ messageId: 'second' })), true);
    assert.equal(f.requests.length, 1);
    releaseFirst.resolve();
    const [a, b, c] = await Promise.all([first, duplicate, second]);
    assert.deepEqual(a, b);
    assert.equal(c.text, '직렬 번역 2');
    assert.equal(f.requests.length, 2);
    assert.equal(peak, 1);
    assert.equal(f.engine.isBusy(context()), false);
});

test('unload during a pending request suppresses publication, callbacks, and queued generations', async () => {
    const started = deferred();
    const response = deferred();
    let refreshes = 0;
    const f = await fixture({ onChange: () => { refreshes++; }, respond: () => { started.resolve(); return response.promise; } });
    const first = f.engine.translate(context());
    const second = f.engine.translate(context({ messageId: 'queued' }));
    await started.promise;
    f.engine.dispose();
    const before = refreshes;
    response.resolve(success('게시되면 안 되는 번역'));
    assert.deepEqual(await Promise.all([first, second]), [null, null]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(refreshes, before);
    assert.equal(await f.engine.get(context()), null);
    assert.equal(await f.engine.translate(context()), null);
    await f.engine.saveSettings({ ...DEFAULT_SETTINGS, targetLanguage: 'fr' });
    assert.equal(f.writes.length, 0);
});

test('unload while persistent cache is loading does not start generation', async () => {
    const reading = deferred();
    const release = deferred();
    const f = await fixture({ getItem: async (key) => {
        if (key.endsWith(':settings')) return null;
        reading.resolve();
        return await release.promise;
    } });
    const translating = f.engine.translate(context());
    await reading.promise;
    f.engine.dispose();
    release.resolve(null);
    assert.equal(await translating, null);
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes.length, 0);
});

test('native plain prompt uses a system prompt and separate unmodified source; content slots stay literal', async () => {
    const f = await fixture();
    const prompt = '  Translate {{slot::from}} to {{slot}}. {{slot::tnote}} {{slot::content}} {{solt::content}}\n';
    await f.engine.saveSettings({ ...DEFAULT_SETTINGS, prompt });
    const source = '{{setvar::flag::changed}} <b>Rain</b>';
    await f.engine.translate(context({ source, translatorNote: 'Keep HTML.' }));
    assert.deepEqual(f.requests[0].messages, [
        { role: 'system', content: '  Translate en to ko. Keep HTML. {{slot::content}} {{solt::content}}\n' },
        { role: 'user', content: source },
    ]);
    assert.equal(f.engine.settings.prompt, prompt);
});

test('ChatML supports native roles, both content spellings, Thoughts, whitespace and literal setting macros', async () => {
    const f = await fixture();
    const prompt = ' \n<|im_start|>system<|im_sep|>From {{slot::from}} to {{slot}}: {{slot::tnote}}<|im_end|>\n' +
        '<|im_start|>user\n{{slot::content}}<|im_end|>\n' +
        '<|im_start|>assistant <Thoughts>Keep the tone.</Thoughts>{{solt::content}}<|im_end|> ';
    await f.engine.saveSettings({ ...DEFAULT_SETTINGS, prompt });
    const source = '{{setvar::name::untouched}} The rain.';
    await f.engine.translate(context({ source, translatorNote: 'Formal.' }));
    assert.deepEqual(f.requests[0].messages, [
        { role: 'system', content: 'From en to ko: Formal.', thoughts: [] },
        { role: 'user', content: source, thoughts: [] },
        { role: 'assistant', content: source, thoughts: ['Keep the tone.'] },
    ]);
});

test('risu-style is shielded in model input and recovered with native wrapper removal', async () => {
    const f = await fixture({ respond: () => success('<style-data style-index="0"></style-data>비.<style-data style-index="1" />') });
    const source = '<risu-style>.rain {\n color: blue;\n}</risu-style>Rain.<risu-style>.cloud{opacity:.5}</risu-style>';
    const entry = await f.engine.translate(context({ source }));
    assert.equal(f.requests[0].messages[1].content, '<style-data style-index="0"></style-data>Rain.<style-data style-index="1"></style-data>');
    assert.equal(entry.text, '.rain {\n color: blue;\n}비..cloud{opacity:.5}');
    assert.equal(entry.source, source);
});

test('stream responses are complete snapshots, not deltas or multiple concatenated alternatives', async () => {
    const f = await fixture({ respond: () => ({ type: 'streaming', result: new ReadableStream({
        start(controller) {
            controller.enqueue({ '0': '비', '1': '다른 번역' });
            controller.enqueue({ '0': '비가 그쳤다.', '1': '다른 완성 번역' });
            controller.close();
        },
    }) }) });
    assert.equal((await f.engine.translate(context())).text, '비가 그쳤다.');
    assert.equal(f.writes.length, 1);
});

test('unload cancels an open stream without caching partial text', async () => {
    const reading = deferred();
    let cancelled = false;
    const f = await fixture({ respond: () => ({ type: 'streaming', result: new ReadableStream({
        pull() { reading.resolve(); },
        cancel() { cancelled = true; },
    }) }) });
    const pending = f.engine.translate(context());
    await reading.promise;
    // Let the generation acquire its reader before disposing.
    await Promise.resolve();
    f.engine.dispose();
    assert.equal(await pending, null);
    assert.equal(cancelled, true);
    assert.equal(f.writes.length, 0);
});

test('multiline includes character output only and rejects user-only or malformed results', async () => {
    let response = { type: 'multiline', result: [['user', 'Do not publish this input.'], ['char', '첫 문단.'], ['char', '둘째 문단.']] };
    const f = await fixture({ respond: () => response });
    const entry = await f.engine.translate(context());
    assert.equal(entry.text, '첫 문단.\n\n둘째 문단.');
    for (const result of [[['user', 'input']], [['char', 42]]]) {
        response = { type: 'multiline', result };
        assert.deepEqual(await f.engine.translate(context(), { force: true }), entry);
        assert.ok(f.engine.error(context()));
    }
});


test('invalid settings show useful errors without changing saved values or trimming prompt whitespace', async () => {
    const f = await fixture();
    const prompt = '\n  Custom prompt {{slot}}  \n';
    await f.engine.saveSettings({ ...DEFAULT_SETTINGS, prompt });
    for (const changes of [{ prompt: '  ' }, { targetLanguage: '' }, { sourceLanguage: null }, { autoTranslate: 'yes' }]) {
        await assert.rejects(f.engine.saveSettings({ ...DEFAULT_SETTINGS, ...changes }), /[가-힣]/);
        assert.equal(f.engine.settings.prompt, prompt);
    }
    assert.equal(f.writes.length, 1);
    const reloaded = await fixture({ data: f.data });
    assert.equal(reloaded.engine.settings.prompt, prompt);
});
