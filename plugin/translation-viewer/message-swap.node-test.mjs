import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSwap, MESSAGE_SWAP_JOURNAL_KEY, TEMPORARY_MARK } from './message-swap.js';

const original = 'The rain has stopped.';
const temporary = '비가 그쳤다.';
const context = (overrides = {}) => ({
    characterId: 'character-a', chatId: 'chat-a', messageId: 'message-a',
    source: original, translatorNote: '', ...overrides,
});
const copy = value => structuredClone(value);
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const defaultDatabase = () => ({ characters: {
    // Deliberately nonnumeric keys: public API indices are Object.keys positions.
    'storage-key-a': { chaId: 'character-a', chatPage: 0, chats: [{
        id: 'chat-a', name: 'Chat A', note: '', localLore: [], modules: ['module-a'],
        scriptstate: { score: 1 }, GLGlobalVariables: { mode: 'before' },
        message: [
            { role: 'char', chatId: 'message-a', data: original, generationInfo: { model: 'original-model' } },
            { role: 'user', chatId: 'message-b', data: 'Another message' },
        ],
    }, { id: 'chat-b', name: 'Chat B', message: [{ role: 'char', chatId: 'other-message', data: 'Untouched' }] }] },
    'storage-key-b': { chaId: 'character-b', chatPage: 0, chats: [{ id: 'chat-c', message: [] }] },
} });

function host({ database = defaultDatabase(), durable = new Map() } = {}) {
    const state = {
        database: copy(database), durable, cache: new Map(), writes: [], publications: [],
        beforePersist: null, beforeWrite: null, afterWrite: null, beforeCharacterRead: null,
    };
    const characterAt = index => state.database.characters[Object.keys(state.database.characters)[index]];
    const storage = {
        async getItem(key) {
            if (state.cache.has(key)) return copy(state.cache.get(key));
            const value = copy(state.durable.get(key) ?? null);
            state.cache.set(key, value);
            return copy(value);
        },
        async setItem(key, value) {
            state.cache.set(key, copy(value));
            state.publications.push(copy(value));
            await state.beforePersist?.(key, value);
            state.durable.set(key, copy(value));
        },
    };
    state.api = {
        async getLocalPluginStorage() { return storage; },
        async getDatabase(fields) {
            assert.deepEqual(fields, ['characters']);
            return copy(state.database);
        },
        async getCharacterFromIndex(index) {
            await state.beforeCharacterRead?.(index);
            return copy(characterAt(index) ?? null);
        },
        async getChatFromIndex(characterIndex, chatIndex) { return copy(characterAt(characterIndex)?.chats[chatIndex] ?? null); },
        async setChatToIndex(characterIndex, chatIndex, chat) {
            // Every actual consumer write checks the disk, not the memory-first
            // storage getter, for the exact backup owning a temporary message.
            for (const message of chat.message) {
                const token = message[TEMPORARY_MARK];
                if (token === undefined) continue;
                const record = state.durable.get(MESSAGE_SWAP_JOURNAL_KEY)?.entries.find(entry => entry.token === token);
                assert.ok(record, 'temporary write requires an acknowledged durable backup');
                assert.equal(record.messageId, message.chatId);
            }
            await state.beforeWrite?.(characterIndex, chatIndex, chat);
            state.writes.push({ characterIndex, chatIndex, chat: copy(chat) });
            const character = characterAt(characterIndex);
            if (character?.chats[chatIndex]) character.chats[chatIndex] = copy(chat);
            await state.afterWrite?.(characterIndex, chatIndex, chat);
        },
    };
    state.chat = () => Object.values(state.database.characters).find(character => character.chaId === 'character-a')
        ?.chats.find(chat => chat.id === 'chat-a');
    state.message = () => state.chat()?.message?.find(message => message.chatId === 'message-a');
    state.saved = () => state.durable.get(MESSAGE_SWAP_JOURNAL_KEY);
    state.restart = () => host({ database: state.database, durable: new Map([...state.durable].map(([key, value]) => [key, copy(value)])) });
    return state;
}

async function fixture(options) {
    const f = host(options);
    f.swap = await createMessageSwap(f.api);
    return f;
}

async function interruptedSwap({ transformed = false } = {}) {
    const f = await fixture();
    const started = deferred();
    const running = f.swap.run(context(), temporary, () => {
        if (transformed) f.message().data = 'Native-script transformed translation';
        started.resolve();
        return new Promise(() => {});
    });
    const rejected = assert.rejects(running, { name: 'AbortError' });
    await started.promise;
    const restarted = f.restart();
    await f.swap.dispose();
    await rejected;
    return restarted;
}

test('memory-first backup failure never admits a temporary chat write, and a later successful publication can retry', async () => {
    const f = await fixture();
    f.beforePersist = () => { throw new Error('disk unavailable'); };
    await assert.rejects(f.swap.run(context(), temporary, () => assert.fail('capture must not run')), /disk unavailable/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.message().data, original);
    assert.equal(f.saved(), undefined);
    assert.equal(f.cache.get(MESSAGE_SWAP_JOURNAL_KEY).entries.length, 1);
    assert.match(f.swap.error, /disk unavailable/);
    f.beforePersist = null;
    assert.equal(await f.swap.run(context(), temporary, () => '<p>번역</p>'), '<p>번역</p>');
    assert.equal(f.message().data, original);
    assert.equal(f.saved().entries.length, 2);
    await f.swap.dispose();
});

test('capture sees a durable owned translation but the awaited output hook sees only the restored original', async () => {
    const f = await fixture();
    const html = await f.swap.run(context(), temporary, ({ signal, token, target }) => {
        assert.equal(signal.aborted, false);
        assert.deepEqual(target, { characterIndex: 0, chatIndex: 0, messageIndex: 0 });
        assert.equal(f.message().data, temporary);
        assert.equal(f.message()[TEMPORARY_MARK], token);
        assert.equal(f.saved().entries[0].original, original);
        assert.equal(f.swap.original(context()), original);
        assert.equal(f.swap.busy, true);
        return '<p>비가 그쳤다.</p>';
    });
    assert.equal(html, '<p>비가 그쳤다.</p>');
    assert.equal(f.message().data, original);
    assert.equal(Object.hasOwn(f.message(), TEMPORARY_MARK), false);
    assert.equal(f.swap.original(context()), undefined);
    assert.equal(f.swap.busy, false);
    assert.equal(f.swap.error, '');
    assert.equal(f.saved().entries.length, 1, 'in-memory restoration cannot acknowledge a durable autosave');
    await f.swap.dispose();
});

test('failing capture restores the original and backs up marked text changed by native scripts', async () => {
    const f = await fixture();
    await assert.rejects(f.swap.run(context(), temporary, () => {
        f.message().data = 'Script-transformed text';
        throw new Error('DOM capture failed');
    }), /DOM capture failed/);
    assert.equal(f.message().data, original);
    assert.deepEqual(f.saved().entries[0].displaced, ['Script-transformed text']);
    assert.equal(Object.hasOwn(f.message(), TEMPORARY_MARK), false);
    await f.swap.dispose();
});

test('restoration retries keep the output promise pending while the temporary message is present', { timeout: 3000 }, async () => {
    const f = await fixture();
    const failed = deferred();
    let fail = true;
    let settled = false;
    f.beforeWrite = (_character, _chat, chat) => {
        if (chat.message[0].data === original && fail) {
            failed.resolve();
            throw new Error('restore temporarily unavailable');
        }
    };
    const running = f.swap.run(context(), temporary, () => 'rendered');
    running.then(() => { settled = true; }, () => { settled = true; });
    await failed.promise;
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.message().data, temporary);
    assert.equal(f.swap.original(context()), original);
    assert.equal(f.swap.busy, true);
    fail = false;
    assert.equal(await running, 'rendered');
    assert.equal(f.message().data, original);
    assert.equal(settled, true);
    await f.swap.dispose();
});

test('a setter that throws after applying a temporary write is still restored before rejection', async () => {
    const f = await fixture();
    f.afterWrite = (_character, _chat, chat) => {
        if (chat.message[0][TEMPORARY_MARK]) throw new Error('reply channel failed after write');
    };
    await assert.rejects(f.swap.run(context(), temporary, () => assert.fail('capture must not run')), /reply channel failed/);
    assert.equal(f.message().data, original);
    assert.equal(Object.hasOwn(f.message(), TEMPORARY_MARK), false);
    await f.swap.dispose();
});

test('startup recovers an interrupted swap and durably retains displaced marked text before restoring', async () => {
    const f = await interruptedSwap({ transformed: true });
    assert.equal(f.message().data, 'Native-script transformed translation');
    f.beforeWrite = (_character, _chat, chat) => {
        if (chat.message[0].data === original) {
            assert.deepEqual(f.saved().entries[0].displaced, ['Native-script transformed translation']);
        }
    };
    const swap = await createMessageSwap(f.api);
    assert.equal(f.message().data, original);
    assert.equal(Object.hasOwn(f.message(), TEMPORARY_MARK), false);
    assert.equal(swap.status.retained, 1);
    assert.equal(swap.error, '');
    await swap.dispose();
});

test('recovery never clobbers a subsequent unmarked user edit, even if it equals the old translation', async () => {
    const f = await interruptedSwap();
    const swap = await createMessageSwap(f.api);
    f.message().data = temporary;
    const writes = f.writes.length;
    await swap.recover();
    assert.equal(f.message().data, temporary);
    assert.equal(f.writes.length, writes);
    const next = f.restart();
    const reloaded = await createMessageSwap(next.api);
    assert.equal(next.message().data, temporary);
    assert.equal(next.writes.length, 0);
    await swap.dispose();
    await reloaded.dispose();
});

test('character, chat and message reordering plus reselection restore by IDs rather than stale indices', async () => {
    const f = await fixture();
    await f.swap.run(context({ characterIndex: 99, chatIndex: 99, messageIndex: 99 }), temporary, () => {
        const characters = f.database.characters;
        f.database.characters = { 'storage-key-b': characters['storage-key-b'], 'storage-key-a': characters['storage-key-a'] };
        characters['storage-key-a'].chats.reverse();
        characters['storage-key-a'].chatPage = 0;
        f.chat().message.reverse();
        return 'captured';
    });
    assert.equal(f.message().data, original);
    assert.equal(f.database.characters['storage-key-a'].chats[0].message[0].data, 'Untouched');
    assert.equal(f.writes[1].characterIndex, 1);
    assert.equal(f.writes[1].chatIndex, 1);
    assert.equal(f.writes[1].chat.message[0].data, 'Another message');
    await f.swap.dispose();
});

test('a reorder between database discovery and character snapshot is detected before any write', async () => {
    const f = await fixture();
    let reordered = false;
    f.beforeCharacterRead = () => {
        if (reordered) return;
        reordered = true;
        const characters = f.database.characters;
        f.database.characters = { 'storage-key-b': characters['storage-key-b'], 'storage-key-a': characters['storage-key-a'] };
    };
    await f.swap.run(context(), temporary, () => 'captured');
    assert.equal(f.writes[0].characterIndex, 1);
    assert.equal(f.message().data, original);
    assert.equal(f.database.characters['storage-key-b'].chats[0].message.length, 0);
    await f.swap.dispose();
});

test('fresh restoration preserves unrelated concurrent chat, variable and message metadata changes', async () => {
    const f = await fixture();
    await f.swap.run(context(), temporary, () => {
        f.chat().modules.push('new-module');
        f.chat().scriptstate.score = 8;
        f.chat().GLGlobalVariables.mode = 'after';
        f.chat().note = 'Concurrent note';
        f.chat().localLore.push({ key: 'weather', content: 'rain' });
        f.message().generationInfo.model = 'updated-model';
        f.message().scriptstateCheckpoint = { before: { score: 1 }, after: { score: 8 } };
        f.message().otherPlugin = { saved: true };
        f.chat().message[1].data = 'User changed another message';
        return 'captured';
    });
    assert.equal(f.message().data, original);
    assert.deepEqual(f.chat().modules, ['module-a', 'new-module']);
    assert.deepEqual(f.chat().scriptstate, { score: 8 });
    assert.deepEqual(f.chat().GLGlobalVariables, { mode: 'after' });
    assert.equal(f.chat().note, 'Concurrent note');
    assert.deepEqual(f.chat().localLore, [{ key: 'weather', content: 'rain' }]);
    assert.equal(f.message().generationInfo.model, 'updated-model');
    assert.deepEqual(f.message().scriptstateCheckpoint, { before: { score: 1 }, after: { score: 8 } });
    assert.deepEqual(f.message().otherPlugin, { saved: true });
    assert.equal(f.chat().message[1].data, 'User changed another message');
    await f.swap.dispose();
});

test('deleting a target rejects capture without writing a replacement, retains backup, and can recover its reappearance', async () => {
    const f = await fixture();
    let removed;
    await assert.rejects(f.swap.run(context(), temporary, () => {
        removed = copy(f.message());
        f.chat().message.splice(0, 1);
        return 'captured';
    }), /Message is missing/);
    assert.equal(f.writes.length, 1);
    assert.equal(f.chat().message[0].data, 'Another message');
    assert.equal(f.saved().entries.length, 1);
    const unavailable = await f.swap.recover();
    assert.equal(unavailable.unavailable, 1);
    f.chat().message.push(removed);
    await f.swap.recover();
    assert.equal(f.message().data, original);
    assert.equal(f.swap.status.unavailable, 0);
    await f.swap.dispose();
});

test('an unhydrated chat is never normalized into an empty replacement during startup recovery', async () => {
    const f = await interruptedSwap();
    const hydrated = copy(f.chat());
    f.database.characters['storage-key-a'].chats[0] = { id: 'chat-a', _placeholder: true, message: [] };
    const swap = await createMessageSwap(f.api);
    assert.equal(swap.status.unavailable, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.saved().entries.length, 1);
    f.database.characters['storage-key-a'].chats[0] = hydrated;
    await swap.recover();
    assert.equal(f.message().data, original);
    await swap.dispose();
});

test('transactions serialize the entire backup, capture and restoration barrier', async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    const first = f.swap.run(context(), temporary, async () => { started.resolve(); await release.promise; return 'first'; });
    await started.promise;
    const second = f.swap.run(context(), 'Second translation', () => 'second');
    await Promise.resolve();
    assert.equal(f.writes.length, 1);
    assert.equal(f.saved().entries.length, 1);
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(f.writes.map(write => write.chat.message[0].data), [temporary, original, 'Second translation', original]);
    assert.equal(f.saved().entries.length, 2);
    await f.swap.dispose();
});

test('dispose aborts an ignoring capture and restores without awaiting that callback or starting queued swaps', { timeout: 3000 }, async () => {
    const f = await fixture();
    const started = deferred();
    let captureSignal;
    const running = f.swap.run(context(), temporary, ({ signal }) => {
        captureSignal = signal;
        started.resolve();
        return new Promise(() => {});
    });
    const rejected = assert.rejects(running, { name: 'AbortError' });
    await started.promise;
    const queued = f.swap.run(context(), 'Should never appear', () => assert.fail('queued capture must not run'));
    const queuedRejected = assert.rejects(queued, { name: 'AbortError' });
    const disposing = f.swap.dispose();
    assert.equal(captureSignal.aborted, true);
    await disposing;
    await Promise.all([rejected, queuedRejected]);
    assert.equal(f.message().data, original);
    assert.equal(f.writes.length, 2);
    assert.equal(f.swap.busy, false);
});

test('failed unload restoration leaves a durable recovery path instead of waiting forever', { timeout: 3000 }, async () => {
    const f = await fixture();
    const started = deferred();
    const running = f.swap.run(context(), temporary, () => { started.resolve(); return new Promise(() => {}); });
    const rejected = assert.rejects(running, /restore offline/);
    await started.promise;
    f.beforeWrite = (_character, _chat, chat) => {
        if (chat.message[0].data === original) throw new Error('restore offline');
    };
    await f.swap.dispose();
    await rejected;
    assert.equal(f.message().data, temporary);
    assert.match(f.swap.error, /restore offline/);
    const next = f.restart();
    const reloaded = await createMessageSwap(next.api);
    assert.equal(next.message().data, original);
    await reloaded.dispose();
});

test('a failed displaced-text publication prevents startup recovery from discarding that text', async () => {
    const f = await interruptedSwap({ transformed: true });
    f.beforePersist = () => { throw new Error('backup disk offline'); };
    const swap = await createMessageSwap(f.api);
    assert.equal(f.message().data, 'Native-script transformed translation');
    assert.equal(f.writes.length, 0);
    assert.equal(swap.status.phase, 'blocked');
    assert.match(swap.error, /backup disk offline/);
    f.beforePersist = null;
    await swap.recover();
    assert.equal(f.message().data, original);
    assert.deepEqual(f.saved().entries[0].displaced, ['Native-script transformed translation']);
    await swap.dispose();
});

test('retained token history restores an older autosave to its own original rather than the newest source', async () => {
    const f = await fixture();
    let oldAutosave;
    await f.swap.run(context(), temporary, () => { oldAutosave = copy(f.database); return 'first'; });
    f.message().data = 'A newly edited original';
    await f.swap.run(context({ source: 'A newly edited original' }), 'New translation', () => 'second');
    const next = host({ database: oldAutosave, durable: new Map([...f.durable].map(([key, value]) => [key, copy(value)])) });
    const reloaded = await createMessageSwap(next.api);
    assert.equal(next.message().data, original);
    assert.equal(next.saved().entries.length, 2);
    await f.swap.dispose();
    await reloaded.dispose();
});

test('source changes during durable backup are preserved without a temporary write', async () => {
    const f = await fixture();
    f.beforePersist = () => { f.message().data = 'Concurrent source edit'; };
    await assert.rejects(f.swap.run(context(), temporary, () => assert.fail('capture must not run')), /source changed during backup/);
    assert.equal(f.message().data, 'Concurrent source edit');
    assert.equal(f.writes.length, 0);
    assert.equal(f.saved().entries[0].original, original);
    await f.swap.dispose();
});

test('missing or ambiguous stable IDs and corrupt journals fail closed without replacing another message', async () => {
    const f = await fixture();
    await assert.rejects(f.swap.run(context({ messageId: '' }), temporary, () => ''), /Stable character/);
    f.chat().message.push({ role: 'char', chatId: 'message-a', data: 'Duplicate ID' });
    await assert.rejects(f.swap.run(context(), temporary, () => ''), /ambiguous/);
    assert.equal(f.writes.length, 0);
    const corrupt = { version: 999, entries: [] };
    const other = await fixture({ durable: new Map([[MESSAGE_SWAP_JOURNAL_KEY, corrupt]]) });
    assert.equal(other.swap.status.phase, 'blocked');
    await assert.rejects(other.swap.run(context(), temporary, () => ''), /Unsupported message backup journal/);
    assert.equal(other.writes.length, 0);
    assert.deepEqual(other.saved(), corrupt);
    await f.swap.dispose();
    await other.swap.dispose();
});

test('reloading a memory-first failed displaced backup re-acknowledges it before discarding marked text', async () => {
    const f = await interruptedSwap({ transformed: true });
    f.beforePersist = () => { throw new Error('displaced backup failed'); };
    const first = await createMessageSwap(f.api);
    assert.deepEqual(f.saved().entries[0].displaced, []);
    assert.deepEqual(f.cache.get(MESSAGE_SWAP_JOURNAL_KEY).entries[0].displaced, ['Native-script transformed translation']);
    f.beforePersist = null;
    f.beforeWrite = () => {
        assert.deepEqual(f.saved().entries[0].displaced, ['Native-script transformed translation']);
    };
    const replacement = await createMessageSwap(f.api);
    assert.equal(f.message().data, original);
    await first.dispose();
    await replacement.dispose();
});

test('an unmarked concurrent edit during capture is preserved rather than claimed as a successful restoration', async () => {
    const f = await fixture();
    await assert.rejects(f.swap.run(context(), temporary, () => {
        delete f.message()[TEMPORARY_MARK];
        f.message().data = 'An independent user edit';
        return 'captured';
    }), /edited outside the transaction/);
    assert.equal(f.message().data, 'An independent user edit');
    assert.equal(f.writes.length, 1);
    assert.equal(f.saved().entries[0].original, original);
    await f.swap.recover();
    assert.equal(f.message().data, 'An independent user edit');
    await f.swap.dispose();
});

test('a missing marker on still-temporary text holds the output barrier instead of claiming safe restoration', { timeout: 3000 }, async () => {
    const f = host();
    const waiting = deferred();
    let settled = false;
    let swap;
    swap = await createMessageSwap(f.api, () => {
        if (swap?.error.includes('lost its ownership marker')) waiting.resolve();
    });
    const running = swap.run(context(), temporary, () => {
        delete f.message()[TEMPORARY_MARK];
        return 'captured';
    });
    running.then(() => { settled = true; }, () => { settled = true; });
    await waiting.promise;
    assert.equal(settled, false);
    assert.equal(f.message().data, temporary);
    assert.equal(f.writes.length, 1);
    f.message().data = original;
    assert.equal(await running, 'captured');
    await swap.dispose();
});

test('an unchanged translation fails safely without forcing a metadata-only native rerender', async () => {
    const f = await fixture();
    await assert.rejects(f.swap.run(context(), original, () => assert.fail('capture must not run')), /equals the source/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.saved(), undefined);
    await f.swap.dispose();
});
