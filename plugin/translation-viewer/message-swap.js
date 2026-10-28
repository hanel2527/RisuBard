export const MESSAGE_SWAP_JOURNAL_KEY = 'risubard-translation-viewer:message-swap-journal';
export const TEMPORARY_MARK = 'risubardTranslationViewerSwap';
const RETRY_MS = 100;

const identity = context => JSON.stringify([context.characterId, context.chatId, context.messageId]);
const hasId = value => typeof value === 'string' && value.length > 0;
const messageOf = error => error instanceof Error ? error.message : String(error);
const abortError = () => Object.assign(new Error('Message rendering was cancelled.'), { name: 'AbortError' });
const failure = (code, message) => Object.assign(new Error(message), { code });

function validateJournal(value) {
    if (value === null || value === undefined) return { version: 1, entries: [] };
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Unsupported message backup journal; it has not been overwritten.');
    const tokens = new Set();
    for (const entry of value.entries) {
        if (!entry || ![entry.token, entry.characterId, entry.chatId, entry.messageId].every(hasId)
            || typeof entry.original !== 'string' || typeof entry.temporary !== 'string'
            || !Array.isArray(entry.displaced) || entry.displaced.some(text => typeof text !== 'string')
            || tokens.has(entry.token)) throw new Error('Invalid message backup journal; it has not been overwritten.');
        tokens.add(entry.token);
    }
    return value;
}

/**
 * Temporary native-render transaction, using only public plugin APIs.
 *
 * The journal is append-only: setChatToIndex acknowledges an in-memory update,
 * NOT a durable chat save. Even successfully restored records must survive a
 * restart that loads an older autosave carrying their marker. Without a host
 * save acknowledgement there is no safe time-based compaction rule.
 *
 * The host setters replace a whole chat and have no CAS/save lock. We resolve
 * stable IDs and use a fresh snapshot immediately before every write, changing
 * only data and our marker. A reorder/edit between that last read and the setter
 * is still an unavoidable plugin-API race. The marker proves ownership, not the
 * author of later text changes; displaced marked text is backed up before it is
 * restored, including native-script output or a concurrent user's edit.
 */
export async function createMessageSwap(api, onChange = () => {}) {
    const storage = await api.getLocalPluginStorage();
    let journal;
    let journalDirty = false;
    let queue = Promise.resolve();
    let pending = 0;
    let disposed = false;
    let active = null;
    let phase = 'idle';
    let error = '';
    let unavailable = 0;
    let conflicts = 0;
    let sequence = 0;
    const session = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    function notify() {
        try { Promise.resolve(onChange()).catch(() => {}); }
        catch { /* Status rendering must never interfere with restoration. */ }
    }
    function setPhase(value) { phase = value; notify(); }
    function status() { return { phase, retained: journal?.entries.length ?? 0, unavailable, conflicts, error }; }
    function enqueue(work) {
        pending++;
        notify();
        const result = queue.then(work).finally(() => { pending--; notify(); });
        queue = result.catch(() => {});
        return result;
    }
    async function loadJournal() {
        if (!journal) {
            journal = validateJournal(await storage.getItem(MESSAGE_SWAP_JOURNAL_KEY));
            // A previous plugin instance may have failed after populating the
            // host's memory cache. Re-acknowledge loaded backups before recovery
            // writes, especially before discarding any recorded displaced text.
            journalDirty = journal.entries.length > 0;
        }
    }
    async function publish(next = journal) {
        // SafeLocalPluginStorage is memory-first. A rejected publication is NOT
        // durable, even if getItem echoes it. Keep the complete candidate locally
        // and never admit its temporary chat write until setItem succeeds.
        journal = next;
        journalDirty = true;
        await storage.setItem(MESSAGE_SWAP_JOURNAL_KEY, next);
        journalDirty = false;
    }

    async function locate(context) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const database = await api.getDatabase(['characters']);
            if (!database?.characters) throw new Error('Cannot read the database to locate the original message.');
            // API indices are positions in Object.keys(characters), not object keys.
            const characters = Object.values(database.characters);
            const matches = characters.flatMap((character, index) => character?.chaId === context.characterId ? [index] : []);
            if (matches.length !== 1) throw failure(matches.length ? 'conflict' : 'unavailable',
                matches.length ? 'Character ID is ambiguous; original backup retained.' : 'Character is missing; original backup retained.');
            const characterIndex = matches[0];
            const character = await api.getCharacterFromIndex(characterIndex);
            if (character?.chaId !== context.characterId) continue;
            const chats = character.chats;
            const chatMatches = Array.isArray(chats)
                ? chats.flatMap((chat, index) => chat?.id === context.chatId ? [index] : []) : [];
            if (chatMatches.length !== 1) throw failure(chatMatches.length ? 'conflict' : 'unavailable',
                chatMatches.length ? 'Chat ID is ambiguous; original backup retained.' : 'Chat is missing; original backup retained.');
            const chatIndex = chatMatches[0];
            // This character getter is already a fresh snapshot of its chats.
            // Using it avoids an extra await between the identity check and write.
            // normalizeChat in setChatToIndex preserves message metadata, modules,
            // scriptstate and local/global variables; do not reconstruct the chat.
            const chat = chats[chatIndex];
            if (chat._placeholder || !Array.isArray(chat.message)) throw failure('unavailable', 'Chat is not hydrated; original backup retained.');
            const messageMatches = chat.message.flatMap((message, index) => message?.chatId === context.messageId ? [index] : []);
            if (messageMatches.length !== 1) throw failure(messageMatches.length ? 'conflict' : 'unavailable',
                messageMatches.length ? 'Message ID is ambiguous; original backup retained.' : 'Message is missing; original backup retained.');
            const messageIndex = messageMatches[0];
            return { characterIndex, chatIndex, messageIndex, chat, message: chat.message[messageIndex] };
        }
        throw new Error('Character ordering changed repeatedly; no message was written.');
    }

    async function restoreOnce(entry) {
        // A durable displaced-text backup adds an await, so read the chat again
        // afterward rather than writing the snapshot from before persistence.
        for (;;) {
            const target = await locate(entry);
            const marker = target.message[TEMPORARY_MARK];
            if (marker !== entry.token) {
                if (marker !== undefined) throw failure('conflict', 'Message ownership changed; original backup retained.');
                if (target.message.data === entry.original) return target;
                if (target.message.data === entry.temporary) throw failure('temporary', 'Temporary text lost its ownership marker; waiting for safe restoration.');
                throw failure('changed', 'Message was edited outside the transaction; that edit was preserved and the original backup retained.');
            }
            const current = journal.entries.find(item => item.token === entry.token);
            const text = target.message.data;
            if (typeof text !== 'string') throw failure('conflict', 'Marked message text is invalid; original backup retained.');
            if (text !== entry.original && text !== entry.temporary && !current.displaced.includes(text)) {
                await publish({ version: 1, entries: journal.entries.map(item => item.token === entry.token
                    ? { ...item, displaced: [...item.displaced, text] } : item) });
                continue;
            }
            if (journalDirty) { await publish(); continue; }
            target.message.data = entry.original;
            delete target.message[TEMPORARY_MARK];
            await api.setChatToIndex(target.characterIndex, target.chatIndex, target.chat);
            const restored = await locate(entry);
            if (restored.message.data !== entry.original || restored.message[TEMPORARY_MARK] !== undefined) {
                throw new Error('The original message restoration was not acknowledged by the chat API.');
            }
            return restored;
        }
    }

    async function recoverJournal(onlyContext) {
        setPhase('recovering');
        error = '';
        unavailable = 0;
        conflicts = 0;
        try {
            await loadJournal();
            const groups = new Map();
            const byToken = new Map(journal.entries.map(entry => [entry.token, entry]));
            for (const entry of journal.entries) {
                if (!onlyContext || identity(entry) === identity(onlyContext)) groups.set(identity(entry), entry);
            }
            for (const context of groups.values()) {
                if (disposed) break;
                try {
                    const target = await locate(context);
                    const marker = target.message[TEMPORARY_MARK];
                    // Unmarked text is never a recovery candidate, even if it
                    // equals an old temporary translation. It may be a new edit.
                    if (marker === undefined) continue;
                    const entry = byToken.get(marker);
                    if (!entry || identity(entry) !== identity(context)) throw failure('conflict', 'Unknown message swap marker; original backups retained.');
                    await restoreOnce(entry);
                } catch (cause) {
                    if (cause.code === 'unavailable') unavailable++;
                    else conflicts++;
                    error = messageOf(cause);
                }
            }
        } catch (cause) {
            error = messageOf(cause);
            setPhase('blocked');
            throw cause;
        }
        setPhase(disposed ? 'disposed' : conflicts ? 'blocked' : 'idle');
        return status();
    }

    async function waitForRetry(signal) {
        if (signal.aborted) return;
        await new Promise(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, RETRY_MS);
            signal.addEventListener('abort', done, { once: true });
        });
    }

    async function restoreActive(transaction) {
        for (;;) {
            try { return await restoreOnce(transaction.entry); }
            catch (cause) {
                error = `Original restoration pending: ${messageOf(cause)}`;
                notify();
                // Missing/deleted targets and unowned edits cannot be safely
                // rewritten. Reject (never report successful rendering), retaining
                // their backup for a later hydration/reappearance/recovery.
                if (disposed || ['unavailable', 'changed'].includes(cause.code)) throw cause;
                // A failed setter may already have written; the next attempt
                // reads fresh and recognizes an already-restored original.
                await waitForRetry(transaction.controller.signal);
            }
        }
    }

    async function captureUntilAbort(transaction, capture, target) {
        const { signal } = transaction.controller;
        if (signal.aborted) throw abortError();
        let onAbort;
        const cancelled = new Promise((_, reject) => {
            onAbort = () => reject(abortError());
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            // Promise.race observes a late capture rejection as well. An ignoring
            // callback cannot hold unload restoration hostage.
            return await Promise.race([
                Promise.resolve().then(() => {
                    if (signal.aborted) throw abortError();
                    return capture({ signal, token: transaction.entry.token, target: {
                        characterIndex: target.characterIndex, chatIndex: target.chatIndex, messageIndex: target.messageIndex,
                    } });
                }),
                cancelled,
            ]);
        } finally { signal.removeEventListener('abort', onAbort); }
    }

    async function runTransaction(context, temporaryText, capture) {
        if (disposed) throw abortError();
        if (![context?.characterId, context?.chatId, context?.messageId].every(hasId)
            || typeof context.source !== 'string' || typeof temporaryText !== 'string' || typeof capture !== 'function') {
            throw new Error('Stable character/chat/message IDs, source, temporary text and a capture callback are required.');
        }
        if (temporaryText === context.source) {
            throw new Error('The translation equals the source; a fresh native render cannot be confirmed.');
        }
        // A new transaction need not scan every historical message's backup.
        await recoverJournal(context);
        if (disposed) throw abortError();
        const initial = await locate(context);
        if (initial.message.data !== context.source || initial.message[TEMPORARY_MARK] !== undefined) {
            throw new Error('The source message changed or still needs recovery; no temporary message was written.');
        }
        const entry = {
            token: `${session}:${++sequence}`, characterId: context.characterId, chatId: context.chatId,
            messageId: context.messageId, original: initial.message.data, temporary: temporaryText,
            displaced: [], createdAt: Date.now(),
        };
        const transaction = { entry, controller: new AbortController(), mayHaveWritten: false };
        active = transaction;
        let result;
        let cause;
        try {
            setPhase('backing-up');
            await publish({ version: 1, entries: [...journal.entries, entry] });
            if (disposed) throw abortError();
            const target = await locate(entry);
            if (disposed) throw abortError();
            if (target.message.data !== entry.original || target.message[TEMPORARY_MARK] !== undefined) {
                throw new Error('The source changed during backup; no temporary message was written.');
            }
            target.message.data = temporaryText;
            target.message[TEMPORARY_MARK] = entry.token;
            transaction.mayHaveWritten = true;
            await api.setChatToIndex(target.characterIndex, target.chatIndex, target.chat);
            const written = await locate(entry);
            if (written.message[TEMPORARY_MARK] !== entry.token) throw new Error('The temporary message write was not acknowledged by the chat API.');
            setPhase('capturing');
            result = await captureUntilAbort(transaction, capture, written);
        } catch (caught) { cause = caught; }
        finally {
            if (transaction.mayHaveWritten) {
                setPhase('restoring');
                try { await restoreActive(transaction); }
                catch (restorationError) { cause = restorationError; }
            }
            active = null;
            if (disposed && !cause) cause = abortError();
            error = cause ? messageOf(cause) : '';
            setPhase(disposed ? 'disposed' : cause ? 'blocked' : 'idle');
        }
        if (cause) throw cause;
        return result;
    }

    // A corrupt/unreadable journal disables new writes, but return a manager so
    // its status is visible and a later explicit recover() can retry the read.
    await recoverJournal().catch(() => {});
    return {
        run(context, temporaryText, capture) {
            // Copy caller-owned identity/source now, before the serialized wait.
            const snapshot = context && { ...context };
            return enqueue(async () => {
                try { return await runTransaction(snapshot, temporaryText, capture); }
                catch (cause) {
                    error = messageOf(cause);
                    setPhase(disposed ? 'disposed' : 'blocked');
                    throw cause;
                }
            });
        },
        recover() { return enqueue(() => disposed ? status() : recoverJournal()); },
        dispose() {
            disposed = true;
            active?.controller.abort();
            setPhase('disposed');
            return queue.then(status);
        },
        original(context) { return active && context && identity(active.entry) === identity(context) ? active.entry.original : undefined; },
        get busy() { return pending > 0; },
        get error() { return error; },
        get status() { return status(); },
    };
}
