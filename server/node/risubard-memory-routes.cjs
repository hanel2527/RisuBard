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

function validInquiryTimeline(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && Array.isArray(value.messages)
        && value.messages.length <= 96
        && value.messages.every((message) => message !== null && typeof message === 'object'
            && Object.keys(message).length === 2 && hasBoundedId(message.chatId)
            && (message.role === 'user' || message.role === 'char'))
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

function createRisuBardMemoryJsonParser(express) {
    const ordinary = express.json({ limit: '512kb', strict: true })
    const history = express.json({ limit: '100mb', strict: true })
    return (req, res, next) => (req.path.startsWith('/history/')
        || req.path.startsWith('/api/risubard/memory/history/')
        ? history : ordinary)(req, res, next)
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

function validHistoryRequest(action, body) {
    if (!isRecord(body) || !hasBoundedId(body.characterId)
        || !hasBoundedId(body.chatId)) return false
    const fields = {
        status: [],
        preview: ['backupId', 'sourceOperationId'],
        capture: ['operationId', 'expectedRevision', 'kind', 'delta', 'anchorMessageId'],
        'begin-wiki': ['operationId', 'sourceBackupId', 'targetMessageId', 'sourceMessageIds'],
        'finish-wiki': ['operationId', 'outcome', 'error'],
        checkout: ['backupId', 'asNewChat', 'destinationChatId', 'expectedRevision'],
        'complete-checkout': ['forkToken', 'action', 'destinationChatId'],
        rename: ['backupId', 'branchId', 'name'],
        quick: ['backupId'],
        migrate: ['chat', 'operationId', 'dryRun'],
        rollback: ['chat', 'operationId', 'dryRun'],
    }[action]
    if (!fields || Object.keys(body).some((key) =>
        !['characterId', 'chatId', ...fields].includes(key))) return false
    for (const key of ['operationId', 'backupId', 'branchId', 'sourceBackupId',
        'targetMessageId', 'forkToken', 'destinationChatId', 'sourceOperationId']) {
        if (body[key] !== undefined && !hasBoundedId(body[key])) return false
    }
    if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision)
        || body.expectedRevision < 0)) return false
    if (body.anchorMessageId !== undefined && body.anchorMessageId !== null
        && !hasBoundedId(body.anchorMessageId)) return false
    if (body.asNewChat !== undefined && typeof body.asNewChat !== 'boolean') return false
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return false
    if (body.error !== undefined && (typeof body.error !== 'string'
        || body.error.length > 8_192)) return false
    switch (action) {
    case 'status': return true
    case 'preview':
    case 'checkout': return hasBoundedId(body.backupId)
    case 'quick': return hasBoundedId(body.backupId)
    case 'rename': return hasBoundedId(body.backupId) && body.branchId === undefined
        && hasBoundedName(body.name)
    case 'complete-checkout': return hasBoundedId(body.forkToken)
        && ['finalize', 'discard'].includes(body.action)
    case 'begin-wiki': return hasBoundedId(body.operationId)
        && hasBoundedId(body.targetMessageId)
        && Array.isArray(body.sourceMessageIds)
        && body.sourceMessageIds.length > 0 && body.sourceMessageIds.length <= 100_000
        && body.sourceMessageIds.every(hasBoundedId)
    case 'finish-wiki': return hasBoundedId(body.operationId)
        && ['applied', 'unchanged', 'kept', 'failed', 'cancelled'].includes(body.outcome)
    case 'migrate': return hasBoundedId(body.operationId)
        && isRecord(body.chat) && Array.isArray(body.chat.message)
    case 'rollback': return hasBoundedId(body.operationId)
        && (body.chat === undefined || (isRecord(body.chat) && Array.isArray(body.chat.message)))
    case 'capture': {
        const delta = body.delta
        return hasBoundedId(body.operationId)
            && ['working', 'chat-edit', 'manual'].includes(body.kind)
            && hasExactKeys(delta, ['baseSnapshotId', 'order', 'messages', 'state'])
            && (delta.baseSnapshotId === null || hasBoundedId(delta.baseSnapshotId))
            && Array.isArray(delta.order) && delta.order.length <= 1_000_000
            && delta.order.every(hasBoundedId)
            && new Set(delta.order).size === delta.order.length
            && Array.isArray(delta.messages) && delta.messages.length <= delta.order.length
            && delta.messages.every((item) => hasExactKeys(item, ['id', 'value'])
                && hasBoundedId(item.id) && isRecord(item.value))
            && new Set(delta.messages.map((item) => item.id)).size === delta.messages.length
            && isRecord(delta.state)
    }
    default: return false
    }
}

function sendHistoryError(error, res, next) {
    const code = typeof error?.code === 'string' ? error.code : undefined
    const explicit = error?.statusCode || error?.status
    const status = Number.isInteger(explicit) && explicit >= 400 && explicit < 600
        ? explicit : /conflict|pending|changed|busy|legacy|migration|checkout/i.test(`${code || ''} ${error?.message || ''}`)
            ? 409 : /invalid|required|unknown|not found|does not exist/i.test(error?.message || '')
                ? 400 : 500
    if (status === 500) return next(error)
    res.status(status).send({ error: error.message, ...(code ? { code } : {}) })
}

function canonicalHistoryInput(req) {
    const operationId = requestHeader(req, 'x-risubard-history-operation-id')
    if (operationId !== undefined && !hasBoundedId(operationId)) {
        throw Object.assign(new Error('Invalid story history operation ID'), { status: 400 })
    }
    return operationId === undefined ? req.body : {
        ...req.body, historyOperationId: operationId,
    }
}

function registerRisuBardMemoryRoutes(app, options) {
    const historyActions = {
        status: 'storyHistoryStatus', preview: 'previewStoryHistory',
        capture: 'captureStoryHistory', 'begin-wiki': 'beginStoryWiki',
        'finish-wiki': 'finishStoryWiki', checkout: 'checkoutStoryHistory',
        'complete-checkout': 'completeStoryCheckout', rename: 'renameStoryHistory',
        quick: 'quickStoryHistory', migrate: 'migrateStoryHistory',
        rollback: 'rollbackStoryHistory',
    }
    for (const [action, method] of Object.entries(historyActions)) {
        app.post(`/api/risubard/memory/history/${action}`, async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasBoundedId(requestHeader(req, 'x-session-id'))) {
                    res.status(423).send({
                        error: 'A writer session identity is required for story history',
                        code: 'SESSION_ID_REQUIRED',
                    })
                    return
                }
                if (typeof options.activeSession !== 'function') {
                    throw Object.assign(new Error('Story history session validation is unavailable'), {
                        status: 503, code: 'SESSION_VALIDATION_UNAVAILABLE',
                    })
                }
                if (!options.activeSession(req, res)) return
                if (!validHistoryRequest(action, req.body)) {
                    res.status(400).send({ error: `Invalid story history ${action} request` })
                    return
                }
                res.send(await options.service[method](req.body))
            }
            catch (error) { sendHistoryError(error, res, next) }
        })
    }
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
            next(error)
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
            next(error)
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
            next(error)
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
            next(error)
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
            next(error)
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
            next(error)
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
        catch (error) { next(error) }
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
            next(error)
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
            next(error)
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
            next(error)
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
            next(error)
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
            next(error)
        }
    })

    app.post('/api/risubard/memory/fork/complete', async (req, res, next) => {
        try {
            if (!await options.auth(req, res)) return
            if (!hasExactKeys(req.body, [
                'characterId', 'destinationChatId', 'forkToken', 'action',
            ])
                || !hasBoundedId(req.body.characterId)
                || !hasBoundedId(req.body.destinationChatId)
                || !hasBoundedId(req.body.forkToken)
                || !['finalize', 'discard'].includes(req.body.action)) {
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
            next(error)
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
            next(error)
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
                ...(req.body.timeline === undefined ? [] : ['timeline']),
            ])
            if (!validShape
                || (req.body.timeline !== undefined && !validInquiryTimeline(req.body.timeline))
                || (req.body.contextSelection !== undefined && !['required', 'auto'].includes(req.body.contextSelection))
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
                next(error)
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
            next(error)
        }
    })

    // Wiki dock: table of contents first, page bodies and searches on demand.
    const wikiScopeRoute = (path, extraKeys, valid, run) => {
        app.post(path, async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, ['characterId', 'chatId', ...extraKeys])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !valid(req.body)) {
                    res.status(400).send({ error: 'Invalid memory wiki request' })
                    return
                }
                res.send(await run(req.body))
            }
            catch (error) {
                next(error)
            }
        })
    }
    wikiScopeRoute('/api/risubard/memory/catalog', [], () => true,
        (body) => options.service.loadCatalog(body.characterId, body.chatId))
    wikiScopeRoute('/api/risubard/memory/wiki/documents', ['documentIds'],
        (body) => Array.isArray(body.documentIds)
            && body.documentIds.length > 0 && body.documentIds.length <= 256
            && body.documentIds.every(hasBoundedId),
        async (body) => ({ documents: await options.service.readDocumentBodies(
            body.characterId, body.chatId, body.documentIds) }))
    wikiScopeRoute('/api/risubard/memory/wiki/search', ['query'],
        (body) => typeof body.query === 'string'
            && body.query.trim().length > 0 && body.query.length <= 256,
        async (body) => ({ documentIds: await options.service.searchDocumentIds(
            body.characterId, body.chatId, body.query.trim()) }))
    wikiScopeRoute('/api/risubard/memory/wiki/warm', [], () => true,
        async (body) => ({ documents: await options.service.warmWiki(body.characterId, body.chatId) }))
    wikiScopeRoute('/api/risubard/memory/wiki/story', [], () => true,
        async (body) => ({ entries: await options.service.storySummaries(
            body.characterId, body.chatId) }))

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
            next(error)
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
            const optionalKeys = ['append', 'writingLanguage', 'retrievalMetadata']
                .filter((key) => req.body?.[key] !== undefined)
            if (!hasExactKeys(req.body, [...keys, ...optionalKeys])
                || !validRetrievalMetadata(req.body.retrievalMetadata)
                || (req.body.writingLanguage !== undefined
                    && !validWikiWritingLanguage(req.body.writingLanguage))
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
            res.send(await options.service.saveMarkdownWikiTurn(canonicalHistoryInput(req)))
        }
        catch (error) {
            next(error)
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
                ].filter((key) => req.body?.[key] !== undefined)
                const validShape = hasExactKeys(req.body, [
                    ...keys, ...optionalKeys,
                ])
                if (!validShape
                    || !validRetrievalMetadata(req.body.retrievalMetadata)
                    || (req.body.writingLanguage !== undefined
                        && !validWikiWritingLanguage(req.body.writingLanguage))
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
                    canonicalHistoryInput(req)
                ))
            }
            catch (error) {
                next(error)
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
                next(error)
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
                    next(error)
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
                    .reviewCanonicalWikiDocument(canonicalHistoryInput(req)))
            }
            catch (error) {
                next(error)
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
                next(error)
            }
        }
    )

    app.post(
        '/api/risubard/memory/wiki/document/grade',
        async (req, res, next) => {
            try {
                if (!await options.auth(req, res)) return
                if (!hasExactKeys(req.body, [
                    'characterId', 'chatId', 'documentId', 'grade',
                    'gradeBy', 'expectedContentHash',
                ])
                    || !hasBoundedId(req.body.characterId)
                    || !hasBoundedId(req.body.chatId)
                    || !hasBoundedId(req.body.documentId)
                    || !(req.body.grade === null
                        || (Number.isInteger(req.body.grade)
                            && req.body.grade >= 0 && req.body.grade <= 9))
                    || !['user', 'ai'].includes(req.body.gradeBy)
                    || !hasBoundedId(req.body.expectedContentHash)) {
                    res.status(400).send({
                        error: 'Invalid Markdown wiki grade request',
                    })
                    return
                }
                res.send(await options.service.setWikiDocumentGrade(
                    req.body
                ))
            }
            catch (error) {
                next(error)
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
                next(error)
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
                next(error)
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
                next(error)
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
                next(error)
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
                next(error)
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
                next(error)
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
                next(error)
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
            next(error)
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
            next(error)
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
            next(error)
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
            next(error)
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
            next(error)
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
                next(error)
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
            next(error)
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
            next(error)
        }
    })
    app.use('/api/risubard/memory', (error, _req, res, next) => {
        sendHistoryError(error, res, next)
    })
}

module.exports = {
    createRisuBardMemoryJsonParser,
    registerRisuBardMemoryRoutes,
}
