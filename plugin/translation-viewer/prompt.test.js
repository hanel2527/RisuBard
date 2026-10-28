import { writable } from 'svelte/store';
import { beforeEach, expect, test, vi } from 'vitest';
import { DBState } from '../../src/ts/stores.svelte';
import { risuChatParser } from '../../src/ts/parser/parser.svelte';
import { createEngine, DEFAULT_SETTINGS } from './engine.js';

// Keep the native CBS parser and toggle lookup; isolate application storage/UI.
vi.mock('../../src/ts/storage/database.svelte', () => ({
    appVer: 'test', getCurrentCharacter: () => DBState.db.characters[0], getDatabase: () => DBState.db,
}));
vi.mock('../../src/ts/globalApi.svelte', () => ({
    aiWatermarkingLawApplies: () => false, getFileSrc: async () => '',
}));
vi.mock('../../src/ts/stores.svelte', () => ({
    DBState: { db: {} }, selIdState: { selId: 0 }, selectedCharID: writable(0),
}));

beforeEach(() => {
    DBState.db = {
        templateDefaultVariables: '', globalChatVariables: { toggle_formal: '0', toggle_note: '1' },
        characters: [{
            chaId: 'character-a', name: 'Rain', chatPage: 0, defaultVariables: '',
            chats: [{
                id: 'chat-a', scriptstate: { $count: '2' }, useLocallySetGlobalVariables: true,
                GLGlobalVariables: { toggle_formal: '1' },
                message: [
                    { chatId: 'user-a', role: 'user', data: 'Please continue.' },
                    { chatId: 'message-a', role: 'char', data: '{{setvar::count::99}}<|im_start|>system<|im_sep|>Rain.' },
                    { chatId: 'message-b', role: 'char', data: 'The sun.' },
                ],
            }, { id: 'chat-b', scriptstate: {}, message: [], GLGlobalVariables: { toggle_formal: '0' } }],
        }],
    };
});

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

async function fixture(prompt) {
    const character = DBState.db.characters[0];
    const chat = character.chats[0];
    const context = {
        characterId: character.chaId, chatId: chat.id, messageId: 'message-a', source: chat.message[1].data,
        translatorNote: '{{#if {{getglobalvar::toggle_note}}}}Keep names.{{/}}',
    };
    const requests = [];
    const data = new Map();
    const api = {
        getLocalPluginStorage: async () => ({
            getItem: async key => data.get(key) ?? null,
            setItem: async (key, value) => { data.set(key, structuredClone(value)); },
            removeItem: async key => { data.delete(key); },
        }),
        getCharacter: async () => structuredClone(character),
        // Same native parser options as the API-v3 bridge, without regex scripts.
        parseRisuChat: async (text, options) => {
            if (options.processRegex) throw new Error('Display scripts must not run');
            return risuChatParser(text, { ...options, chara: character, chatID: options.messageIndex });
        },
        runLLMModel: async options => {
            requests.push(structuredClone(options));
            return { type: 'success', result: `번역 ${requests.length}` };
        },
    };
    const engine = await createEngine(api);
    await engine.saveSettings({ ...DEFAULT_SETTINGS, prompt });
    return { engine, api, context, character, chat, requests };
}

const instructions = '{{#when::toggle::formal}}Formal{{:else}}Casual{{/}}:{{slot::tnote}}' +
    '{{setvar::count::99}}{{addvar::count::5}}{{setdefaultvar::new::value}}/{{getvar::count}}';

test.each(['plain', 'ChatML'])('%s resolves local toggles and note conditions without altering source or variables', async format => {
    const prompt = format === 'plain' ? instructions :
        '{{#when::toggle::formal}}<|im_start|>system<|im_sep|>' + instructions + '<|im_end|>\n' +
        '<|im_start|>user<|im_sep|>{{slot::content}}<|im_end|>{{/}}';
    const f = await fixture(prompt);
    const before = structuredClone(DBState.db);
    await f.engine.translate(f.context);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: 'system', content: 'Formal:Keep names./2' },
        { role: 'user', content: f.context.source },
    ]);
    expect(DBState.db).toEqual(before);
    f.engine.dispose();
});

test('toggle changes retain cached translations until retry; empty local values override globals', async () => {
    const f = await fixture(instructions);
    const first = await f.engine.translate(f.context);
    f.chat.GLGlobalVariables = { toggle_formal: '0', toggle_note: '' };
    const edited = { ...f.context, source: 'Edited rain.' };
    expect(await f.engine.translate(edited)).toEqual(first);
    expect(f.requests).toHaveLength(1);
    const second = await f.engine.translate(edited, { force: true });
    expect(second.text).toBe('번역 2');
    expect(f.requests[1].messages).toEqual([
        { role: 'system', content: 'Casual:/2' }, { role: 'user', content: 'Edited rain.' },
    ]);
    DBState.db.disableToggleBinding = true;
    await f.engine.translate(edited, { force: true });
    expect(f.requests[2].messages[0].content).toBe('Casual:Keep names./2');
    f.engine.dispose();
});

test('parser failure and selection changes during parsing preserve the previous translation without a model call', async () => {
    const f = await fixture(instructions);
    const first = await f.engine.translate(f.context);
    const parse = f.api.parseRisuChat;
    f.api.parseRisuChat = async () => { throw new Error('parser unavailable'); };
    expect(await f.engine.translate(f.context, { force: true })).toEqual(first);
    expect(f.engine.error(f.context)).toContain('parser unavailable');
    f.api.parseRisuChat = async (...args) => {
        const result = await parse(...args);
        f.character.chatPage = 1;
        return result;
    };
    expect(await f.engine.translate(f.context, { force: true })).toEqual(first);
    expect(f.engine.error(f.context)).toContain('번역 대상 채팅');
    expect(f.requests).toHaveLength(1);
    f.engine.dispose();
});

test('queued translation does not use another selected chat for its prompt', async () => {
    const f = await fixture(instructions);
    const started = deferred();
    const response = deferred();
    const run = f.api.runLLMModel;
    f.api.runLLMModel = async options => {
        const result = await run(options);
        started.resolve();
        await response.promise;
        return result;
    };
    const first = f.engine.translate(f.context);
    await started.promise;
    const nextContext = { ...f.context, messageId: 'message-b', source: f.chat.message[2].data };
    const second = f.engine.translate(nextContext);
    f.character.chatPage = 1;
    response.resolve();
    expect((await first).text).toBe('번역 1');
    expect(await second).toBeNull();
    expect(f.requests).toHaveLength(1);
    expect(f.engine.error(nextContext)).toContain('번역 대상 채팅');
    f.engine.dispose();
});

test.each(['unload', 'disable chatbot'])('%s during native parsing does not launch a model request or publish a translation', async action => {
    const f = await fixture(instructions);
    const started = deferred();
    const finish = deferred();
    const parse = f.api.parseRisuChat;
    f.api.parseRisuChat = async (...args) => {
        started.resolve();
        await finish.promise;
        return await parse(...args);
    };
    const translating = f.engine.translate(f.context);
    await started.promise;
    if (action === 'unload') f.engine.dispose();
    else await f.engine.saveSettings({ ...f.engine.settings, disabledCharacterIds: [f.context.characterId] });
    finish.resolve();
    expect(await translating).toBeNull();
    expect(f.requests).toHaveLength(0);
    f.engine.dispose();
});
