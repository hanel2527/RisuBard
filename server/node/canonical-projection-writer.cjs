'use strict';

function safeErrorCode(error) {
    return String(error?.code || error?.name || 'UNKNOWN_ERROR').slice(0, 128);
}

function writeCanonicalProjection(options = {}) {
    const { repository, database, directCollection } = options;
    if (!repository || typeof repository.importLegacyDatabase !== 'function') {
        throw new Error('Canonical projection repository is required');
    }
    if (!database || typeof database !== 'object') {
        throw new Error('Canonical projection database is required');
    }

    const chatState = directCollection?.kind === 'chatState';
    const strategy = chatState ? 'chat-direct' : 'bot-presets-direct';
    if (!chatState && directCollection !== 'botPresets' && directCollection !== 'botPresetState') {
        return {
            strategy: 'full-sync',
            fallbackUsed: false,
            result: repository.importLegacyDatabase(database, { mode: 'sync' }),
        };
    }

    try {
        return {
            strategy,
            fallbackUsed: false,
            result: chatState ? repository.syncLegacyChatState(database, directCollection)
                : directCollection === 'botPresetState'
                ? repository.syncLegacyPresetState(database)
                : repository.syncLegacyCollection('botPresets', database.botPresets),
        };
    } catch (directError) {
        const fallbackCode = safeErrorCode(directError);
        try {
            // A failed publish may leave a prepared journal. Finish it before
            // superseding its files, so restart cannot replay an older snapshot.
            repository.recoverPendingTransactions?.();
            return {
                strategy,
                fallbackUsed: true,
                fallbackCode,
                result: repository.importLegacyDatabase(database, { mode: 'sync' }),
            };
        } catch (fallbackError) {
            if (fallbackError && typeof fallbackError === 'object') {
                fallbackError.canonicalWriteMeta = {
                    strategy,
                    fallbackUsed: true,
                    fallbackCode,
                };
            }
            throw fallbackError;
        }
    }
}

module.exports = { writeCanonicalProjection };
