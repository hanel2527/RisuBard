const wikiWritingLocales = require('../../src/ts/risubard/wikiWritingLocales.json')
require('sucrase/register/ts')
const { normalizeMemoryRetrievalMetadata } = require('./risubard-memory-metadata.ts')
const { parseCanonicalTurnReceipt } = require('../../src/ts/risubard/canonicalTurnReceipt.ts')

function validRetrievalMetadata(value) {
    try {
        if (value !== undefined && Array.isArray(value?.keywords)
            && value.keywords.length > 24) return false
        normalizeMemoryRetrievalMetadata(value)
        return true
    }
    catch {
        return false
    }
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, allowedKeys) {
    if (!isRecord(value)) return false
    const keys = Object.keys(value)
    return keys.length === allowedKeys.length
        && keys.every((key) => allowedKeys.includes(key))
}

function hasBoundedId(value) {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= 1_024
}

function hasBoundedName(value) {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= 512
}

function validEvidence(value, chatId) {
    return Array.isArray(value)
        && value.length <= 12
        && value.every((item) =>
            hasExactKeys(item, ['chatId', 'messageId'])
            && item.chatId === chatId
            && hasBoundedId(item.messageId)
        )
}

function validInquiryTokenBudget(value) {
    if (!isRecord(value)) return false
    const keys = Object.keys(value)
    if (!keys.includes('target') || !keys.includes('maximum')
        || keys.some((key) => ![
            'target', 'events', 'perSource', 'maximum',
        ].includes(key))) return false
    return keys.length >= 2 && keys.length <= 4
        && Number.isSafeInteger(value.target)
        && (value.events === undefined || (Number.isSafeInteger(value.events)
            && value.events >= 256
            && value.events <= value.maximum))
        && (value.perSource === undefined
            || (Number.isSafeInteger(value.perSource)
                && value.perSource >= 256
                && value.perSource <= value.maximum))
        && Number.isSafeInteger(value.maximum)
        && value.target >= 256
        && value.target <= value.maximum
}

function validSemanticMatches(value) {
    return Array.isArray(value)
        && value.length <= 32
        && value.every((match) =>
            (hasExactKeys(match, ['documentId', 'score'])
                || (hasExactKeys(match, ['documentId', 'score', 'contentHash', 'start', 'end'])
                    && hasBoundedId(match.contentHash)
                    && Number.isSafeInteger(match.start) && match.start >= 0
                    && Number.isSafeInteger(match.end) && match.end > match.start))
            && hasBoundedId(match.documentId)
            && Number.isFinite(match.score)
            && match.score > 0
            && match.score <= 1
        )
}

function validRetrievalLimits(value) {
    return isRecord(value) && hasExactKeys(value, ['candidates', 'directSeeds'])
        && Number.isSafeInteger(value.candidates) && value.candidates >= 1 && value.candidates <= 256
        && Number.isSafeInteger(value.directSeeds) && value.directSeeds >= 1
        && value.directSeeds <= 128 && value.directSeeds <= value.candidates
}

function validWikiWritingLanguage(value) {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(wikiWritingLocales, value)
}

function validEntityHints(value) {
    return Array.isArray(value)
        && value.length <= 12
        && value.every((hint) =>
            hasExactKeys(hint, ['kind', 'names'])
            && hint.kind === 'character'
            && Array.isArray(hint.names)
            && hint.names.length >= 1
            && hint.names.length <= 16
            && hint.names.every((name) => typeof name === 'string'
                && name.trim().length > 0
                && name.length <= 128)
        )
}

function validSourceMatches(value) {
    return Array.isArray(value)
        && value.length <= 32
        && value.every((match) =>
            hasExactKeys(match, [
                'messageId', 'role', 'content', 'score', 'occurredAt',
                ...(match?.retrieval === undefined ? [] : ['retrieval']),
            ])
            && (match.retrieval === undefined || match.retrieval === 'semantic')
            && hasBoundedId(match.messageId)
            && (match.role === 'user' || match.role === 'assistant')
            && typeof match.content === 'string'
            && match.content.trim().length > 0
            && match.content.length <= 1_200
            && Number.isFinite(match.score)
            && match.score > 0
            && match.score <= 10_000
            && Number.isSafeInteger(match.occurredAt)
            && match.occurredAt >= 0
            && match.occurredAt <= 10_000_000
        )
}

function validRebootSources(body, includeGroups) {
    const groups = body?.eventSourceGroups
    return hasBoundedId(body?.characterId)
        && hasBoundedId(body?.chatId)
        && body.chatId.startsWith('reboot-')
        && Array.isArray(body.sourceMessageIds)
        && body.sourceMessageIds.length >= 1
        && body.sourceMessageIds.length <= 12
        && body.sourceMessageIds.every(hasBoundedId)
        && (!includeGroups || (Array.isArray(groups)
            && groups.length >= 1 && groups.length <= 2
            && groups.every((group) => Array.isArray(group)
                && group.length >= 1 && group.length <= 2
                && group.every(hasBoundedId))))
}

function validCanonicalReceipt(value) {
    try {
        const receipt = parseCanonicalTurnReceipt(value)
        return receipt.sourceMessageIds.every(hasBoundedId)
            && receipt.eventIds.every(hasBoundedId)
            && receipt.changes.every((change) =>
                hasBoundedId(change.documentId) && hasBoundedId(change.afterHash))
    }
    catch {
        return false
    }
}

function validWikiChatAnchor(value) {
    return hasExactKeys(value, [
        'sourceChatId', 'boundaryMessageId', 'prefixDigest', 'evidenceDigest',
    ])
        && hasBoundedId(value.sourceChatId)
        && (value.boundaryMessageId === null
            || hasBoundedId(value.boundaryMessageId))
        && typeof value.prefixDigest === 'string'
        && value.prefixDigest.length <= 64
        && typeof value.evidenceDigest === 'string'
        && value.evidenceDigest.length <= 64
}

function validWikiPrefixes(value) {
    return Array.isArray(value) && value.length <= 50_000
        && value.every((prefix) =>
            hasExactKeys(prefix, ['messageId', 'prefixDigest'])
            && hasBoundedId(prefix.messageId)
            && typeof prefix.prefixDigest === 'string'
            && /^[a-f0-9]{16}$/u.test(prefix.prefixDigest))
}

function createRisuBardMemoryJsonParser(express) {
    const ordinary = express.json({ limit: '512kb', strict: true })
    const prefixes = express.json({ limit: '8mb', strict: true })
    const recoveryPayload = express.json({ limit: '66mb', strict: true })
    return (req, res, next) => {
        const path = req.path
        const parser = /(?:^|\/)wiki\/version\/(?:prefix|preview)\/?$/u.test(path)
            ? prefixes
            : /(?:^|\/)wiki\/version\/(?:ref|recovery)(?:\/|$)/u.test(path)
                ? recoveryPayload
                : ordinary
        return parser(req, res, next)
    }
}

function requestHeader(req, name) {
    const value = req.headers?.[name]
    return typeof value === 'string' ? value : undefined
}

function decodeBoundedHeaderText(value) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > 2_048
        || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    return decoded.length > 0 && decoded.length <= 512 ? decoded : undefined
}

function sendWikiFailure(error, res, next) {
    if (error instanceof Error && (
        error.message.startsWith('Wiki chat conflict:')
        || error.message.startsWith('Wiki commit conflict:')
        || error.message.startsWith('Wiki operation pending:')
        || error.message === 'Wiki write batch is already active'
        || error.message === 'Wiki write batch is owned by another operation'
        || error.message === 'Wiki document changed since the draft was created'
    )) {
        res.status(409).send({ error: error.message })
        return
    }
    next(error)
}

function registerRisuBardMemoryRoutes(app, options) {
    const wikiRefKinds = ['save', 'recovery', 'autosave']
    const wikiRecoveryReasons = [
        'truncate', 'reroll', 'chat-delete', 'save-load',
        'reboot', 'purge-restore', 'fork',
    ]
    app.post('/api/risubard/memory/save-slot', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const characterId = requestHeader(
                req, 'x-risubard-character-id'
            )
            const sourceChatId = requestHeader(
                req, 'x-risubard-source-chat-id'
            )
            const saveId = requestHeader(req, 'x-risubard-save-id')
            const overwrite = requestHeader(req, 'x-risubard-save-overwrite')
            const sourceChatName = decodeBoundedHeaderText(requestHeader(
                req, 'x-risubard-chat-name'
            ))
            const turnCount = Number(requestHeader(
                req, 'x-risubard-turn-count'
            ))
            const latestMessageId = requestHeader(
                req, 'x-risubard-latest-message-id'
            )
            if (!hasBoundedId(characterId)
                || !hasBoundedId(sourceChatId)
                || !hasBoundedId(saveId)
                || (overwrite !== undefined && overwrite !== 'true')
                || !sourceChatName
                || !Number.isSafeInteger(turnCount)
                || turnCount < 0
                || (latestMessageId !== undefined
                    && !hasBoundedId(latestMessageId))
                || !Buffer.isBuffer(req.body)
                || req.body.byteLength === 0
                || req.body.byteLength > 100 * 1024 * 1024) {
                res.status(400).send({ error: 'Invalid memory save request' })
                return
            }
            res.send(await options.service.createMemorySave({
                characterId,
                sourceChatId,
                saveId,
                ...(overwrite === 'true' ? { overwrite: true } : {}),
                sourceChatName,
                turnCount,
                ...(latestMessageId ? { latestMessageId } : {}),
                chatBytes: req.body,
            }))
        }
        catch (error) {
            if (error instanceof Error
                && error.message === 'Memory fork destination already exists') {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/list', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'sourceChatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.sourceChatId)) {
                res.status(400).send({ error: 'Invalid memory save list request' })
                return
            }
            res.send(await options.service.listMemorySaves(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/preview', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'saveId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.saveId)) {
                res.status(400).send({ error: 'Invalid memory save preview request' })
                return
            }
            const bytes = await options.service.previewMemorySave(req.body)
            res.setHeader('content-type', 'application/octet-stream')
            res.send(bytes)
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/rename', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'saveId', 'name'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.saveId)
                || !hasBoundedName(req.body.name)) {
                res.status(400).send({ error: 'Invalid memory save rename request' })
                return
            }
            res.send(await options.service.renameMemorySave({
                ...req.body,
                name: req.body.name.trim(),
            }))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/delete', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'saveId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.saveId)) {
                res.status(400).send({ error: 'Invalid memory save delete request' })
                return
            }
            await options.service.deleteMemorySave(req.body)
            res.status(204).send()
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/load', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'saveId', 'destinationChatId',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.saveId)
                || !hasBoundedId(req.body.destinationChatId)) {
                res.status(400).send({ error: 'Invalid memory save load request' })
                return
            }
            const prepared = await options.service.prepareMemorySaveLoad(
                req.body
            )
            res.setHeader('content-type', 'application/octet-stream')
            res.setHeader(
                'x-risubard-fork-token', prepared.fork.forkToken
            )
            res.send(prepared.chatBytes)
        }
        catch (error) {
            if (error instanceof Error
                && error.message === 'Memory fork destination already exists') {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/inherit', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'sourceChatId', 'destinationChatId'])
                || !hasBoundedId(req.body.characterId) || !hasBoundedId(req.body.sourceChatId)
                || !hasBoundedId(req.body.destinationChatId)
                || req.body.sourceChatId === req.body.destinationChatId) {
                res.status(400).send({ error: 'Invalid wiki inheritance request' }); return
            }
            res.send(await options.service.inheritWiki(req.body))
        }
        catch (error) { sendWikiFailure(error, res, next) }
    })

    app.post('/api/risubard/memory/wiki/import', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId', 'package'])
                || !hasBoundedId(req.body.characterId) || !hasBoundedId(req.body.chatId)) {
                res.status(400).send({ error: 'Invalid wiki import request' }); return
            }
            try {
                const { validateWikiPackage } = require('../../src/ts/risubard/wikiTransferPackage.ts')
                validateWikiPackage(req.body.package)
            }
            catch (error) { res.status(400).send({ error: error.message }); return }
            res.send(await options.service.importWiki(req.body))
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('충돌')) {
                res.status(409).send({ error: error.message }); return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/fork', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const baseKeys = [
                'characterId', 'sourceChatId', 'destinationChatId', 'mode',
                ...(req.body?.destinationCharacterId
                    ? ['destinationCharacterId']
                    : []),
            ]
            const branch = req.body?.mode === 'branch'
            const validMessages = Array.isArray(req.body?.messageIds)
                && req.body.messageIds.length <= 10_000
                && req.body.messageIds.every(hasBoundedId)
                && new Set(req.body.messageIds).size
                    === req.body.messageIds.length
            const validRetained = validMessages
                && Array.isArray(req.body?.retainedMessageIds)
                && req.body.retainedMessageIds.length <= 10_000
                && req.body.retainedMessageIds.every(hasBoundedId)
                && new Set(req.body.retainedMessageIds).size
                    === req.body.retainedMessageIds.length
                && req.body.retainedMessageIds.length
                    <= req.body.messageIds.length
                && req.body.retainedMessageIds.every((id, index) =>
                    req.body.messageIds[index] === id
                )
            if (!hasExactKeys(req.body, [
                ...baseKeys,
                ...(branch ? ['retainedMessageIds', 'messageIds'] : []),
            ])
                || !hasBoundedId(req.body.characterId)
                || (req.body.destinationCharacterId !== undefined
                    && !hasBoundedId(req.body.destinationCharacterId))
                || !hasBoundedId(req.body.sourceChatId)
                || !hasBoundedId(req.body.destinationChatId)
                || req.body.sourceChatId === req.body.destinationChatId
                || !['copy', 'branch'].includes(req.body.mode)
                || (branch && !validRetained)
                || Buffer.byteLength(JSON.stringify(req.body), 'utf8')
                    > 512_000) {
                res.status(400).send({ error: 'Invalid memory fork request' })
                return
            }
            res.send(await options.service.forkMemory(req.body))
        }
        catch (error) {
            if (error instanceof Error
                && (error.message.startsWith('Memory fork conflict:')
                    || error.message
                        === 'Memory fork destination already exists')) {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/reboot/seed', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'sourceChatId', 'stagingChatId', 'commitId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.sourceChatId)
                || !hasBoundedId(req.body.stagingChatId)
                || !req.body.stagingChatId.startsWith('reboot-')
                || req.body.sourceChatId === req.body.stagingChatId
                || !hasBoundedId(req.body.commitId)) {
                res.status(400).send({ error: 'Invalid memory reboot seed' })
                return
            }
            res.send(await options.service.seedWikiReboot(req.body))
        } catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/reboot/replace', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'sourceChatId', 'destinationChatId',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.sourceChatId)
                || !req.body.sourceChatId.startsWith('reboot-')
                || !hasBoundedId(req.body.destinationChatId)
                || req.body.sourceChatId === req.body.destinationChatId) {
                res.status(400).send({ error: 'Invalid memory reboot replacement' })
                return
            }
            res.send(await options.service.replaceMemory(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/reboot/remove', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !req.body.chatId.startsWith('reboot-')) {
                res.status(400).send({ error: 'Invalid memory reboot cleanup' })
                return
            }
            res.send(await options.service.removeRebootMemory(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/reboot/recover', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const groups = req.body?.eventSourceGroups
            if (!hasExactKeys(req.body, [
                'characterId', 'chatId', 'sourceMessageIds',
                'eventSourceGroups',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !req.body.chatId.startsWith('reboot-')
                || !Array.isArray(req.body.sourceMessageIds)
                || req.body.sourceMessageIds.length < 1
                || req.body.sourceMessageIds.length > 12
                || !req.body.sourceMessageIds.every(hasBoundedId)
                || !Array.isArray(groups) || groups.length < 1 || groups.length > 2
                || !groups.every((group) => Array.isArray(group)
                    && group.length >= 1 && group.length <= 2
                    && group.every(hasBoundedId))) {
                res.status(400).send({ error: 'Invalid memory reboot recovery' })
                return
            }
            res.send(await options.service.recoverWikiRebootBatch(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/fork/complete', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'destinationChatId', 'forkToken', 'action',
                ...(req.body?.chatBase64 === undefined ? [] : ['chatBase64']),
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.destinationChatId)
                || !hasBoundedId(req.body.forkToken)
                || !['finalize', 'discard'].includes(req.body.action)
                || (req.body.chatBase64 !== undefined
                    && (req.body.action !== 'finalize'
                        || typeof req.body.chatBase64 !== 'string'
                        || req.body.chatBase64.length > 64 * 1024 * 1024))) {
                res.status(400).send({
                    error: 'Invalid memory fork completion request',
                })
                return
            }
            res.send(await options.service.completeMemoryFork(req.body))
        }
        catch (error) {
            if (error instanceof Error
                && error.message.startsWith('Memory fork')) {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/embedding-catalog', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const body = req.body
            if (!isRecord(body) || !hasExactKeys(body, ['characterId', 'chatId',
                ...(body.offset === undefined ? [] : ['offset']),
                ...(body.revision === undefined ? [] : ['revision'])])
                || !hasBoundedId(body.characterId) || !hasBoundedId(body.chatId)
                || (body.offset !== undefined && (!Number.isSafeInteger(body.offset) || body.offset < 0))
                || (body.revision !== undefined && !hasBoundedId(body.revision))
                || (body.offset > 0 && body.revision === undefined)) {
                res.status(400).send({ error: 'Invalid embedding catalog request' })
                return
            }
            res.send(await options.service.embeddingCatalog(body))
        }
        catch (error) {
            if (error instanceof Error && error.message === 'Embedding catalog revision changed') {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/inquiry', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const inquiryKeys = [
                'characterId',
                'chatId',
                'currentInput',
            ]
            const validShape = hasExactKeys(req.body, [
                ...inquiryKeys,
                ...(req.body.contextSelection === undefined ? [] : ['contextSelection']),
                ...(req.body.expectedWikiCommitId === undefined ? [] : ['expectedWikiCommitId']),
                ...(req.body.tokenBudget === undefined
                    ? []
                    : ['tokenBudget']),
                ...(req.body.fallbackInput === undefined
                    ? []
                    : ['fallbackInput']),
                ...(req.body.semanticMatches === undefined
                    ? []
                    : ['semanticMatches']),
                ...(req.body.entityHints === undefined
                    ? []
                    : ['entityHints']),
                ...(req.body.sourceMatches === undefined
                    ? []
                    : ['sourceMatches']),
                ...(req.body.sourceLimit === undefined
                    ? []
                    : ['sourceLimit']),
                ...(req.body.retrievalLimits === undefined ? [] : ['retrievalLimits']),
            ])
            if (!validShape
                || (req.body.contextSelection !== undefined && !['required', 'auto'].includes(req.body.contextSelection))
                || (req.body.expectedWikiCommitId !== undefined && req.body.expectedWikiCommitId !== null
                    && (typeof req.body.expectedWikiCommitId !== 'string'
                        || !/^[a-f0-9]{64}$/.test(req.body.expectedWikiCommitId)))
                || (req.body.retrievalLimits !== undefined && !validRetrievalLimits(req.body.retrievalLimits))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || typeof req.body.currentInput !== 'string'
                || (req.body.contextSelection !== 'required' && req.body.currentInput.trim().length === 0)
                || req.body.currentInput.length > 4_096
                || (req.body.fallbackInput !== undefined
                    && (typeof req.body.fallbackInput !== 'string'
                        || req.body.fallbackInput.trim().length === 0
                        || req.body.fallbackInput.length > 4_096))
                || (req.body.tokenBudget !== undefined
                    && !validInquiryTokenBudget(req.body.tokenBudget))
                || (req.body.semanticMatches !== undefined
                    && !validSemanticMatches(req.body.semanticMatches))
                || (req.body.entityHints !== undefined
                    && !validEntityHints(req.body.entityHints))
                || (req.body.sourceMatches !== undefined
                    && !validSourceMatches(req.body.sourceMatches))
                || (req.body.sourceLimit !== undefined
                    && (!Number.isSafeInteger(req.body.sourceLimit)
                        || req.body.sourceLimit < 0
                        || req.body.sourceLimit > 32))
                || Buffer.byteLength(JSON.stringify(req.body), 'utf8')
                    > 256 * 1_024) {
                res.status(400).send({
                    error: 'Invalid narrative inquiry request',
                })
                return
            }
            res.send(await options.service.inquireNarrative(req.body))
        }
        catch (error) {
            // Return bounded categories, never filesystem paths or document text.
            const message = error instanceof Error ? error.message : ''
            if (message.startsWith('Wiki inquiry conflict:')) {
                res.status(409).send({ error: 'BardWiki inquiry snapshot changed', code: 'source-changed' })
                return
            }
            const code = /^Required wiki context exceeds /.test(message)
                ? 'budget-exceeded'
                : /^(Invalid|Missing) Markdown wiki /.test(message)
                    ? 'invalid-document'
                    : ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'EMFILE'].includes(error?.code)
                        ? 'storage-error'
                        : 'server-error'
            console.error('BardWiki inquiry failed', error)
            res.status(500).send({ error: 'BardWiki inquiry failed', code })
        }
    })

    app.post(
        '/api/risubard/memory/analysis/observe',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId',
                    'chatId',
                    'status',
                    'appliedCount',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || (req.body.status !== 'success'
                        && req.body.status !== 'failed')
                    || !Number.isSafeInteger(req.body.appliedCount)
                    || req.body.appliedCount < 0
                    || req.body.appliedCount > 128) {
                    res.status(400).send({
                        error: 'Invalid memory analysis observation',
                    })
                    return
                }
                await options.service.recordGraphAnalysis(
                    req.body.characterId,
                    req.body.chatId,
                    {
                        status: req.body.status,
                        appliedCount: req.body.appliedCount,
                    }
                )
                res.send({ ok: true })
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post('/api/risubard/memory/view', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)) {
                res.status(400).send({ error: 'Invalid memory view request' })
                return
            }
            res.send(await options.service.loadView(
                req.body.characterId,
                req.body.chatId
            ))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/replace', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'chatId', 'find', 'replacement',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || typeof req.body.find !== 'string'
                || req.body.find.length === 0
                || req.body.find.length > 256
                || typeof req.body.replacement !== 'string'
                || req.body.replacement.length > 256) {
                res.status(400).send({ error: 'Invalid wiki replacement' })
                return
            }
            res.send(await options.service.replaceWikiText(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/save', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const keys = [
                'characterId',
                'chatId',
                'sourceMessageIds',
                'markdown',
            ]
            const optionalKeys = [
                'append', 'writingLanguage', 'retrievalMetadata', 'chatAnchor',
                'operationId',
            ].filter((key) => req.body?.[key] !== undefined)
            if (!hasExactKeys(req.body, [...keys, ...optionalKeys])
                || !validRetrievalMetadata(req.body.retrievalMetadata)
                || (req.body.writingLanguage !== undefined
                    && !validWikiWritingLanguage(req.body.writingLanguage))
                || (req.body.chatAnchor !== undefined
                    && !validWikiChatAnchor(req.body.chatAnchor))
                || (req.body.operationId !== undefined
                    && !hasBoundedId(req.body.operationId))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !Array.isArray(req.body.sourceMessageIds)
                || req.body.sourceMessageIds.length < 1
                || !req.body.sourceMessageIds.every(hasBoundedId)
                || typeof req.body.markdown !== 'string'
                || req.body.markdown.trim().length === 0
                || (req.body.append !== undefined
                    && typeof req.body.append !== 'boolean')) {
                res.status(400).send({ error: 'Invalid Markdown wiki update' })
                return
            }
            res.send(await options.service.saveMarkdownWikiTurn(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post(
        '/api/risubard/memory/wiki/document/save',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                const keys = [
                    'characterId',
                    'chatId',
                    'type',
                    'title',
                    'sourceMessageIds',
                    'markdown',
                ]
                const optionalKeys = [
                    'documentId', 'expectedContentHash', 'reviewStatus',
                    'writingLanguage', 'aliases', 'retrievalMetadata',
                    'chatAnchor', 'operationId',
                ].filter((key) => req.body?.[key] !== undefined)
                const validShape = hasExactKeys(req.body, [
                    ...keys, ...optionalKeys,
                ])
                if (!validShape
                    || !validRetrievalMetadata(req.body.retrievalMetadata)
                    || (req.body.writingLanguage !== undefined
                        && !validWikiWritingLanguage(req.body.writingLanguage))
                    || (req.body.chatAnchor !== undefined
                        && !validWikiChatAnchor(req.body.chatAnchor))
                    || (req.body.operationId !== undefined
                        && !hasBoundedId(req.body.operationId))
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || (req.body.documentId !== undefined
                        && !hasBoundedId(req.body.documentId))
                    || (req.body.expectedContentHash !== undefined
                        && !hasBoundedId(req.body.expectedContentHash))
                    || (req.body.reviewStatus !== undefined
                        && !['unreviewed', 'reviewed'].includes(
                            req.body.reviewStatus
                        ))
                    || ![
                        'character', 'location', 'scene', 'faction', 'creature',
                        'item', 'concept', 'other',
                    ].includes(req.body.type)
                    || typeof req.body.title !== 'string'
                    || req.body.title.trim().length === 0
                    || req.body.title.length > 160
                    || (req.body.aliases !== undefined
                        && (!Array.isArray(req.body.aliases)
                            || req.body.aliases.length > 32
                            || !req.body.aliases.every((alias) =>
                                typeof alias === 'string'
                                && alias.trim().length > 0
                                && alias.length <= 160)))
                    || !Array.isArray(req.body.sourceMessageIds)
                    || req.body.sourceMessageIds.length < 1
                    || !req.body.sourceMessageIds.every(hasBoundedId)
                    || typeof req.body.markdown !== 'string'
                    || req.body.markdown.trim().length === 0) {
                    res.status(400).send({
                        error: 'Invalid canonical Markdown wiki update',
                    })
                    return
                }
                res.send(await options.service.saveCanonicalWikiDocument(
                    req.body
                ))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/document/manual-save',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                const keys = [
                    'characterId', 'chatId', 'type', 'title', 'markdown',
                ]
                const optionalKeys = [
                    'documentId', 'expectedContentHash', 'aliases',
                ].filter((key) => req.body?.[key] !== undefined)
                const validShape = hasExactKeys(req.body, [
                    ...keys, ...optionalKeys,
                ])
                if (!validShape
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || (req.body.documentId !== undefined
                        && !hasBoundedId(req.body.documentId))
                    || (req.body.expectedContentHash !== undefined
                        && !hasBoundedId(req.body.expectedContentHash))
                    || ![
                        'character', 'location', 'scene', 'faction', 'creature',
                        'item', 'concept', 'other', 'event',
                    ].includes(req.body.type)
                    || (req.body.type === 'event'
                        && req.body.documentId === undefined)
                    || typeof req.body.title !== 'string'
                    || req.body.title.trim().length === 0
                    || req.body.title.length > 160
                    || (req.body.aliases !== undefined
                        && (!Array.isArray(req.body.aliases)
                            || req.body.aliases.length > 32
                            || !req.body.aliases.every((alias) =>
                                typeof alias === 'string'
                                && alias.trim().length > 0
                                && alias.length <= 160)))
                    || typeof req.body.markdown !== 'string'
                    || req.body.markdown.trim().length === 0) {
                    res.status(400).send({
                        error: 'Invalid manual Markdown wiki update',
                    })
                    return
                }
                res.send(await options.service.saveManualWikiDocument(
                    req.body
                ))
            }
            catch (error) {
                if (error?.message === 'Wiki document changed since the draft was created') {
                    res.status(409).send({ error: 'Wiki document changed since the draft was created' })
                    return
                }
                sendWikiFailure(error, res, next)
            }
        }
    )

    for (const [action, method] of [
        ['begin', 'beginBardChatUndo'],
        ['finalize', 'finalizeBardChatUndo'],
        ['status', 'getBardChatUndoStatus'],
        ['restore', 'restoreBardChatUndo'],
    ]) {
        app.post(
            `/api/risubard/memory/wiki/bardchat-undo/${action}`,
            async (req, res, next) => {
                try {
                    if (!await options.auth(req, res)) return
                    if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                        || !hasBoundedId(req.body.characterId)
                        || !hasBoundedId(req.body.chatId)) {
                        res.status(400).send({
                            error: 'Invalid BARDCHAT undo request',
                        })
                        return
                    }
                    res.send(await options.service[method](req.body))
                }
                catch (error) {
                    sendWikiFailure(error, res, next)
                }
            }
        )
    }

    app.post(
        '/api/risubard/memory/wiki/document/review',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'documentId', 'action',
                    'expectedContentHash',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !hasBoundedId(req.body.documentId)
                    || !['accept', 'revert'].includes(req.body.action)
                    || !hasBoundedId(req.body.expectedContentHash)) {
                    res.status(400).send({
                        error: 'Invalid canonical Markdown wiki review',
                    })
                    return
                }
                res.send(await options.service
                    .reviewCanonicalWikiDocument(req.body))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/document/context-mode',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'documentId', 'contextMode',
                    'expectedContentHash',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !hasBoundedId(req.body.documentId)
                    || !['always', 'auto', 'never'].includes(
                        req.body.contextMode
                    )
                    || !hasBoundedId(req.body.expectedContentHash)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki context-mode request',
                    })
                    return
                }
                res.send(await options.service.setWikiDocumentContextMode(
                    req.body
                ))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/event/retract-sources',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'sourceMessageIds',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !Array.isArray(req.body.sourceMessageIds)
                    || req.body.sourceMessageIds.length === 0
                    || !req.body.sourceMessageIds.every(hasBoundedId)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki source retraction request',
                    })
                    return
                }
                res.send(await options.service
                    .retractWikiEventsBySourceMessages(req.body))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/event/retract',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'documentId',
                    'expectedContentHash',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !hasBoundedId(req.body.documentId)
                    || !hasBoundedId(req.body.expectedContentHash)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki event retraction request',
                    })
                    return
                }
                res.send(await options.service.retractWikiEvent(req.body))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/document/trash',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'documentId',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !hasBoundedId(req.body.documentId)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki trash request',
                    })
                    return
                }
                res.send(await options.service.trashWikiDocument(req.body))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/document/reveal',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'documentId',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !hasBoundedId(req.body.documentId)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki reveal request',
                    })
                    return
                }
                res.send(await options.service.revealWikiDocument(req.body))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/reboot/begin',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'sourceMessageIds',
                    'eventSourceGroups',
                ])
                    || !validRebootSources(req.body, true)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki reboot begin request',
                    })
                    return
                }
                res.send(await options.service.beginWikiRebootBatch(req.body))
            }
            catch (error) {
                if (error instanceof Error
                    && error.message.startsWith(
                        'Wiki reboot recovery conflict:'
                    )) {
                    res.status(409).send({ error: error.message })
                    return
                }
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/reboot/record',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'receipt',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !req.body.chatId.startsWith('reboot-')
                    || !validCanonicalReceipt(req.body.receipt)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki reboot receipt',
                    })
                    return
                }
                res.send(await options.service.recordWikiRebootBatch(req.body))
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/reboot/complete',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'sourceMessageIds',
                ]) || !validRebootSources(req.body, false)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki reboot completion',
                    })
                    return
                }
                res.send(await options.service.completeWikiRebootBatch(req.body))
            }
            catch (error) {
                if (error instanceof Error
                    && error.message.startsWith(
                        'Wiki reboot recovery conflict:'
                    )) {
                    res.status(409).send({ error: error.message })
                    return
                }
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post('/api/risubard/memory/state', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)) {
                res.status(400).send({ error: 'Invalid memory state request' })
                return
            }
            res.send(await options.service.loadState(
                req.body.characterId,
                req.body.chatId
            ))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/apply', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(
                req.body,
                [
                    'characterId',
                    'chatId',
                    'delta',
                    'availableEvidence',
                ]
            )
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !isRecord(req.body.delta)
                || !Array.isArray(req.body.delta.operations)
                || req.body.delta.operations.length > 128
                || !validEvidence(
                    req.body.availableEvidence,
                    req.body.chatId
                )
                || Buffer.byteLength(
                    JSON.stringify(req.body),
                    'utf8'
                ) > 512_000) {
                res.status(400).send({ error: 'Invalid memory update request' })
                return
            }
            res.send(await options.service.applyDelta(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/graph/state', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)) {
                res.status(400).send({
                    error: 'Invalid narrative graph state request',
                })
                return
            }
            res.send(await options.service.loadGraphState(
                req.body.characterId,
                req.body.chatId
            ))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/graph/apply', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(
                req.body,
                [
                    'characterId',
                    'chatId',
                    'delta',
                    'availableEvidence',
                ]
            )
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !isRecord(req.body.delta)
                || req.body.delta.schemaVersion !== 2
                || req.body.delta.storyId !== req.body.characterId
                || req.body.delta.branchId !== req.body.chatId
                || !Array.isArray(req.body.delta.operations)
                || req.body.delta.operations.length > 128
                || !validEvidence(
                    req.body.availableEvidence,
                    req.body.chatId
                )
                || Buffer.byteLength(
                    JSON.stringify(req.body),
                    'utf8'
                ) > 512_000) {
                res.status(400).send({
                    error: 'Invalid narrative graph update request',
                })
                return
            }
            const state = await options.service.applyGraphDelta(req.body)
            res.send({ revision: state.revision })
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/writer/apply', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(
                req.body,
                [
                    'characterId',
                    'chatId',
                    'expectedRevision',
                    'command',
                ]
            )
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !Number.isSafeInteger(req.body.expectedRevision)
                || req.body.expectedRevision < 0
                || !isRecord(req.body.command)
                || Buffer.byteLength(JSON.stringify(req.body), 'utf8')
                    > 64 * 1_024) {
                res.status(400).send({
                    error: 'Invalid RisuBard writer command request',
                })
                return
            }
            const receipt = await options.service.applyWriterCommand(req.body)
            res.send({ revision: receipt.revision })
        }
        catch (error) {
            if (error instanceof Error
                && error.message === 'Writer graph revision is stale') {
                res.status(409).send({
                    error: 'Writer graph revision is stale',
                })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post(
        '/api/risubard/memory/graph/reconcile',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)) {
                    res.status(400).send({
                        error: 'Invalid narrative graph reconciliation request',
                    })
                    return
                }
                const state = await options.service.reconcileGraphV1(
                    req.body.characterId,
                    req.body.chatId
                )
                res.send({ revision: state.revision })
            }
            catch (error) {
                sendWikiFailure(error, res, next)
            }
        }
    )

    app.post('/api/risubard/memory/source', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(
                req.body,
                ['characterId', 'chatId', 'snapshot']
            )
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !isRecord(req.body.snapshot)
                || Buffer.byteLength(JSON.stringify(req.body), 'utf8')
                    > 512_000) {
                res.status(400).send({ error: 'Invalid source snapshot request' })
                return
            }
            res.send(await options.service.ensureSourceSnapshot(
                req.body.characterId,
                req.body.chatId,
                req.body.snapshot
            ))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    // ── Wiki version store ───────────────────────────────────────────────
    // The client never invents commit IDs; every ID here comes from history.
    app.post('/api/risubard/memory/wiki/version/ensure', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const allowed = ['characterId', 'chatId', 'chatAnchor']
            if (!isRecord(req.body)
                || Object.keys(req.body).some((key) => !allowed.includes(key))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || (req.body.chatAnchor !== undefined
                    && !validWikiChatAnchor(req.body.chatAnchor))) {
                res.status(400).send({ error: 'Invalid wiki version request' })
                return
            }
            res.send(await options.service.ensureWikiVersion({
                characterId: req.body.characterId,
                chatId: req.body.chatId,
                ...(req.body.chatAnchor
                    ? { chatAnchor: req.body.chatAnchor } : {}),
            }))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/operation', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId', 'operationId'])
                || !hasBoundedId(req.body.characterId) || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.operationId)) {
                res.status(400).send({ error: 'Invalid wiki operation request' })
                return
            }
            res.send(await options.service.wikiOperationResult(req.body))
        }
        catch (error) { sendWikiFailure(error, res, next) }
    })

    app.post('/api/risubard/memory/wiki/version/ancestors', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId', 'commitId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.commitId)) {
                res.status(400).send({ error: 'Invalid wiki ancestry request' })
                return
            }
            res.send(await options.service.wikiAncestors(req.body))
        }
        catch (error) { sendWikiFailure(error, res, next) }
    })

    app.post('/api/risubard/memory/wiki/version/analysis-receipt', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId', 'commitId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !/^[a-f0-9]{64}$/.test(req.body.commitId)) {
                res.status(400).send({ error: 'Invalid wiki analysis receipt request' })
                return
            }
            res.send(await options.service.wikiAnalysisReceipt(req.body))
        }
        catch (error) { sendWikiFailure(error, res, next) }
    })

    app.post('/api/risubard/memory/wiki/version/history', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)) {
                res.status(400).send({ error: 'Invalid wiki history request' })
                return
            }
            res.send(await options.service.wikiHistory(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/capture', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId',
                ...(req.body?.poll === undefined ? [] : ['poll'])])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || (req.body.poll !== undefined && typeof req.body.poll !== 'boolean')) {
                res.status(400).send({ error: 'Invalid wiki capture request' })
                return
            }
            res.send(await options.service.captureWikiExternalChanges(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/preview', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const keys = ['characterId', 'chatId', 'commitId']
            if (req.body?.prefixes !== undefined) keys.push('prefixes')
            if (!hasExactKeys(req.body, keys)
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.commitId)
                || (req.body.prefixes !== undefined
                    && !validWikiPrefixes(req.body.prefixes))) {
                res.status(400).send({ error: 'Invalid wiki checkout preview' })
                return
            }
            res.send(await options.service.previewWikiCheckout(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/checkout', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const keys = ['characterId', 'chatId', 'commitId', 'operationId']
            const allowed = [...keys, 'reason', 'chatBase64', 'expectedChatAnchor']
            if (!isRecord(req.body)
                || Object.keys(req.body).some((key) => !allowed.includes(key))
                || !keys.every((key) => hasBoundedId(req.body[key]))
                || typeof req.body.chatBase64 !== 'string'
                || req.body.chatBase64.length > 64 * 1024 * 1024
                || (req.body.expectedChatAnchor !== undefined
                    && !validWikiChatAnchor(req.body.expectedChatAnchor))
                || (req.body.reason !== undefined
                    && !wikiRecoveryReasons.includes(req.body.reason))) {
                res.status(400).send({ error: 'Invalid wiki checkout request' })
                return
            }
            res.send(await options.service.wikiCheckout(req.body))
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('missing or corrupt')) {
                res.status(409).send({ error: 'Wiki history is incomplete' })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/fork', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'sourceChatId', 'destinationChatId', 'commitId',
                'operationId', 'chatBase64',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.sourceChatId)
                || !hasBoundedId(req.body.destinationChatId)
                || !hasBoundedId(req.body.commitId)
                || !hasBoundedId(req.body.operationId)
                || typeof req.body.chatBase64 !== 'string'
                || req.body.chatBase64.length > 64 * 1024 * 1024
                || req.body.sourceChatId === req.body.destinationChatId) {
                res.status(400).send({ error: 'Invalid wiki fork request' })
                return
            }
            res.send(await options.service.wikiFork(req.body))
        }
        catch (error) {
            if (error instanceof Error
                && error.message.includes('destination already exists')) {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/refs', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const allowed = ['characterId', 'chatId', 'kind']
            if (!isRecord(req.body)
                || Object.keys(req.body).some((key) => !allowed.includes(key))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || (req.body.kind !== undefined
                    && !wikiRefKinds.includes(req.body.kind))) {
                res.status(400).send({ error: 'Invalid wiki refs request' })
                return
            }
            res.send(await options.service.wikiRefs(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/ref', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const allowed = [
                'characterId', 'chatId', 'commitId', 'kind', 'reason', 'label',
                'chatBase64',
            ]
            if (!isRecord(req.body)
                || Object.keys(req.body).some((key) => !allowed.includes(key))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.commitId)
                || !wikiRefKinds.includes(req.body.kind)
                || (req.body.chatId !== undefined
                    && !hasBoundedId(req.body.chatId))
                || (req.body.reason !== undefined
                    && !wikiRecoveryReasons.includes(req.body.reason))
                || (req.body.chatBase64 !== undefined
                    && (typeof req.body.chatBase64 !== 'string'
                        || req.body.chatBase64.length > 64 * 1024 * 1024))
                || (req.body.label !== undefined
                    && !hasBoundedName(req.body.label))) {
                res.status(400).send({ error: 'Invalid wiki ref request' })
                return
            }
            res.send({ id: await options.service.createWikiRef(req.body) })
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/recovery/read', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId', 'id'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.id)) {
                res.status(400).send({ error: 'Invalid Wiki recovery request' })
                return
            }
            res.send(await options.service.readWikiRecovery(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/recovery/deleted', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId'])
                || !hasBoundedId(req.body.characterId)) {
                res.status(400).send({ error: 'Invalid deleted recovery request' })
                return
            }
            res.send(await options.service.deletedWikiRecovery(req.body))
        }
        catch (error) { sendWikiFailure(error, res, next) }
    })

    app.post('/api/risubard/memory/wiki/version/fork/discard', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)) {
                res.status(400).send({ error: 'Invalid Wiki fork discard request' })
                return
            }
            await options.service.discardWikiFork(req.body)
            res.send({ discarded: true })
        }
        catch (error) { sendWikiFailure(error, res, next) }
    })

    app.post('/api/risubard/memory/wiki/version/ref/delete', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId', 'kind', 'id'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.id)
                || !wikiRefKinds.includes(req.body.kind)) {
                res.status(400).send({ error: 'Invalid wiki ref delete request' })
                return
            }
            await options.service.deleteWikiRef(req.body)
            res.status(204).send()
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/prefix', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const keys = ['characterId', 'chatId', 'prefixes']
            if (req.body?.minimumBoundaryMessageId !== undefined) {
                keys.push('minimumBoundaryMessageId')
            }
            if (!hasExactKeys(req.body, keys)
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || (req.body.minimumBoundaryMessageId !== undefined
                    && req.body.minimumBoundaryMessageId !== null
                    && !hasBoundedId(req.body.minimumBoundaryMessageId))
                || !validWikiPrefixes(req.body.prefixes)) {
                res.status(400).send({ error: 'Invalid wiki prefix request' })
                return
            }
            res.send({
                commitId: await options.service.findWikiCommitByPrefix(
                    req.body
                ),
            })
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/reference', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!Buffer.isBuffer(req.body)
                || req.body.byteLength === 0
                || req.body.byteLength > 100 * 1024 * 1024) {
                res.status(400).send({ error: 'Invalid reference save body' })
                return
            }
            const characterId = requestHeader(
                req, 'x-risubard-character-id'
            )
            const sourceChatId = requestHeader(
                req, 'x-risubard-source-chat-id'
            )
            const saveId = requestHeader(req, 'x-risubard-save-id')
            const sourceChatName = decodeBoundedHeaderText(requestHeader(
                req, 'x-risubard-chat-name'
            ))
            const turnCount = Number(requestHeader(
                req, 'x-risubard-turn-count'
            ))
            if (!hasBoundedId(characterId)
                || !hasBoundedId(sourceChatId)
                || !hasBoundedId(saveId)
                || !sourceChatName
                || !Number.isSafeInteger(turnCount)
                || turnCount < 0) {
                res.status(400).send({ error: 'Invalid reference save request' })
                return
            }
            const latestMessageId = requestHeader(
                req, 'x-risubard-latest-message-id'
            )
            res.send(await options.service.writeReferenceAutosave({
                characterId,
                sourceChatId,
                saveId,
                sourceChatName,
                turnCount,
                chatBytes: req.body,
                ...(hasBoundedId(latestMessageId) ? { latestMessageId } : {}),
            }))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/reference/load', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'saveId', 'destinationChatId',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.saveId)
                || !hasBoundedId(req.body.destinationChatId)) {
                res.status(400).send({ error: 'Invalid reference load request' })
                return
            }
            const prepared = await options.service.prepareReferenceSaveLoad(
                req.body
            )
            if (!prepared.reference) {
                res.status(404).send({
                    error: 'Memory reference save does not exist',
                })
                return
            }
            res.send({
                save: {
                    saveId: prepared.reference.saveId,
                    sourceChatId: prepared.reference.sourceChatId,
                    sourceChatName: prepared.reference.sourceChatName,
                    createdAt: prepared.reference.createdAt,
                    turnCount: prepared.reference.turnCount,
                    ...(prepared.reference.latestMessageId
                        ? { latestMessageId: prepared.reference.latestMessageId }
                        : {}),
                    ...(prepared.reference.latestEvent
                        ? { latestEvent: prepared.reference.latestEvent }
                        : {}),
                },
                chatBase64: prepared.chatBytes.toString('base64'),
                ...(prepared.reference.wikiCommitId
                    ? { wikiCommitId: prepared.reference.wikiCommitId } : {}),
            })
        }
        catch (error) {
            if (error instanceof Error
                && error.message.includes('is missing')) {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/reference/export', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const allowed = [
                'characterId', 'saveId', 'targetSaveId', 'sourceChatName',
            ]
            if (!isRecord(req.body)
                || Object.keys(req.body).some((key) => !allowed.includes(key))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.saveId)
                || !hasBoundedId(req.body.targetSaveId)
                || (req.body.sourceChatName !== undefined
                    && !hasBoundedName(req.body.sourceChatName))) {
                res.status(400).send({
                    error: 'Invalid reference save export request',
                })
                return
            }
            res.send(await options.service.exportReferenceSaveCompat(req.body))
        }
        catch (error) {
            if (error instanceof Error
                && error.message.includes('is missing')) {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/save-slot/list-all', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'sourceChatId'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.sourceChatId)) {
                res.status(400).send({ error: 'Invalid save list request' })
                return
            }
            res.send(await options.service.listAllMemorySaves(req.body))
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/batch/begin', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            const allowed = [
                'characterId', 'chatId', 'operationId', 'kind', 'chatAnchor',
                'expectedHead',
            ]
            if (!isRecord(req.body)
                || Object.keys(req.body).some((key) => !allowed.includes(key))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.operationId)
                || !['analysis', 'manual', 'admin', 'review', 'rebuild']
                    .includes(req.body.kind)
                || (req.body.chatAnchor !== undefined
                    && !validWikiChatAnchor(req.body.chatAnchor))
                || (req.body.expectedHead !== undefined
                    && req.body.expectedHead !== null
                    && !/^[a-f0-9]{64}$/.test(req.body.expectedHead))) {
                res.status(400).send({ error: 'Invalid write batch request' })
                return
            }
            await options.service.beginWikiWriteBatch(req.body)
            res.send({ started: true })
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/wiki/version/batch/publish', async (req, res, next) => {
        const controller = new AbortController()
        const onClosed = () => { if (!res.writableEnded) controller.abort() }
        res.once('close', onClosed)
        try {
            if (!await options.auth(req, res)) return
            const allowed = [
                'characterId', 'chatId', 'operationId', 'chatAnchor',
                'analysisReceipt',
            ]
            if (!isRecord(req.body)
                || Object.keys(req.body).some((key) => !allowed.includes(key))
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.operationId)
                || (req.body.chatAnchor !== undefined
                    && !validWikiChatAnchor(req.body.chatAnchor))
                || (req.body.analysisReceipt !== undefined
                    && (!validCanonicalReceipt(req.body.analysisReceipt)
                        || parseCanonicalTurnReceipt(req.body.analysisReceipt).vcsCommitIds?.length))) {
                res.status(400).send({ error: 'Invalid write batch publish' })
                return
            }
            res.send(await options.service.publishWikiWriteBatch(req.body, controller.signal))
        }
        catch (error) {
            if (error instanceof Error
                && error.message === 'Wiki write batch was not started') {
                res.status(409).send({ error: error.message })
                return
            }
            sendWikiFailure(error, res, next)
        }
        finally { res.off('close', onClosed) }
    })

    app.post('/api/risubard/memory/wiki/version/batch/abandon', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'chatId', 'operationId',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || !hasBoundedId(req.body.operationId)) {
                res.status(400).send({ error: 'Invalid write batch abandon' })
                return
            }
            await options.service.abandonWikiWriteBatch(req.body)
            res.send({ abandoned: true })
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })

    app.post('/api/risubard/memory/baseline', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, ['characterId', 'chatId', 'summary'])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.chatId)
                || typeof req.body.summary !== 'string'
                || req.body.summary.trim().length === 0
                || req.body.summary.length > 12_000) {
                res.status(400).send({ error: 'Invalid baseline request' })
                return
            }
            res.send({
                summary: await options.service.saveSourceBaseline(
                    req.body.characterId,
                    req.body.chatId,
                    req.body.summary
                ),
            })
        }
        catch (error) {
            sendWikiFailure(error, res, next)
        }
    })
}

module.exports = {
    createRisuBardMemoryJsonParser,
    registerRisuBardMemoryRoutes,
}
