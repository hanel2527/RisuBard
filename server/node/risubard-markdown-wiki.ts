import { chunkWikiDocument, type WikiEmbeddingCatalog } from '../../src/ts/risubard/wikiEmbeddingChunks'
import * as nodeFs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { inquireMarkdownDocuments } from './risubard-markdown-inquiry'
import { detectWikiWritingLanguage, isWikiHeadingLabel, localizeWikiHeadings, normalizeWikiWritingLanguage, wikiHeadingLabelsPattern, wikiWritingHeadings, wikiWritingLocales, type WikiWritingLanguage } from '../../src/ts/risubard/wikiWritingLanguage'
import {
    parseCanonicalTurnReceipt,
    type CanonicalTurnReceipt,
} from '../../src/ts/risubard/canonicalTurnReceipt'
import {
    normalizeMemoryRetrievalMetadata,
    type MemoryRetrievalMetadata,
} from './risubard-memory-metadata'
import type {
    WikiAnchorMessage,
    WikiChatAnchor,
    WikiCommitKind,
} from '../../src/ts/risubard/wikiVcsContract'
import type { WikiVersioningPort } from './risubard-wiki-versioning'

export interface MarkdownWikiDocument {
    id: string
    type: MarkdownWikiDocumentType
    status: 'active' | 'superseded' | 'retracted'
    supersededBy?: string
    title: string
    aliases: string[]
    relativePath: string
    sourceMessageIds: string[]
    updated: string
    content: string
    links: string[]
    created?: string
    authoring?: 'automatic' | 'ai-assisted' | 'manual'
    contextMode: MarkdownWikiContextMode
    contentHash: string
    reviewStatus?: 'unreviewed' | 'reviewed'
    reviewBaseContent?: string
    retrievalMetadata?: MemoryRetrievalMetadata
    /** Commit this write was published as, when versioning is enabled. */
    vcsCommitId?: string
}

export type MarkdownWikiContextMode = 'always' | 'auto' | 'never'

export type MarkdownWikiDocumentType = 'event' | 'character' | 'location'
    | 'scene' | 'faction' | 'creature' | 'item' | 'concept' | 'other'
export type CanonicalMarkdownWikiDocumentType = Exclude<
    MarkdownWikiDocumentType,
    'event'
>

export interface MarkdownWikiView {
    mode: 'markdown'
    wikiPath: string
    documents: MarkdownWikiDocument[]
    health: MarkdownWikiHealth
}

export interface MarkdownWikiHealth {
    danglingLinks: Array<{ sourceId: string; target: string }>
    unlinkedDocumentIds: string[]
    duplicatePassages: Array<{ documentIds: [string, string] }>
}

interface RebootRecoveryManifest {
    version: 1
    created: string
    sourceMessageIds: string[]
    eventSourceGroups: string[][]
    documents: Array<{
        id: string
        type: CanonicalMarkdownWikiDocumentType
        relativePath: string
    }>
    receipt?: CanonicalTurnReceipt
}

export interface MarkdownWikiWorkspace {
    directory: string
    eventsDirectory: string
    charactersDirectory: string
    locationsDirectory: string
    historyDirectory: string
    trashDirectory: string
    snapshotsDirectory: string
    recoveryDirectory: string
    reviewDirectory: string
    sceneFile: string
    indexFile: string
}

type WikiFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'readFile' | 'readdir' | 'realpath' | 'rename'
    | 'rm' | 'writeFile'
>

type WikiBatchOverlay = {
    workspace: MarkdownWikiWorkspace
    liveWorkspace: MarkdownWikiWorkspace
    touchedPaths: Set<string>
    deletedPaths: Set<string>
}

function required(value: string, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function normalizeAliases(
    values: readonly string[] | undefined,
    title: string
): string[] {
    if (values === undefined) return []
    if (!Array.isArray(values) || values.length > 32) {
        throw new Error('Wiki aliases must contain at most 32 items')
    }
    const titleKey = title.normalize('NFKC').toLocaleLowerCase()
    const seen = new Set<string>()
    const aliases: string[] = []
    for (const value of values) {
        if (typeof value !== 'string') {
            throw new Error('Wiki alias must be a string')
        }
        const alias = value.trim()
        if (alias.length === 0 || alias.length > 160) {
            throw new Error('Wiki alias must contain 1-160 characters')
        }
        const key = alias.normalize('NFKC').toLocaleLowerCase()
        if (key === titleKey || seen.has(key)) continue
        seen.add(key)
        aliases.push(alias)
    }
    return aliases
}

function aliasesForSave(input: {
    aliases?: readonly string[]
    title: string
    existing?: Pick<MarkdownWikiDocument, 'title' | 'aliases' | 'id'>
    documents: readonly Pick<MarkdownWikiDocument, 'id' | 'title' | 'aliases'>[]
}): string[] {
    const values = input.aliases === undefined
        ? [...(input.existing?.aliases ?? [])]
        : [...input.aliases]
    if (input.existing
        && input.existing.title.normalize('NFKC').toLocaleLowerCase()
            !== input.title.normalize('NFKC').toLocaleLowerCase()) {
        const previousTitle = input.existing.title
            .normalize('NFKC').toLocaleLowerCase()
        // The previous title only becomes an alias when no other document
        // already owns it. Otherwise both documents would share one identifier
        // and every `[[previous title]]` link would stop resolving.
        const ownedByAnother = (input.documents ?? []).some((document) =>
            document.id !== input.existing?.id
            && [document.title, ...(document.aliases ?? [])].some((identity) =>
                identity.normalize('NFKC').toLocaleLowerCase() === previousTitle
            )
        )
        if (!ownedByAnother) values.push(input.existing.title)
    }
    return normalizeAliases(values, input.title)
}

function yamlString(value: string): string {
    return JSON.stringify(value)
}

function stableId(sourceMessageIds: readonly string[]): string {
    return createHash('sha256')
        .update(JSON.stringify(sourceMessageIds))
        .digest('base64url')
        .slice(0, 24)
}

function isLegacyFirstMessageCheckpoint(
    sourceMessageIds: readonly string[]
): boolean {
    return /^first-message:.+:-?\d+$/.test(sourceMessageIds[0] ?? '')
}

function matchesRebootSourceMessageIds(
    checkpoint: readonly string[],
    requested: readonly string[]
): boolean {
    if (JSON.stringify(checkpoint) === JSON.stringify(requested)) return true
    return checkpoint.length === requested.length + 1
        && isLegacyFirstMessageCheckpoint(checkpoint)
        && JSON.stringify(checkpoint.slice(1)) === JSON.stringify(requested)
}

function readableStem(value: string): string {
    return value.normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 64) || 'entry'
}

function normalizeMarkdown(value: string): { title: string; content: string } {
    let content = required(value, 'Markdown').trim()
        .replace(/^<Thoughts>[\s\S]*?<\/Thoughts>\s*/i, '')
        .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/i, '')
        .trim()
    if (content.length === 0) {
        throw new Error('Markdown memory must not be empty')
    }
    if (/^#\s+\S+/m.test(content)) {
        content = content.replace(/^(#{1,5})(?=\s)/gm, '$1#')
    }
    const heading = content.match(/^##\s+(.+)$/m)
    const title = (heading?.[1] ?? '서사 기록').trim().slice(0, 160)
    if (!heading) content = `## ${title}\n\n${content}`
    return { title, content }
}

function linksFrom(content: string): string[] {
    return [...content.matchAll(/\[\[([^\]\r\n]{1,240})\]\]/g)]
        .map((match) => match[1])
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 32)
}

function appendKnownDocumentLinks(
    content: string,
    documents: readonly MarkdownWikiDocument[],
    selfId: string,
    writingLanguage: WikiWritingLanguage = 'ko'
): string {
    const existingTargets = new Set(linksFrom(content).map((value) =>
        value.split('|')[0]?.split('#')[0]?.normalize('NFKC')
            .toLocaleLowerCase().trim()
    ))
    const searchable = content.normalize('NFKC').toLocaleLowerCase()
    const related = documents.filter((document) => {
        const title = document.title.normalize('NFKC').toLocaleLowerCase().trim()
        return document.id !== selfId
            && document.status === 'active'
            && title.length > 1
            && !/[\[\]\r\n]/.test(document.title)
            && !existingTargets.has(title)
            && searchable.includes(title)
    }).sort((left, right) =>
        right.title.length - left.title.length
        || left.id.localeCompare(right.id)
    ).slice(0, Math.max(0, 32 - existingTargets.size))
    if (related.length === 0) return content
    const bullets = related.map((document) => `- [[${document.title}]]`)
        .join('\n')
    const heading = `### ${wikiWritingHeadings[normalizeWikiWritingLanguage(writingLanguage)].related}`
    const relatedHeading = new RegExp(
        `^###\\s+(?:${wikiHeadingLabelsPattern('related')})\\s*$`,
        'mi'
    )
    if (relatedHeading.test(content)) {
        return content.replace(relatedHeading, () => `${heading}\n\n${bullets}`)
    }
    return `${content}\n\n${heading}\n\n${bullets}`
}

function parseRebootRecoveryManifest(value: unknown): RebootRecoveryManifest {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('invalid manifest object')
    }
    const record = value as Record<string, unknown>
    const hasReceipt = record.receipt !== undefined
    const expectedKeys = [
        'version', 'created', 'sourceMessageIds', 'eventSourceGroups',
        'documents', ...(hasReceipt ? ['receipt'] : []),
    ]
    const canonicalTypes: readonly string[] = [
        'character', 'location', 'scene', 'faction', 'creature', 'item',
        'concept', 'other',
    ]
    if (Object.keys(record).length !== expectedKeys.length
        || !expectedKeys.every((key) => Object.hasOwn(record, key))
        || record.version !== 1
        || typeof record.created !== 'string'
        || !Array.isArray(record.sourceMessageIds)
        || !record.sourceMessageIds.every((id) => typeof id === 'string')
        || !Array.isArray(record.eventSourceGroups)
        || !record.eventSourceGroups.every((group) => Array.isArray(group)
            && group.every((id) => typeof id === 'string'))
        || !Array.isArray(record.documents)) {
        throw new Error('invalid manifest fields')
    }
    const documents = record.documents.map((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error('invalid manifest document')
        }
        const document = value as Record<string, unknown>
        if (Object.keys(document).length !== 3
            || typeof document.id !== 'string'
            || !canonicalTypes.includes(String(document.type))
            || typeof document.relativePath !== 'string'
            || isAbsolute(document.relativePath)
            || document.relativePath.split(/[\\/]/).includes('..')) {
            throw new Error('invalid manifest document')
        }
        return document as unknown as RebootRecoveryManifest['documents'][number]
    })
    return {
        version: 1,
        created: record.created,
        sourceMessageIds: record.sourceMessageIds as string[],
        eventSourceGroups: record.eventSourceGroups as string[][],
        documents,
        ...(hasReceipt ? {
            receipt: parseCanonicalTurnReceipt(record.receipt),
        } : {}),
    }
}

function removeCharacterEventLinksFromRelatedDocuments(
    content: string,
    documents: readonly MarkdownWikiDocument[]
): string {
    const eventTitles = new Set(documents
        .filter((document) => document.type === 'event')
        .map((document) => document.title.normalize('NFKC')
            .toLocaleLowerCase().trim()))
    if (eventTitles.size === 0) return content
    const relatedHeadingPattern = new RegExp(
        `^###\\s+(?:${wikiHeadingLabelsPattern('related')})\\s*$`,
        'i'
    )
    let inRelatedDocuments = false
    const filtered = content.split(/\r?\n/).filter((line) => {
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
        if (heading) {
            if (heading[1].length <= 3) {
                inRelatedDocuments = heading[1].length === 3
                    && isWikiHeadingLabel('related', heading[2])
            }
            return true
        }
        if (!inRelatedDocuments) return true
        const bullet = line.match(/^\s*[-*+]\s+\[\[([^\]|#]+)(?:[^\]]*)\]\]\s*$/)
        if (!bullet) return true
        return !eventTitles.has(bullet[1].normalize('NFKC')
            .toLocaleLowerCase().trim())
    })
    const relatedHeading = filtered.findIndex((line) =>
        relatedHeadingPattern.test(line))
    if (relatedHeading >= 0) {
        const nextSection = filtered.findIndex((line, index) =>
            index > relatedHeading && /^#{1,3}\s+\S/.test(line))
        const sectionEnd = nextSection >= 0 ? nextSection : filtered.length
        if (filtered.slice(relatedHeading + 1, sectionEnd)
            .every((line) => line.trim().length === 0)) {
            filtered.splice(relatedHeading, sectionEnd - relatedHeading)
        }
    }
    return filtered.join('\n').trim()
}

function hashDocumentBytes(contents: string): string {
    return createHash('sha256').update(contents).digest('base64url')
}

function prepareDocument(
    document: Omit<MarkdownWikiDocument, 'contentHash' | 'aliases'> & {
        aliases?: string[]
    }
): { document: MarkdownWikiDocument; contents: string } {
    const normalizedDocument: Omit<MarkdownWikiDocument, 'contentHash'> = {
        ...document,
        aliases: normalizeAliases(document.aliases, document.title),
    }
    const contents = serializeDocument(normalizedDocument)
    return {
        document: {
            ...normalizedDocument,
            contentHash: hashDocumentBytes(contents),
        },
        contents,
    }
}

function serializeDocument(
    document: Omit<MarkdownWikiDocument, 'contentHash'>
): string {
    return [
        '---',
        `id: ${yamlString(document.id)}`,
        `type: ${document.type}`,
        `status: ${document.status}`,
        ...(document.supersededBy
            ? [`superseded_by: ${yamlString(document.supersededBy)}`]
            : []),
        ...(document.created
            ? [`created: ${yamlString(document.created)}`]
            : []),
        `updated: ${yamlString(document.updated)}`,
        ...(document.authoring
            ? [`authoring: ${document.authoring}`]
            : []),
        ...(document.reviewStatus
            ? [`review_status: ${document.reviewStatus}`]
            : []),
        `context: ${document.contextMode}`,
        'aliases:',
        ...document.aliases.map((alias) => `  - ${yamlString(alias)}`),
        'source_messages:',
        ...document.sourceMessageIds.map((id) => `  - ${yamlString(id)}`),
        'links:',
        ...document.links.map((link) => `  - ${yamlString(link)}`),
        ...(document.retrievalMetadata
            ? [`retrieval_metadata: ${JSON.stringify(document.retrievalMetadata)}`]
            : []),
        '---',
        '',
        document.content,
        '',
    ].join('\n')
}

export function parseDocument(
    contents: string,
    relativePath: string
): MarkdownWikiDocument {
    const boundary = contents.indexOf('\n---\n', 4)
    if (!contents.startsWith('---\n') || boundary < 0) {
        throw new Error('Invalid Markdown wiki frontmatter')
    }
    const frontmatter = contents.slice(4, boundary)
    const storedContent = contents.slice(boundary + 5).trim()
    const scalar = (key: string): string => {
        const match = frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))
        if (!match) throw new Error(`Missing Markdown wiki ${key}`)
        return JSON.parse(match[1])
    }
    const plainScalar = (key: string): string => {
        const match = frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))
        if (!match) throw new Error(`Missing Markdown wiki ${key}`)
        return match[1].trim()
    }
    const list = (key: string): string[] => {
        const match = frontmatter.match(
            new RegExp(`^${key}:\\n((?:  - .+\\n?)*)`, 'm')
        )
        if (!match) return []
        return match[1].trim().length === 0
            ? []
            : match[1].trim().split('\n').map((line) =>
                JSON.parse(line.trim().replace(/^-\s+/, ''))
            )
    }
    const storedTitle = storedContent.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim()
    const normalized = normalizeMarkdown(storedContent)
    const type = plainScalar('type')
    if (![
        'event', 'character', 'location', 'scene', 'faction', 'creature',
        'item', 'concept', 'other',
    ].includes(type)) {
        throw new Error('Invalid Markdown wiki type')
    }
    const optionalScalar = (key: string): string | undefined => {
        const match = frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))
        if (!match) return undefined
        try { return JSON.parse(match[1]) }
        catch { return match[1].trim() }
    }
    const updated = scalar('updated')
    const authoring = optionalScalar('authoring')
    const context = optionalScalar('context')
    const reviewStatus = optionalScalar('review_status')
    const retrievalMetadata = normalizeMemoryRetrievalMetadata(
        optionalScalar('retrieval_metadata')
    )
    if (reviewStatus !== undefined
        && reviewStatus !== 'unreviewed'
        && reviewStatus !== 'reviewed') {
        throw new Error('Invalid Markdown wiki review status')
    }
    const defaultContext: MarkdownWikiContextMode = type === 'scene'
        ? 'always'
        : 'auto'
    const status = plainScalar('status')
    if (status !== 'active'
        && status !== 'superseded'
        && status !== 'retracted') {
        throw new Error('Invalid Markdown wiki status')
    }
    return {
        id: scalar('id'),
        type: type as MarkdownWikiDocument['type'],
        status,
        ...(status === 'superseded'
            ? { supersededBy: required(
                optionalScalar('superseded_by') ?? '',
                'Markdown wiki supersededBy'
            ) }
            : {}),
        title: required(storedTitle ?? '', 'Markdown wiki title'),
        aliases: normalizeAliases(list('aliases'), storedTitle ?? ''),
        relativePath,
        sourceMessageIds: list('source_messages'),
        updated,
        content: normalized.content,
        links: list('links'),
        created: optionalScalar('created') ?? updated,
        authoring: (['automatic', 'ai-assisted', 'manual'].includes(
            authoring ?? ''
        ) ? authoring : type === 'event' ? 'automatic' : 'ai-assisted') as
            MarkdownWikiDocument['authoring'],
        contextMode: (['always', 'auto', 'never'].includes(context ?? '')
            ? context
            : defaultContext) as MarkdownWikiContextMode,
        contentHash: hashDocumentBytes(contents),
        ...(reviewStatus ? {
            reviewStatus: reviewStatus as 'unreviewed' | 'reviewed',
        } : {}),
        ...(retrievalMetadata ? { retrievalMetadata } : {}),
    }
}

function computeHealth(documents: MarkdownWikiDocument[]): MarkdownWikiHealth {
    const possibleTargets = new Map<string, MarkdownWikiDocument | null>()
    for (const document of documents) {
        const pathWithoutExtension = document.relativePath.replace(/\.md$/i, '')
        const fileName = basename(pathWithoutExtension)
        for (const value of [
            document.title,
            ...document.aliases,
            pathWithoutExtension,
            fileName,
        ]) {
            const key = value.normalize('NFKC').toLocaleLowerCase()
            const existing = possibleTargets.get(key)
            possibleTargets.set(
                key,
                existing && existing.id !== document.id ? null : document
            )
        }
    }
    const byTarget = new Map([...possibleTargets.entries()]
        .filter((entry): entry is [string, MarkdownWikiDocument] =>
            entry[1] !== null))
    const connected = new Set<string>()
    const danglingLinks: MarkdownWikiHealth['danglingLinks'] = []
    for (const document of documents) {
        for (const rawLink of document.links) {
            const target = rawLink.split('|')[0]?.split('#')[0]?.trim() ?? ''
            if (!target) continue
            const resolved = byTarget.get(
                target.normalize('NFKC').toLocaleLowerCase()
            )
            if (!resolved) {
                if (danglingLinks.length < 64) {
                    danglingLinks.push({ sourceId: document.id, target })
                }
                continue
            }
            if (resolved.id === document.id) continue
            connected.add(document.id)
            connected.add(resolved.id)
        }
    }
    const passageDocuments = new Map<string, Set<string>>()
    for (const document of documents) {
        if (document.status !== 'active' || document.type === 'scene') continue
        const passages = new Set(document.content.split(/\r?\n\s*\r?\n/)
            .map((passage) => passage.trim())
            .filter((passage) => passage.length > 0
                && !/^#{1,6}\s/u.test(passage)
                && passage.replace(/\[\[[^\]]+\]\]/g, '')
                    .replace(/[\s\-*•,;:|]+/gu, '').length > 0)
            .map((passage) => passage.normalize('NFKC').toLocaleLowerCase()
                .replace(/\s+/gu, ' ').trim())
            .filter((passage) => Array.from(passage).length >= 80))
        for (const passage of passages) {
            const owners = passageDocuments.get(passage) ?? new Set<string>()
            owners.add(document.id)
            passageDocuments.set(passage, owners)
        }
    }
    const duplicatePairKeys = new Set<string>()
    const duplicatePassages: MarkdownWikiHealth['duplicatePassages'] = []
    for (const owners of passageDocuments.values()) {
        const ids = [...owners].sort()
        for (let left = 0; left < ids.length; left += 1) {
            for (let right = left + 1; right < ids.length; right += 1) {
                const documentIds: [string, string] = [ids[left], ids[right]]
                const key = documentIds.join('\n')
                if (duplicatePairKeys.has(key)) continue
                duplicatePairKeys.add(key)
                duplicatePassages.push({ documentIds })
            }
        }
    }
    duplicatePassages.sort((left, right) =>
        left.documentIds.join('\n').localeCompare(right.documentIds.join('\n'))
    )
    return {
        danglingLinks,
        duplicatePassages: duplicatePassages.slice(0, 64),
        unlinkedDocumentIds: documents
            .filter((document) => document.type !== 'event'
                && document.type !== 'scene'
                && !connected.has(document.id))
            .map((document) => document.id)
            .sort()
            .slice(0, 64),
    }
}

async function writeAtomically(
    fileSystem: WikiFileSystem,
    file: string,
    contents: string
): Promise<void> {
    const temporary = `${file}.tmp-${randomUUID()}`
    try {
        await fileSystem.writeFile(temporary, contents, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        })
        await fileSystem.rename(temporary, file)
    }
    catch (error) {
        await fileSystem.rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
}

function markdownWikiWorkspaceAt(directory: string): MarkdownWikiWorkspace {
    return {
        directory,
        eventsDirectory: resolve(directory, 'events'),
        charactersDirectory: resolve(directory, 'characters'),
        locationsDirectory: resolve(directory, 'locations'),
        historyDirectory: resolve(directory, '.risubard-history'),
        trashDirectory: resolve(directory, '.risubard-trash'),
        snapshotsDirectory: resolve(directory, '.risubard-snapshots'),
        recoveryDirectory: resolve(directory, '.risubard-recovery'),
        reviewDirectory: resolve(directory, '.risubard-review'),
        sceneFile: resolve(directory, 'current-scene.md'),
        indexFile: resolve(directory, 'index.md'),
    }
}

export function resolveMarkdownWikiWorkspace(
    userDataDirectory: string,
    characterId: string,
    chatId: string
): MarkdownWikiWorkspace {
    if (!isAbsolute(required(userDataDirectory, 'userDataDirectory'))) {
        throw new Error('userDataDirectory must be absolute')
    }
    const memory = resolveMemoryWorkspace(
        userDataDirectory,
        characterId,
        chatId
    )
    return markdownWikiWorkspaceAt(resolve(memory.directory, 'wiki'))
}

export function createMarkdownNarrativeWiki(
    userDataDirectory: string,
    options: {
        fileSystem?: WikiFileSystem
        now?: () => Date
        /** Reports every completed working-tree change as one commit. */
        versioning?: WikiVersioningPort
    } = {}
) {
    const baseFileSystem = options.fileSystem ?? nodeFs
    const now = options.now ?? (() => new Date())
    const versioning = options.versioning
    const liveWorkspaceFor = (characterId: string, chatId: string) =>
        resolveMarkdownWikiWorkspace(userDataDirectory, characterId, chatId)
    const workspaceContext = new AsyncLocalStorage<{
        characterId: string
        chatId: string
        workspace: MarkdownWikiWorkspace
        overlay?: WikiBatchOverlay
    }>()
    const overlayPath = (path: unknown) => {
        const overlay = workspaceContext.getStore()?.overlay
        if (!overlay || typeof path !== 'string') return undefined
        const stagedPath = resolve(path)
        const relativePath = relative(
            overlay.workspace.directory,
            stagedPath
        )
        if (relativePath === '..'
            || relativePath.startsWith(`..${sep}`)
            || isAbsolute(relativePath)) {
            return undefined
        }
        return {
            overlay,
            stagedPath,
            livePath: join(overlay.liveWorkspace.directory, relativePath),
            relativePath,
        }
    }
    const isOverlayDeleted = (overlay: WikiBatchOverlay, path: string) => {
        for (const deleted of overlay.deletedPaths) {
            if (path === deleted || path.startsWith(`${deleted}${sep}`)) {
                return true
            }
        }
        return false
    }
    const markOverlayWrite = (
        overlay: WikiBatchOverlay,
        relativePath: string
    ) => {
        overlay.touchedPaths.add(relativePath)
        overlay.deletedPaths.delete(relativePath)
    }
    const invokeFileSystem = (
        method: (...args: never[]) => unknown,
        args: unknown[]
    ) => Reflect.apply(method, baseFileSystem, args as never[])
    const fileSystem = new Proxy(baseFileSystem, {
        get(target, property, receiver) {
            if (property === 'readFile') {
                return async (path: string, ...args: unknown[]) => {
                    const mapped = overlayPath(path)
                    if (!mapped) {
                        return invokeFileSystem(target.readFile, [path, ...args])
                    }
                    if (isOverlayDeleted(
                        mapped.overlay,
                        mapped.relativePath
                    )) {
                        return invokeFileSystem(target.readFile, [
                            mapped.stagedPath,
                            ...args,
                        ])
                    }
                    try {
                        return await invokeFileSystem(target.readFile, [
                            mapped.stagedPath,
                            ...args,
                        ])
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                            throw error
                        }
                        return invokeFileSystem(target.readFile, [
                            mapped.livePath,
                            ...args,
                        ])
                    }
                }
            }
            if (property === 'readdir') {
                return async (path: string, ...args: unknown[]) => {
                    const mapped = overlayPath(path)
                    if (!mapped || args.length > 0) {
                        return invokeFileSystem(target.readdir, [path, ...args])
                    }
                    const readEntries = async (directory: string) => {
                        try {
                            return await invokeFileSystem(
                                target.readdir,
                                [directory]
                            ) as Array<string | { name: string }>
                        }
                        catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                                throw error
                            }
                            return null
                        }
                    }
                    if (isOverlayDeleted(
                        mapped.overlay,
                        mapped.relativePath
                    )) {
                        return invokeFileSystem(
                            target.readdir,
                            [mapped.stagedPath]
                        )
                    }
                    const [staged, live] = await Promise.all([
                        readEntries(mapped.stagedPath),
                        readEntries(mapped.livePath),
                    ])
                    if (staged === null && live === null) {
                        return invokeFileSystem(
                            target.readdir,
                            [mapped.stagedPath]
                        )
                    }
                    const names = new Map<string, string | { name: string }>()
                    for (const entry of live ?? []) {
                        const name = typeof entry === 'string'
                            ? entry : entry.name
                        const relativeChild = mapped.relativePath
                            ? join(mapped.relativePath, name) : name
                        if (!isOverlayDeleted(
                            mapped.overlay,
                            relativeChild
                        )) {
                            names.set(name, entry)
                        }
                    }
                    for (const entry of staged ?? []) {
                        const name = typeof entry === 'string'
                            ? entry : entry.name
                        names.set(name, entry)
                    }
                    return [...names.values()]
                }
            }
            if (property === 'lstat' || property === 'realpath') {
                return async (path: string, ...args: unknown[]) => {
                    const mapped = overlayPath(path)
                    if (!mapped) {
                        return invokeFileSystem(
                            Reflect.get(target, property, receiver),
                            [path, ...args]
                        )
                    }
                    if (isOverlayDeleted(
                        mapped.overlay,
                        mapped.relativePath
                    )) {
                        return Promise.reject(Object.assign(
                            new Error('File does not exist'),
                            { code: 'ENOENT' }
                        ))
                    }
                    try {
                        return await invokeFileSystem(
                            Reflect.get(target, property, receiver),
                            [mapped.stagedPath, ...args]
                        )
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                            throw error
                        }
                        return invokeFileSystem(
                            Reflect.get(target, property, receiver),
                            [mapped.livePath, ...args]
                        )
                    }
                }
            }
            if (property === 'mkdir') {
                return (path: string, ...args: unknown[]) => {
                    const mapped = overlayPath(path)
                    return invokeFileSystem(
                        target.mkdir,
                        [mapped?.stagedPath ?? path, ...args]
                    )
                }
            }
            if (property === 'writeFile') {
                return async (path: string, ...args: unknown[]) => {
                    const mapped = overlayPath(path)
                    if (mapped) {
                        await invokeFileSystem(target.mkdir, [
                            resolve(mapped.stagedPath, '..'), { recursive: true },
                        ])
                        markOverlayWrite(mapped.overlay, mapped.relativePath)
                    }
                    return invokeFileSystem(
                        target.writeFile,
                        [mapped?.stagedPath ?? path, ...args]
                    )
                }
            }
            if (property === 'rm') {
                return async (path: string, ...args: unknown[]) => {
                    const mapped = overlayPath(path)
                    if (!mapped) {
                        return invokeFileSystem(target.rm, [path, ...args])
                    }
                    const options = args[0] as { force?: boolean } | undefined
                    try {
                        await invokeFileSystem(
                            target.rm,
                            [mapped.stagedPath, ...args]
                        )
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                            throw error
                        }
                        if (!options?.force) {
                            try {
                                await invokeFileSystem(
                                    target.lstat,
                                    [mapped.livePath]
                                )
                            }
                            catch {
                                throw error
                            }
                        }
                    }
                    mapped.overlay.deletedPaths.add(mapped.relativePath)
                    mapped.overlay.touchedPaths.delete(mapped.relativePath)
                }
            }
            if (property === 'rename') {
                return async (source: string, destination: string) => {
                    const sourcePath = overlayPath(source)
                    const destinationPath = overlayPath(destination)
                    if (!sourcePath && !destinationPath) {
                        return invokeFileSystem(target.rename, [
                            source, destination,
                        ])
                    }
                    if (!sourcePath || !destinationPath) {
                        throw new Error('Wiki batch rename escaped its staging tree')
                    }
                    await invokeFileSystem(target.rename, [
                        sourcePath.stagedPath,
                        destinationPath.stagedPath,
                    ])
                    sourcePath.overlay.touchedPaths.delete(
                        sourcePath.relativePath
                    )
                    sourcePath.overlay.deletedPaths.delete(
                        sourcePath.relativePath
                    )
                    markOverlayWrite(
                        destinationPath.overlay,
                        destinationPath.relativePath
                    )
                }
            }
            return Reflect.get(target, property, receiver)
        },
    }) as WikiFileSystem
    const workspaceFor = (characterId: string, chatId: string) => {
        const context = workspaceContext.getStore()
        return context?.characterId === characterId
            && context.chatId === chatId
            ? context.workspace
            : liveWorkspaceFor(characterId, chatId)
    }
    const documentCache = new Map<string, MarkdownWikiDocument[]>()
    const parsedDocuments = new Map<string, Map<string, {
        stamp: string
        document: MarkdownWikiDocument
    }>>()
    const embeddingCatalogCache = new WeakMap<MarkdownWikiDocument[], Omit<WikiEmbeddingCatalog, 'nextOffset'>>()
    type BardChatUndoFile = { relativePath: string; contents: string }
    type BardChatUndoSnapshot = {
        characterId: string
        chatId: string
        files: BardChatUndoFile[]
        signature: string
    }
    /** Commit-based undo: only the pre-operation head and diff are retained. */
    type BardChatUndoCommit = {
        characterId: string
        chatId: string
        baseHead: string | null
        signature: string
    }
    let bardChatUndoSnapshot: BardChatUndoSnapshot | null = null
    let bardChatUndoCommit: BardChatUndoCommit | null = null
    let pendingBardChatUndo: Omit<BardChatUndoSnapshot, 'signature'> & {
        beforeSignature: string
        baseHead: string | null
    } | null = null

    const cleanupLegacySnapshots = async (
        characterId: string,
        chatId: string
    ): Promise<void> => {
        const memory = resolveMemoryWorkspace(
            userDataDirectory,
            characterId,
            chatId
        )
        const workspace = workspaceFor(characterId, chatId)
        let memoryStatus: Awaited<ReturnType<WikiFileSystem['lstat']>>
        let wikiStatus: Awaited<ReturnType<WikiFileSystem['lstat']>>
        try {
            memoryStatus = await fileSystem.lstat(memory.directory)
            wikiStatus = await fileSystem.lstat(workspace.directory)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            throw error
        }
        if (memoryStatus.isSymbolicLink() || !memoryStatus.isDirectory()
            || wikiStatus.isSymbolicLink() || !wikiStatus.isDirectory()) {
            throw new Error('Wiki workspace is unsafe')
        }
        const [realMemory, realWiki] = await Promise.all([
            fileSystem.realpath(memory.directory),
            fileSystem.realpath(workspace.directory),
        ])
        const relation = relative(realMemory, realWiki)
        if (relation === '' || isAbsolute(relation) || relation === '..'
            || relation.startsWith(`..${process.platform === 'win32'
                ? '\\' : '/'}`)) {
            throw new Error('Wiki workspace escapes its memory workspace')
        }
        let snapshotsStatus: Awaited<ReturnType<WikiFileSystem['lstat']>>
        try {
            snapshotsStatus = await fileSystem.lstat(
                workspace.snapshotsDirectory
            )
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            throw error
        }
        if (snapshotsStatus.isSymbolicLink()) {
            await fileSystem.rm(workspace.snapshotsDirectory, { force: true })
            return
        }
        await fileSystem.rm(workspace.snapshotsDirectory, {
            recursive: snapshotsStatus.isDirectory(),
            force: true,
        })
    }

    const recoveryPaths = (workspace: MarkdownWikiWorkspace) => ({
        published: join(workspace.recoveryDirectory, 'reboot-batch'),
        creating: join(workspace.recoveryDirectory, 'reboot-batch.creating'),
    })

    const removeRecoveryArtifact = async (path: string): Promise<void> => {
        let status: Awaited<ReturnType<WikiFileSystem['lstat']>>
        try {
            status = await fileSystem.lstat(path)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            throw error
        }
        await fileSystem.rm(path, {
            recursive: status.isDirectory() && !status.isSymbolicLink(),
            force: true,
        })
    }

    const hasPublishedRecovery = async (
        workspace: MarkdownWikiWorkspace
    ): Promise<boolean> => {
        const { published } = recoveryPaths(workspace)
        try {
            const status = await fileSystem.lstat(published)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Wiki reboot recovery checkpoint is unsafe')
            }
            return true
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw error
        }
    }

    const cleanupUnpublishedRecovery = async (
        workspace: MarkdownWikiWorkspace
    ): Promise<boolean> => {
        if (await hasPublishedRecovery(workspace)) return false
        await removeRecoveryArtifact(recoveryPaths(workspace).creating)
        return true
    }

    const readDocument = async (
        workspace: MarkdownWikiWorkspace,
        file: string,
        relativePath: string
    ): Promise<MarkdownWikiDocument> => {
        const status = await fileSystem.lstat(file)
        if (status.isSymbolicLink() || !status.isFile()) {
            throw new Error('Wiki document path is unsafe')
        }
        const metadata = [status.dev, status.ino, status.size, status.mtimeMs, status.ctimeMs]
        const stamp = metadata.every((value) => typeof value === 'number' && Number.isFinite(value))
            ? metadata.join(':') : undefined
        const mapped = overlayPath(file)
        const directory = mapped && !mapped.overlay.touchedPaths.has(mapped.relativePath)
            ? mapped.overlay.liveWorkspace.directory : workspace.directory
        let cache = parsedDocuments.get(directory)
        const existing = cache?.get(relativePath)
        if (stamp !== undefined && existing?.stamp === stamp) return existing.document
        const document = parseDocument(await fileSystem.readFile(file, 'utf8'), relativePath)
        if (stamp !== undefined) {
            if (!cache) parsedDocuments.set(directory, cache = new Map())
            cache.set(relativePath, { stamp, document })
        }
        return document
    }

    const readDocuments = async (
        characterId: string,
        chatId: string
    ): Promise<MarkdownWikiDocument[]> => {
        const workspace = workspaceFor(characterId, chatId)
        const documents: MarkdownWikiDocument[] = []
        const folders = [
            [workspace.charactersDirectory, 'characters'],
            [workspace.locationsDirectory, 'locations'],
            [resolve(workspace.directory, 'factions'), 'factions'],
            [resolve(workspace.directory, 'creatures'), 'creatures'],
            [resolve(workspace.directory, 'items'), 'items'],
            [resolve(workspace.directory, 'concepts'), 'concepts'],
            [resolve(workspace.directory, 'notes'), 'notes'],
            [workspace.eventsDirectory, 'events'],
        ] as const
        try {
            documents.push(await readDocument(
                workspace, workspace.sceneFile, 'current-scene.md'
            ))
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        for (const [directory, prefix] of folders) {
            let files: string[]
            try {
                files = (await fileSystem.readdir(directory))
                    .filter((file) => file.endsWith('.md'))
                    .sort()
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                throw error
            }
            documents.push(...await Promise.all(files.map(file => readDocument(
                workspace, join(directory, basename(file)), `${prefix}/${file}`
            ))))
        }
        const cache = parsedDocuments.get(workspace.directory)
        if (cache) {
            const present = new Set(documents.map((document) => document.relativePath))
            for (const path of cache.keys()) {
                if (!present.has(path)) cache.delete(path)
            }
        }
        return documents
    }

    const refreshDocuments = async (
        characterId: string,
        chatId: string
    ): Promise<MarkdownWikiDocument[]> => {
        await cleanupLegacySnapshots(characterId, chatId)
        const documents = await readDocuments(characterId, chatId)
        documentCache.set(workspaceFor(characterId, chatId).directory, documents)
        return documents
    }

    const loadDocuments = async (
        characterId: string,
        chatId: string
    ): Promise<MarkdownWikiDocument[]> => {
        const workspace = workspaceFor(characterId, chatId)
        await cleanupLegacySnapshots(characterId, chatId)
        const key = workspace.directory
        return documentCache.get(key)
            ?? refreshDocuments(characterId, chatId)
    }

    const snapshotSignature = (
        documents: readonly MarkdownWikiDocument[]
    ): string => createHash('sha256').update(JSON.stringify(
        [...documents]
            .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
            .map((document) => [
                document.id, document.relativePath, document.contentHash,
            ])
    )).digest('base64url')

    const captureBardChatFiles = async (
        characterId: string,
        chatId: string
    ): Promise<{ files: BardChatUndoFile[]; signature: string }> => {
        const workspace = workspaceFor(characterId, chatId)
        const documents = await refreshDocuments(characterId, chatId)
        return {
            signature: snapshotSignature(documents),
            files: await Promise.all(documents.map(async (document) => ({
                relativePath: document.relativePath,
                contents: await fileSystem.readFile(join(
                    workspace.directory,
                    ...document.relativePath.split('/')
                ), 'utf8'),
            }))),
        }
    }

    const rebuildIndex = async (
        characterId: string,
        chatId: string,
        writingLanguage?: WikiWritingLanguage
    ): Promise<void> => {
        const workspace = workspaceFor(characterId, chatId)
        const documents = await refreshDocuments(characterId, chatId)
        const indexLanguage = normalizeWikiWritingLanguage(
            writingLanguage
            ?? documents.map((document) =>
                detectWikiWritingLanguage(document.content)).find(Boolean)
        )
        const index = [
            '---',
            'type: narrative_wiki_index',
            'status: active',
            '---',
            '',
            `## ${wikiWritingLocales[indexLanguage].indexTitle}`,
            '',
            ...documents.map((item) =>
                `- [[${item.relativePath.replace(/\.md$/, '')}|${item.title}]]`
            ),
            '',
        ].join('\n')
        await fileSystem.mkdir(workspace.directory, { recursive: true })
        await writeAtomically(fileSystem, workspace.indexFile, index)
    }

    const batchKey = (characterId: string, chatId: string) =>
        `${characterId}\u0000${chatId}`
    type WriteBatch = {
        operationId: string
        kind: WikiCommitKind
        chatAnchor?: WikiChatAnchor
        expectedHead: string | null
    } & WikiBatchOverlay
    const writeBatches = new Map<string, WriteBatch>()
    const openBatchFor = (characterId: string, chatId: string) =>
        writeBatches.get(batchKey(characterId, chatId))

    const trackedWikiPath = (path: string) =>
        path === 'current-scene.md'
        || /^(?:characters|locations|factions|creatures|items|concepts|notes|events)\/[^/]+\.md$/.test(path)
        || /^\.risubard-review\/[^/]+\.md$/.test(path)
    type TransactionalWikiVersioningPort = WikiVersioningPort & {
        captureExternalChanges(input: {
            characterId: string
            chatId: string
            chatAnchor?: WikiChatAnchor
        }): Promise<{ commitId: string | null; changedPaths: string[] }>
        publishChanges(input: {
            characterId: string
            chatId: string
            operationId: string
            kind: WikiCommitKind
            chatAnchor?: WikiChatAnchor
            expectedHead: string | null
            changes: Array<{ path: string; contents: string | null }>
        }, signal?: AbortSignal): Promise<{ commitId: string | null; changedPaths: string[] }>
    }
    const requireTransactionalVersioning = (): TransactionalWikiVersioningPort => {
        const port = versioning as Partial<TransactionalWikiVersioningPort>
            | undefined
        if (!port
            || typeof port.ensureBaseline !== 'function'
            || typeof port.captureExternalChanges !== 'function'
            || typeof port.publishChanges !== 'function') {
            throw new Error(
                'Wiki write batches require transactional versioning support'
            )
        }
        return port as TransactionalWikiVersioningPort
    }
    const persistBatchAuxiliaryFiles = async (
        batch: WriteBatch
    ): Promise<void> => {
        const paths = new Set([
            ...batch.touchedPaths,
            ...batch.deletedPaths,
        ])
        for (const relativePath of [...paths].sort()) {
            if (trackedWikiPath(relativePath.replaceAll(sep, '/'))) continue
            const livePath = join(batch.liveWorkspace.directory, relativePath)
            if (isOverlayDeleted(batch, relativePath)) {
                await fileSystem.rm(livePath, {
                    recursive: true,
                    force: true,
                })
                continue
            }
            let contents: string
            try {
                contents = await baseFileSystem.readFile(join(
                    batch.workspace.directory,
                    relativePath
                ), 'utf8')
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue
                }
                throw error
            }
            await fileSystem.mkdir(resolve(livePath, '..'), {
                recursive: true,
            })
            await writeAtomically(fileSystem, livePath, contents)
        }
    }
    const inBatchWorkspace = async <T>(
        input: { characterId: string; chatId: string; operationId?: string },
        operation: () => Promise<T>
    ): Promise<T> => {
        const batch = openBatchFor(input.characterId, input.chatId)
        if (!batch) return operation()
        if (input.operationId !== batch.operationId) {
            throw new Error('Wiki write batch is owned by another operation')
        }
        return workspaceContext.run({
            characterId: input.characterId,
            chatId: input.chatId,
            workspace: batch.workspace,
            overlay: batch,
        }, operation)
    }
    const writeTransaction = async <T>(
        input: {
            characterId: string; chatId: string; operationId?: string
            chatAnchor?: WikiChatAnchor
        },
        kind: WikiCommitKind,
        operation: () => Promise<T>
    ): Promise<T> => {
        if (!versioning) return operation()
        if (openBatchFor(input.characterId, input.chatId)) {
            return inBatchWorkspace(input, operation)
        }
        if (input.operationId) throw new Error('Wiki write batch was not started')
        const owned = { ...input, operationId: `${kind}:${randomUUID()}` }
        await service.beginWriteBatch({ ...owned, kind })
        try {
            const result = await inBatchWorkspace(owned, operation)
            const batch = openBatchFor(input.characterId, input.chatId)!
            if (batch.touchedPaths.size === 0 && batch.deletedPaths.size === 0) {
                await service.abandonWriteBatch(owned)
                return result
            }
            const published = await service.publishWriteBatch(owned)
            if (published.commitId && result && typeof result === 'object'
                && 'relativePath' in result) {
                return { ...result, vcsCommitId: published.commitId }
            }
            return result
        }
        catch (error) {
            await service.abandonWriteBatch(owned)
            throw error
        }
    }


    const service = {
        invalidateCache(characterId: string, chatId: string): void {
            documentCache.delete(workspaceFor(characterId, chatId).directory)
        },

        assertWriteOwnership(input: {
            characterId: string
            chatId: string
            operationId?: string
        }): void {
            const batch = openBatchFor(input.characterId, input.chatId)
            if (batch && input.operationId !== batch.operationId) {
                throw new Error('Wiki write batch is owned by another operation')
            }
        },

        async rebuildDerivedFiles(
            characterId: string,
            chatId: string
        ): Promise<void> {
            documentCache.delete(workspaceFor(characterId, chatId).directory)
            await rebuildIndex(characterId, chatId)
        },

        async readHead(characterId: string, chatId: string): Promise<string | null> {
            const port = requireTransactionalVersioning()
            await port.ensureBaseline({ characterId, chatId })
            await port.captureExternalChanges({ characterId, chatId })
            return port.readHead(characterId, chatId)
        },

        /**
         * Opens an operation batch. Writes inside it are not committed
         * individually; `publishWriteBatch` records all of them as one commit.
         */
        async beginWriteBatch(input: {
            characterId: string
            chatId: string
            operationId: string
            kind: WikiCommitKind
            chatAnchor?: WikiChatAnchor
            expectedHead?: string | null
        }): Promise<{ expectedHead: string | null }> {
            const key = batchKey(input.characterId, input.chatId)
            if (writeBatches.has(key)) {
                throw new Error('Wiki write batch is already active')
            }
            const port = requireTransactionalVersioning()
            const live = liveWorkspaceFor(input.characterId, input.chatId)
            const suffix = createHash('sha256')
                .update(input.operationId).digest('hex').slice(0, 20)
            const staging = markdownWikiWorkspaceAt(
                `${live.directory}.write-${suffix}`
            )
            await fileSystem.rm(staging.directory, {
                recursive: true,
                force: true,
            })
            const baseline = await port.ensureBaseline({
                characterId: input.characterId,
                chatId: input.chatId,
                operationId: `baseline:${input.operationId}`,
                ...(input.chatAnchor
                    ? { chatAnchor: input.chatAnchor } : {}),
            })
            if (input.expectedHead !== undefined
                && input.expectedHead !== baseline.commitId) {
                throw new Error('Wiki commit conflict: the branch head changed')
            }
            const batch: WriteBatch = {
                operationId: input.operationId,
                kind: input.kind,
                expectedHead: baseline.commitId,
                workspace: staging,
                liveWorkspace: live,
                touchedPaths: new Set(),
                deletedPaths: new Set(),
                ...(input.chatAnchor ? { chatAnchor: input.chatAnchor } : {}),
            }
            writeBatches.set(key, batch)
            return { expectedHead: batch.expectedHead }
        },

        /** Publishes everything written since `beginWriteBatch` as one commit. */
        async publishWriteBatch(input: {
            characterId: string
            chatId: string
            operationId: string
            chatAnchor?: WikiChatAnchor
            analysisReceipt?: CanonicalTurnReceipt
        }, signal?: AbortSignal): Promise<{ commitId: string | null; changedPaths: string[] }> {
            const key = batchKey(input.characterId, input.chatId)
            const port = requireTransactionalVersioning()
            const batch = writeBatches.get(key)
            if (!batch || batch.operationId !== input.operationId) {
                const completed = await port.readOperationReceipt(input)
                if (completed) return { commitId: completed.commitId, changedPaths: completed.changedPaths }
                throw new Error('Wiki write batch was not started')
            }
            try {
                signal?.throwIfAborted()
            const anchor = input.chatAnchor ?? batch.chatAnchor
            const paths = new Set([
                ...batch.touchedPaths,
                ...batch.deletedPaths,
            ])
            const changes: Array<{
                path: string
                contents: string | null
            }> = []
            for (const relativePath of [...paths].sort()) {
                const path = relativePath.replaceAll(sep, '/')
                if (!trackedWikiPath(path)) continue
                if (isOverlayDeleted(batch, relativePath)) {
                    changes.push({ path, contents: null })
                    continue
                }
                try {
                    changes.push({
                        path,
                        contents: await baseFileSystem.readFile(join(
                            batch.workspace.directory,
                            relativePath
                        ), 'utf8'),
                    })
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        continue
                    }
                    throw error
                }
            }
                const result = await port.publishChanges({
                    characterId: input.characterId,
                    chatId: input.chatId,
                    operationId: batch.operationId,
                    kind: batch.kind,
                    expectedHead: batch.expectedHead,
                    changes,
                    ...(anchor ? { chatAnchor: anchor } : {}),
                    ...(input.analysisReceipt
                        ? { analysisReceipt: input.analysisReceipt } : {}),
                }, signal)
                await persistBatchAuxiliaryFiles(batch)
                return result
            }
            finally {
                writeBatches.delete(key)
                documentCache.delete(batch.workspace.directory)
                parsedDocuments.delete(batch.workspace.directory)
                documentCache.delete(batch.liveWorkspace.directory)
                await fileSystem.rm(batch.workspace.directory, {
                    recursive: true,
                    force: true,
                })
            }
        },

        /** Drops an open batch without publishing, used on failed operations. */
        async abandonWriteBatch(input: {
            characterId: string
            chatId: string
            operationId: string
        }): Promise<void> {
            const key = batchKey(input.characterId, input.chatId)
            const batch = writeBatches.get(key)
            if (!batch || batch.operationId !== input.operationId) return
            writeBatches.delete(key)
            documentCache.delete(batch.workspace.directory)
            parsedDocuments.delete(batch.workspace.directory)
            await fileSystem.rm(batch.workspace.directory, {
                recursive: true,
                force: true,
            })
        },
        async beginBardChatUndo(input: {
            characterId: string
            chatId: string
        }): Promise<{ started: true }> {
            const characterId = required(input.characterId, 'Character ID')
            const chatId = required(input.chatId, 'Chat ID')
            const captured = await captureBardChatFiles(characterId, chatId)
            // The head is captured so undo can return to it without keeping a
            // second full copy of every document in memory.
            const baseHead = versioning
                ? await versioning.readHead(characterId, chatId)
                : null
            pendingBardChatUndo = {
                characterId,
                chatId,
                files: captured.files,
                beforeSignature: captured.signature,
                baseHead,
            }
            return { started: true }
        },
        async finalizeBardChatUndo(input: {
            characterId: string
            chatId: string
        }): Promise<{ available: boolean }> {
            const characterId = required(input.characterId, 'Character ID')
            const chatId = required(input.chatId, 'Chat ID')
            const pending = pendingBardChatUndo
            if (!pending || pending.characterId !== characterId
                || pending.chatId !== chatId) {
                throw new Error('BARDCHAT undo snapshot was not started')
            }
            const current = await captureBardChatFiles(characterId, chatId)
            if (current.signature !== pending.beforeSignature) {
                if (versioning && pending.baseHead) {
                    bardChatUndoCommit = {
                        characterId,
                        chatId,
                        baseHead: pending.baseHead,
                        signature: current.signature,
                    }
                    bardChatUndoSnapshot = null
                }
                else {
                    // Without version history the in-memory copy is the only
                    // way to undo, so it is retained.
                    bardChatUndoSnapshot = {
                        characterId,
                        chatId,
                        files: pending.files,
                        signature: current.signature,
                    }
                }
            }
            pendingBardChatUndo = null
            const available = bardChatUndoCommit
                ? bardChatUndoCommit.characterId === characterId
                    && bardChatUndoCommit.chatId === chatId
                : bardChatUndoSnapshot?.characterId === characterId
                    && bardChatUndoSnapshot.chatId === chatId
            return { available }
        },
        async getBardChatUndoStatus(input: {
            characterId: string
            chatId: string
        }): Promise<{ available: boolean }> {
            const characterId = required(input.characterId, 'Character ID')
            const chatId = required(input.chatId, 'Chat ID')
            return {
                available: bardChatUndoCommit
                    ? bardChatUndoCommit.characterId === characterId
                        && bardChatUndoCommit.chatId === chatId
                    : bardChatUndoSnapshot?.characterId === characterId
                        && bardChatUndoSnapshot.chatId === chatId,
            }
        },
        async restoreBardChatUndo(input: {
            characterId: string
            chatId: string
        }): Promise<{ restored: true }> {
            const characterId = required(input.characterId, 'Character ID')
            const chatId = required(input.chatId, 'Chat ID')
            const current = await refreshDocuments(characterId, chatId)
            if (versioning && bardChatUndoCommit
                && bardChatUndoCommit.characterId === characterId
                && bardChatUndoCommit.chatId === chatId) {
                if (snapshotSignature(current) !== bardChatUndoCommit.signature) {
                    throw new Error('Wiki changed after the BARDCHAT command')
                }
                await versioning.checkout({
                    characterId,
                    chatId,
                    commitId: bardChatUndoCommit.baseHead,
                    reason: 'truncate',
                })
                documentCache.delete(workspaceFor(characterId, chatId).directory)
                await rebuildIndex(characterId, chatId)
                bardChatUndoCommit = null
                pendingBardChatUndo = null
                return { restored: true }
            }
            const snapshot = bardChatUndoSnapshot
            if (!snapshot || snapshot.characterId !== characterId
                || snapshot.chatId !== chatId) {
                throw new Error('No BARDCHAT undo snapshot is available')
            }
            return writeTransaction(input, 'rebuild', async () => {
            const workspace = workspaceFor(characterId, chatId)
            if (snapshotSignature(current) !== snapshot.signature) {
                throw new Error('Wiki changed after the BARDCHAT command')
            }
            const baselinePaths = new Set(snapshot.files.map((file) =>
                file.relativePath
            ))
            for (const file of snapshot.files) {
                const target = join(
                    workspace.directory,
                    ...file.relativePath.split('/')
                )
                await fileSystem.mkdir(resolve(target, '..'), { recursive: true })
                await writeAtomically(fileSystem, target, file.contents)
            }
            for (const document of current) {
                if (baselinePaths.has(document.relativePath)) continue
                await fileSystem.rm(join(
                    workspace.directory,
                    ...document.relativePath.split('/')
                ), { force: true })
            }
            await rebuildIndex(characterId, chatId)
            
            bardChatUndoSnapshot = null
            pendingBardChatUndo = null
            return { restored: true }
            })
        },
        async recoverRebootBatch(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
            eventSourceGroups: string[][]
        }): Promise<CanonicalTurnReceipt | null> {
            return writeTransaction(input, 'rebuild', async () => {
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'Source message ID')
            )
            if (sourceMessageIds.length < 1 || sourceMessageIds.length > 12
                || input.eventSourceGroups.length < 1
                || input.eventSourceGroups.length > 2) {
                throw new Error('Invalid reboot recovery sources')
            }
            const eventSourceGroups = input.eventSourceGroups.map((group) => {
                const normalized = group.map((id) =>
                    required(id, 'Event source message ID')
                )
                if (normalized.length < 1 || normalized.length > 2) {
                    throw new Error('Invalid reboot event source group')
                }
                return normalized
            })
            const workspace = workspaceFor(input.characterId, input.chatId)
            const recoveryDirectory = recoveryPaths(workspace).published
            const manifestFile = join(recoveryDirectory, 'manifest.json')
            let manifest: RebootRecoveryManifest
            try {
                manifest = parseRebootRecoveryManifest(JSON.parse(
                    await fileSystem.readFile(
                    manifestFile,
                    'utf8'
                )))
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT'
                    && await cleanupUnpublishedRecovery(workspace)) return null
                throw error
            }
            const sourceMatches = matchesRebootSourceMessageIds(
                manifest.sourceMessageIds,
                sourceMessageIds
            )
            const eventGroupsMatch = JSON.stringify(manifest.eventSourceGroups)
                === JSON.stringify(eventSourceGroups)
            if (manifest.receipt
                && isLegacyFirstMessageCheckpoint(manifest.sourceMessageIds)
                && (!sourceMatches || !eventGroupsMatch)) {
                await fileSystem.rm(recoveryDirectory, {
                    recursive: true,
                    force: true,
                })
                return null
            }
            if (manifest.version !== 1
                || !sourceMatches
                || !eventGroupsMatch
                || !Array.isArray(manifest.documents)) {
                throw new Error('Wiki reboot recovery checkpoint is invalid')
            }
            if (manifest.receipt) {
                return parseCanonicalTurnReceipt(manifest.receipt)
            }
            const current = await loadDocuments(
                input.characterId,
                input.chatId
            )
            const baselineCanonical = new Map(manifest.documents.map(
                (document) => [document.id, document]
            ))
            const exactEventSources = new Set(eventSourceGroups.map((group) =>
                JSON.stringify(group)
            ))
            for (const document of current) {
                const removeEvent = document.type === 'event'
                    && exactEventSources.has(JSON.stringify(
                        document.sourceMessageIds
                    ))
                const removeCreatedCanonical = document.type !== 'event'
                    && !baselineCanonical.has(document.id)
                const baseline = baselineCanonical.get(document.id)
                const removeMovedCanonical = Boolean(baseline
                    && baseline.relativePath !== document.relativePath)
                if (removeEvent || removeCreatedCanonical
                    || removeMovedCanonical) {
                    await fileSystem.rm(join(
                        workspace.directory,
                        ...document.relativePath.split('/')
                    ), { force: true })
                }
            }
            for (const document of baselineCanonical.values()) {
                const source = join(
                    recoveryDirectory,
                    ...document.relativePath.split('/')
                )
                const target = join(
                    workspace.directory,
                    ...document.relativePath.split('/')
                )
                await fileSystem.mkdir(resolve(target, '..'), {
                    recursive: true,
                })
                await writeAtomically(
                    fileSystem,
                    target,
                    await fileSystem.readFile(source, 'utf8')
                )
            }
            await rebuildIndex(input.characterId, input.chatId)
            await fileSystem.rm(recoveryDirectory, {
                recursive: true,
                force: true,
            })
            
            return null
            })
        },
        async beginRebootBatch(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
            eventSourceGroups: string[][]
        }): Promise<{ canonicalCount: number }> {
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'Source message ID')
            )
            const eventSourceGroups = input.eventSourceGroups.map((group) =>
                group.map((id) => required(id, 'Event source message ID'))
            )
            if (sourceMessageIds.length < 1 || sourceMessageIds.length > 12
                || eventSourceGroups.length < 1
                || eventSourceGroups.length > 2
                || eventSourceGroups.some((group) =>
                    group.length < 1 || group.length > 2)) {
                throw new Error('Invalid reboot recovery sources')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(input.characterId, input.chatId)
            const canonical = documents.filter((document) =>
                document.type !== 'event'
            )
            const {
                published: recoveryDirectory,
                creating: creatingDirectory,
            } = recoveryPaths(workspace)
            const manifestFile = join(recoveryDirectory, 'manifest.json')
            try {
                const existing = parseRebootRecoveryManifest(JSON.parse(
                    await fileSystem.readFile(manifestFile, 'utf8')
                ))
                try {
                    await Promise.all(existing.documents.map((document) =>
                        fileSystem.readFile(join(
                            recoveryDirectory,
                            ...document.relativePath.split('/')
                        ))
                    ))
                }
                catch (error) {
                    throw new Error(
                        'Wiki reboot recovery conflict: existing checkpoint is invalid',
                        { cause: error }
                    )
                }
                if (existing.receipt) {
                    throw new Error(
                        'Wiki reboot recovery conflict: completed batch awaits cleanup'
                    )
                }
                throw new Error(
                    'Wiki reboot recovery conflict: checkpoint already in flight'
                )
            }
            catch (error) {
                if (error instanceof Error
                    && error.message.startsWith(
                        'Wiki reboot recovery conflict:'
                    )) throw error
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw new Error(
                        'Wiki reboot recovery conflict: existing checkpoint is invalid',
                        { cause: error }
                    )
                }
                if (!await cleanupUnpublishedRecovery(workspace)) {
                    throw new Error(
                        'Wiki reboot recovery conflict: checkpoint manifest is missing'
                    )
                }
            }
            await fileSystem.mkdir(creatingDirectory, { recursive: true })
            try {
                for (const document of canonical) {
                    const target = join(
                        creatingDirectory,
                        ...document.relativePath.split('/')
                    )
                    await fileSystem.mkdir(resolve(target, '..'), {
                        recursive: true,
                    })
                    await writeAtomically(
                        fileSystem,
                        target,
                        await fileSystem.readFile(join(
                            workspace.directory,
                            ...document.relativePath.split('/')
                        ), 'utf8')
                    )
                }
                await writeAtomically(
                    fileSystem,
                    join(creatingDirectory, 'manifest.json'),
                    `${JSON.stringify({
                        version: 1,
                        created: now().toISOString(),
                        sourceMessageIds,
                        eventSourceGroups,
                        documents: canonical.map((document) => ({
                            id: document.id,
                            type: document.type,
                            relativePath: document.relativePath,
                        })),
                    }, null, 2)}\n`
                )
                await fileSystem.rename(creatingDirectory, recoveryDirectory)
            }
            catch (error) {
                await removeRecoveryArtifact(creatingDirectory)
                    .catch(() => undefined)
                throw error
            }
            return { canonicalCount: canonical.length }
        },

        async recordRebootBatchReceipt(input: {
            characterId: string
            chatId: string
            receipt: CanonicalTurnReceipt
        }): Promise<CanonicalTurnReceipt> {
            const receipt = parseCanonicalTurnReceipt(input.receipt)
            const workspace = workspaceFor(input.characterId, input.chatId)
            const manifestFile = join(
                workspace.recoveryDirectory,
                'reboot-batch',
                'manifest.json'
            )
            const manifest = parseRebootRecoveryManifest(JSON.parse(
                await fileSystem.readFile(manifestFile, 'utf8')
            ))
            if (manifest.version !== 1
                || JSON.stringify(manifest.sourceMessageIds)
                    !== JSON.stringify(receipt.sourceMessageIds)
                || !Array.isArray(manifest.documents)
                || !Array.isArray(manifest.eventSourceGroups)) {
                throw new Error('Wiki reboot recovery checkpoint is invalid')
            }
            manifest.receipt = receipt
            await writeAtomically(
                fileSystem,
                manifestFile,
                `${JSON.stringify(manifest, null, 2)}\n`
            )
            return receipt
        },

        async completeRebootBatch(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
        }): Promise<{ removed: boolean }> {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const recoveryDirectory = join(
                workspace.recoveryDirectory,
                'reboot-batch'
            )
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'Source message ID')
            )
            let manifest: RebootRecoveryManifest
            try {
                manifest = parseRebootRecoveryManifest(JSON.parse(
                    await fileSystem.readFile(
                    join(recoveryDirectory, 'manifest.json'),
                    'utf8'
                )))
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return { removed: false }
                }
                throw error
            }
            if (manifest.version !== 1
                || !matchesRebootSourceMessageIds(
                    manifest.sourceMessageIds,
                    sourceMessageIds
                )) {
                throw new Error('Wiki reboot recovery checkpoint does not match')
            }
            await fileSystem.rm(recoveryDirectory, {
                recursive: true,
                force: true,
            })
            return { removed: true }
        },

        async resolveDocumentFile(input: {
            characterId: string
            chatId: string
            documentId: string
        }): Promise<string> {
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === input.documentId)
            if (!document) throw new Error('Wiki document does not exist')
            const workspace = workspaceFor(input.characterId, input.chatId)
            return join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
        },

        async saveConfirmedTurn(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
            markdown: string
            append?: boolean
            writingLanguage?: WikiWritingLanguage
            retrievalMetadata?: MemoryRetrievalMetadata
            /** Chat boundary this evidence belongs to; resolved by the caller. */
            chatAnchor?: WikiChatAnchor
            operationId?: string
        }): Promise<MarkdownWikiDocument> {
            return writeTransaction(input, 'analysis', async () => {
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'sourceMessageId')
            )
            if (sourceMessageIds.length === 0) {
                throw new Error('Markdown memory requires at least one source')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            await fileSystem.mkdir(workspace.eventsDirectory, {
                recursive: true,
            })
            const knownDocuments = await loadDocuments(
                input.characterId,
                input.chatId
            )
            let normalized = normalizeMarkdown(input.markdown)
            const suffix = stableId(sourceMessageIds)
            const file = `turn-${suffix}.md`
            const operationTime = now().toISOString()
            const existingEvent = knownDocuments
                .find((document) => document.id === `event.${suffix}`)
            const retrievalMetadata = input.retrievalMetadata === undefined
                ? existingEvent?.retrievalMetadata
                : normalizeMemoryRetrievalMetadata(input.retrievalMetadata)
            const previousLanguage = existingEvent ? detectWikiWritingLanguage(existingEvent.content) : undefined
            const writingLanguage = normalizeWikiWritingLanguage(input.writingLanguage
                ?? previousLanguage ?? detectWikiWritingLanguage(normalized.content))
            normalized = normalizeMarkdown(localizeWikiHeadings(normalized.content, writingLanguage))
            if (input.append && existingEvent?.type === 'event') {
                if (previousLanguage && writingLanguage !== previousLanguage) {
                    throw new Error('Wiki writing language differs from the existing event; reboot the wiki to change its language.')
                }
                const addition = normalized.content.replace(
                    /^##\s+[^\r\n]+\r?\n*/,
                    ''
                ).trim()
                normalized = normalizeMarkdown([
                    existingEvent.content,
                    `### ${wikiWritingHeadings[writingLanguage].additional}`,
                    addition,
                ].filter(Boolean).join('\n\n'))
            }
            normalized = normalizeMarkdown(appendKnownDocumentLinks(
                normalized.content,
                knownDocuments,
                `event.${suffix}`,
                writingLanguage
            ))
            const prepared = prepareDocument({
                id: `event.${suffix}`,
                type: 'event',
                status: 'active',
                title: normalized.title,
                aliases: existingEvent?.aliases ?? [],
                relativePath: `events/${file}`,
                sourceMessageIds,
                updated: operationTime,
                content: normalized.content,
                links: linksFrom(normalized.content),
                created: existingEvent?.created ?? operationTime,
                authoring: 'automatic',
                contextMode: 'auto',
                retrievalMetadata,
            })
            await writeAtomically(
                fileSystem,
                join(workspace.eventsDirectory, file),
                prepared.contents
            )
            await rebuildIndex(input.characterId, input.chatId, writingLanguage)
            
            return prepared.document
            })
        },

        async saveCanonicalDocument(input: {
            characterId: string
            chatId: string
            documentId?: string
            type: CanonicalMarkdownWikiDocumentType
            title: string
            aliases?: string[]
            sourceMessageIds: string[]
            markdown: string
            expectedContentHash?: string
            reviewStatus?: 'unreviewed' | 'reviewed'
            writingLanguage?: WikiWritingLanguage
            retrievalMetadata?: MemoryRetrievalMetadata
            /** Chat boundary this evidence belongs to; resolved by the caller. */
            chatAnchor?: WikiChatAnchor
            operationId?: string
        }): Promise<MarkdownWikiDocument> {
            return writeTransaction(input, input.reviewStatus === 'unreviewed' ? 'review' : 'analysis', async () => {
            const title = required(input.title, 'Title').trim().slice(0, 160)
            const incomingSources = input.sourceMessageIds.map((id) =>
                required(id, 'sourceMessageId')
            )
            if (incomingSources.length === 0) {
                throw new Error('Canonical wiki document requires at least one source')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(
                input.characterId,
                input.chatId
            )
            const existing = input.documentId
                ? documents.find((document) =>
                    document.id === input.documentId)
                : undefined
            if (input.documentId && !existing) {
                throw new Error('Canonical wiki document does not exist')
            }
            if (existing && existing.type !== input.type) {
                throw new Error('Canonical wiki document type cannot change')
            }
            if (existing && input.expectedContentHash
                && existing.contentHash !== input.expectedContentHash) {
                throw new Error(
                    'Wiki document changed since the draft was created'
                )
            }
            const retrievalMetadata = input.retrievalMetadata === undefined
                ? existing?.retrievalMetadata
                : normalizeMemoryRetrievalMetadata(input.retrievalMetadata)
            const suffix = existing?.id.split('.').at(-1)
                ?? stableId([input.type, title.normalize('NFKC').toLocaleLowerCase()])
            const id = existing?.id ?? `${input.type}.${suffix}`
            const folder: Record<CanonicalMarkdownWikiDocumentType, string> = {
                character: 'characters',
                location: 'locations',
                scene: '',
                faction: 'factions',
                creature: 'creatures',
                item: 'items',
                concept: 'concepts',
                other: 'notes',
            }
            const relativePath = existing?.relativePath
                ?? (input.type === 'scene'
                    ? 'current-scene.md'
                    : `${folder[input.type]}/${readableStem(title)}-${suffix}.md`)
            const file = input.type === 'scene'
                ? workspace.sceneFile
                : join(workspace.directory, ...relativePath.split('/'))
            const operationTime = now().toISOString()
            await fileSystem.mkdir(resolve(file, '..'), { recursive: true })
            const reviewFile = join(
                workspace.reviewDirectory,
                `${stableId([id])}.md`
            )
            if (input.reviewStatus === 'unreviewed'
                && existing?.reviewStatus !== 'unreviewed') {
                await fileSystem.mkdir(workspace.reviewDirectory, {
                    recursive: true,
                })
                await writeAtomically(
                    fileSystem,
                    reviewFile,
                    existing ? await fileSystem.readFile(file, 'utf8') : ''
                )
            }
            let normalized = normalizeMarkdown(input.markdown)
            const writingLanguage = normalizeWikiWritingLanguage(input.writingLanguage
                ?? detectWikiWritingLanguage(normalized.content))
            normalized = normalizeMarkdown(localizeWikiHeadings(normalized.content, writingLanguage))
            if (input.type === 'character') {
                normalized = normalizeMarkdown(
                    removeCharacterEventLinksFromRelatedDocuments(
                        normalized.content,
                        documents
                    )
                )
            }
            normalized = normalizeMarkdown(appendKnownDocumentLinks(
                normalized.content,
                input.type === 'character'
                    ? documents.filter((document) => document.type !== 'event')
                    : documents,
                id,
                writingLanguage
            ))
            const prepared = prepareDocument({
                id,
                type: input.type,
                status: 'active',
                title: normalized.title,
                aliases: aliasesForSave({
                    aliases: input.aliases,
                    title: normalized.title,
                    existing,
                    documents,
                }),
                relativePath,
                sourceMessageIds: [...new Set([
                    ...(existing?.sourceMessageIds ?? []),
                    ...incomingSources,
                ])].slice(-96),
                updated: operationTime,
                content: normalized.content,
                links: linksFrom(normalized.content),
                created: existing?.created ?? operationTime,
                authoring: 'ai-assisted',
                reviewStatus: input.reviewStatus ?? 'reviewed',
                contextMode: input.type === 'scene'
                    ? 'always'
                    : existing?.contextMode ?? 'auto',
                retrievalMetadata,
            })
            await writeAtomically(fileSystem, file, prepared.contents)
            await rebuildIndex(input.characterId, input.chatId, writingLanguage)
            
            return prepared.document
            })
        },

        async reviewCanonicalDocument(input: {
            characterId: string
            chatId: string
            documentId: string
            action: 'accept' | 'revert'
            expectedContentHash: string
        }): Promise<MarkdownWikiDocument | {
            id: string
            reverted: true
            deleted: true
        }> {
            return writeTransaction(input, 'review', async () => {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === required(
                input.documentId,
                'Document ID'
            ))
            if (!document || document.type === 'event'
                || document.status !== 'active') {
                throw new Error('Canonical wiki document does not exist')
            }
            if (document.reviewStatus !== 'unreviewed') {
                throw new Error('Canonical wiki document is not awaiting review')
            }
            if (document.contentHash !== input.expectedContentHash) {
                throw new Error('Wiki document changed since review opened')
            }
            const file = join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
            const reviewFile = join(
                workspace.reviewDirectory,
                `${stableId([document.id])}.md`
            )
            if (input.action === 'revert') {
                const baseline = await fileSystem.readFile(reviewFile, 'utf8')
                if (baseline.length === 0) {
                    const trash = join(
                        workspace.trashDirectory,
                        document.id
                    )
                    await fileSystem.mkdir(trash, { recursive: true })
                    await writeAtomically(
                        fileSystem,
                        join(trash, `${now().toISOString().replace(/[:.]/g, '-')}-${basename(file)}`),
                        await fileSystem.readFile(file, 'utf8')
                    )
                    await fileSystem.rm(file)
                    await fileSystem.rm(reviewFile, { force: true })
                    await rebuildIndex(input.characterId, input.chatId)
                    
                    return {
                        id: document.id,
                        reverted: true as const,
                        deleted: true as const,
                    }
                }
                await writeAtomically(fileSystem, file, baseline)
            }
            else {
                const { contentHash: _contentHash, reviewBaseContent: _base,
                    ...stored } = document
                const accepted = prepareDocument({
                    ...stored,
                    reviewStatus: 'reviewed',
                    updated: now().toISOString(),
                })
                await writeAtomically(fileSystem, file, accepted.contents)
            }
            await fileSystem.rm(reviewFile, { force: true })
            await rebuildIndex(input.characterId, input.chatId)
            
            const reviewed = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === document.id)
            if (!reviewed) throw new Error('Reviewed wiki document disappeared')
            return reviewed.reviewStatus
                ? reviewed
                : { ...reviewed, reviewStatus: 'reviewed' }
            })
        },

        async saveManualDocument(input: {
            characterId: string
            chatId: string
            documentId?: string
            type: MarkdownWikiDocumentType
            title: string
            aliases?: string[]
            markdown: string
            expectedContentHash?: string
            retrievalMetadata?: MemoryRetrievalMetadata
            chatAnchor?: WikiChatAnchor
        }): Promise<MarkdownWikiDocument> {
            return writeTransaction(input, 'manual', async () => {
            const title = required(input.title, 'Title').trim().slice(0, 160)
            const allowed: MarkdownWikiDocumentType[] = [
                'character', 'location', 'scene', 'faction', 'creature',
                'item', 'concept', 'other', 'event',
            ]
            if (!allowed.includes(input.type)) {
                throw new Error('Invalid manual wiki document type')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(input.characterId, input.chatId)
            const existing = input.documentId
                ? documents.find((document) => document.id === input.documentId)
                : undefined
            if (input.documentId && !existing) {
                throw new Error('Canonical wiki document does not exist')
            }
            if (input.type === 'event' && existing?.type !== 'event') {
                throw new Error('Manual event creation is not allowed')
            }
            if (existing?.type === 'event' && input.type !== 'event') {
                throw new Error('Event documents must keep their type')
            }
            if (existing && input.expectedContentHash
                && existing.contentHash !== input.expectedContentHash) {
                throw new Error(
                    'Wiki document changed since the draft was created'
                )
            }
            const retrievalMetadata = input.retrievalMetadata === undefined
                ? existing?.retrievalMetadata
                : normalizeMemoryRetrievalMetadata(input.retrievalMetadata)
            const operationTime = now().toISOString()
            const suffix = existing?.id.split('.').at(-1)
                ?? stableId([input.type, title, randomUUID()])
            const id = existing?.id ?? `${input.type}.${suffix}`
            const folder: Record<CanonicalMarkdownWikiDocumentType, string> = {
                character: 'characters',
                location: 'locations',
                scene: '',
                faction: 'factions',
                creature: 'creatures',
                item: 'items',
                concept: 'concepts',
                other: 'notes',
            }
            const relativePath = input.type === 'event'
                ? existing!.relativePath
                : input.type === 'scene'
                ? 'current-scene.md'
                : `${folder[input.type]}/${readableStem(title)}-${suffix}.md`
            const file = join(workspace.directory, ...relativePath.split('/'))
            const oldFile = existing
                ? join(workspace.directory, ...existing.relativePath.split('/'))
                : undefined
            if (documents.some((item) =>
                item.relativePath === relativePath && item.id !== existing?.id
            )) {
                throw new Error('A wiki document already owns that path')
            }
            await fileSystem.mkdir(resolve(file, '..'), { recursive: true })
            const normalized = normalizeMarkdown(input.markdown)
            const content = normalized.content.replace(
                /^##\s+.+$/m,
                `## ${title}`
            )
            const prepared = prepareDocument({
                id,
                type: input.type,
                status: 'active',
                title,
                aliases: aliasesForSave({
                    aliases: input.aliases,
                    title,
                    existing,
                    documents,
                }),
                relativePath,
                sourceMessageIds: existing?.sourceMessageIds ?? [],
                created: existing?.created ?? operationTime,
                updated: operationTime,
                authoring: 'manual',
                content,
                links: linksFrom(content),
                contextMode: input.type === 'event'
                    ? 'auto'
                    : input.type === 'scene'
                    ? 'always'
                    : existing?.contextMode ?? 'auto',
                retrievalMetadata,
            })
            await writeAtomically(fileSystem, file, prepared.contents)
            if (oldFile && oldFile !== file) {
                await fileSystem.rm(oldFile)
            }
            if (existing && existing.title !== title) {
                for (const linked of documents) {
                    if (linked.id === existing.id || linked.type === 'event') continue
                    const escaped = existing.title.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        '\\$&'
                    )
                    const changed = linked.content.replace(
                        new RegExp(`\\[\\[${escaped}(?=\\]|\\|)`, 'g'),
                        `[[${title}`
                    )
                    if (changed === linked.content) continue
                    const linkedFile = join(
                        workspace.directory,
                        ...linked.relativePath.split('/')
                    )
                    const updatedLinked = {
                        ...linked,
                        content: changed,
                        links: linksFrom(changed),
                        updated: operationTime,
                    }
                    await writeAtomically(
                        fileSystem,
                        linkedFile,
                        serializeDocument(updatedLinked)
                    )
                }
            }
            await rebuildIndex(input.characterId, input.chatId)
            
            return prepared.document
            })
        },

        async setDocumentContextMode(input: {
            characterId: string
            chatId: string
            documentId: string
            contextMode: MarkdownWikiContextMode
            expectedContentHash?: string
        }): Promise<MarkdownWikiDocument> {
            return writeTransaction(input, 'policy', async () => {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === required(
                input.documentId,
                'Document ID'
            ))
            if (!document) {
                throw new Error('Canonical wiki document does not exist')
            }
            if (document.type === 'event' || document.type === 'scene') {
                throw new Error('This document has a fixed context mode')
            }
            if (!['always', 'auto', 'never'].includes(input.contextMode)) {
                throw new Error('Invalid wiki context mode')
            }
            if (input.expectedContentHash
                && document.contentHash !== input.expectedContentHash) {
                throw new Error(
                    'Wiki document changed since the draft was created'
                )
            }
            const file = join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
            const operationTime = now().toISOString()
            const { contentHash: _contentHash, ...stored } = document
            const prepared = prepareDocument({
                ...stored,
                contextMode: input.contextMode,
                updated: operationTime,
            })
            await writeAtomically(fileSystem, file, prepared.contents)
            await rebuildIndex(input.characterId, input.chatId)
            
            return prepared.document
            })
        },

        async trashDocument(input: {
            characterId: string
            chatId: string
            documentId: string
        }): Promise<{ id: string; trashed: true }> {
            return writeTransaction(input, 'manual', async () => {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(input.characterId, input.chatId))
                .find((item) => item.id === required(input.documentId, 'Document ID'))
            if (!document) throw new Error('Canonical wiki document does not exist')
            if (document.type === 'event') {
                throw new Error('Event documents are read-only')
            }
            const file = join(workspace.directory, ...document.relativePath.split('/'))
            const trash = join(workspace.trashDirectory, document.id)
            await fileSystem.mkdir(trash, { recursive: true })
            const stamp = now().toISOString().replace(/[:.]/g, '-')
            await writeAtomically(
                fileSystem,
                join(trash, `${stamp}-${basename(file)}`),
                await fileSystem.readFile(file, 'utf8')
            )
            await fileSystem.rm(file)
            await rebuildIndex(input.characterId, input.chatId)
            
            return { id: document.id, trashed: true as const }
            })
        },

        async retractEvent(input: {
            characterId: string
            chatId: string
            documentId: string
            expectedContentHash: string
        }): Promise<MarkdownWikiDocument> {
            return writeTransaction(input, 'manual', async () => {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === required(
                input.documentId,
                'Document ID'
            ))
            if (!document || document.type !== 'event') {
                throw new Error('Event document does not exist')
            }
            if (document.status !== 'active') {
                throw new Error('Only an active event can be retracted')
            }
            if (document.contentHash !== required(
                input.expectedContentHash,
                'Content hash'
            )) {
                throw new Error('Wiki event changed since it was opened')
            }
            const file = join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
            const { contentHash: _contentHash, ...stored } = document
            const prepared = prepareDocument({
                ...stored,
                status: 'retracted',
                updated: now().toISOString(),
            })
            await fileSystem.rm(file, { force: true })
            try {
                await rebuildIndex(input.characterId, input.chatId)
            } catch {
                documentCache.delete(workspace.directory)
            }
            
            return prepared.document
            })
        },

        async retractEventsBySourceMessages(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
        }): Promise<{ retractedIds: string[] }> {
            return writeTransaction(input, 'manual', async () => {
            const sources = new Set(input.sourceMessageIds.map((id) =>
                required(id, 'Source message ID')
            ))
            if (sources.size === 0) {
                throw new Error('Event retraction requires at least one source message')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const matches = (await loadDocuments(
                input.characterId,
                input.chatId
            )).filter((document) =>
                document.type === 'event'
                && document.status === 'active'
                && document.sourceMessageIds.some((id) => sources.has(id))
            )
            for (const document of matches) {
                await fileSystem.rm(
                    join(
                        workspace.directory,
                        ...document.relativePath.split('/')
                    ),
                    { force: true }
                )
            }
            if (matches.length > 0) {
                await rebuildIndex(input.characterId, input.chatId)
                
            }
            return { retractedIds: matches.map((document) => document.id) }
            })
        },

        async detachInheritedSources(characterId: string, chatId: string, sourceChatId: string): Promise<void> {
            return writeTransaction({ characterId, chatId }, 'import', async () => {
            const workspace = workspaceFor(characterId, chatId)
            const documents = await loadDocuments(characterId, chatId)
            const origin = stableId([sourceChatId])
            for (const document of documents) {
                if (document.sourceMessageIds.length === 0) continue
                const prepared = prepareDocument({
                    ...document,
                    sourceMessageIds: document.sourceMessageIds.map(id =>
                        id.startsWith('inherited:') ? id : `inherited:${origin}:${id}`),
                })
                await writeAtomically(fileSystem, join(workspace.directory, ...document.relativePath.split('/')), prepared.contents)
            }
            await rebuildIndex(characterId, chatId)
            
            })
        },

        async loadView(
            characterId: string,
            chatId: string
        ): Promise<MarkdownWikiView> {
            const workspace = workspaceFor(characterId, chatId)
            const documents = await refreshDocuments(characterId, chatId)
            const withReviewBases = await Promise.all(documents.map(
                async (document) => {
                    if (document.reviewStatus !== 'unreviewed') return document
                    try {
                        const baseline = await fileSystem.readFile(join(
                            workspace.reviewDirectory,
                            `${stableId([document.id])}.md`
                        ), 'utf8')
                        return {
                            ...document,
                            reviewBaseContent: baseline.length > 0
                                ? parseDocument(
                                    baseline,
                                    document.relativePath
                                ).content
                                : '',
                        }
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                            return document
                        }
                        throw error
                    }
                }
            ))
            return {
                mode: 'markdown' as const,
                wikiPath: workspaceFor(characterId, chatId).directory,
                documents: withReviewBases,
                health: computeHealth(documents),
            }
        },

        async replaceAllText(input: {
            characterId: string
            chatId: string
            find: string
            replacement: string
        }): Promise<{ matches: number; documents: number }> {
            return writeTransaction(input, 'manual', async () => {
            if (typeof input.find !== 'string'
                || input.find.length === 0
                || input.find.length > 256) {
                throw new Error('Find text must contain 1-256 characters')
            }
            const find = input.find
            if (typeof input.replacement !== 'string'
                || input.replacement.length > 256) {
                throw new Error('Replacement text is too long')
            }
            if (find === input.replacement) {
                return { matches: 0, documents: 0 }
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(
                input.characterId,
                input.chatId
            )
            const operationTime = now().toISOString()
            const staged = documents.flatMap((document) => {
                const contentMatches = document.content.split(find).length - 1
                if (contentMatches === 0) return []
                const { contentHash: _contentHash, ...stored } = document
                const content = stored.content.replaceAll(
                    find,
                    input.replacement
                )
                const prepared = prepareDocument({
                    ...stored,
                    title: stored.title.replaceAll(find, input.replacement),
                    content,
                    links: linksFrom(content),
                    updated: operationTime,
                })
                return [{
                    document,
                    matches: contentMatches,
                    file: join(
                        workspace.directory,
                        ...document.relativePath.split('/')
                    ),
                    prepared,
                }]
            })
            if (staged.length === 0) {
                return { matches: 0, documents: 0 }
            }
            const originals = await Promise.all(staged.map(async (item) => ({
                ...item,
                contents: await fileSystem.readFile(item.file, 'utf8'),
            })))
            const written: typeof originals = []
            try {
                for (const item of originals) {
                    await writeAtomically(
                        fileSystem,
                        item.file,
                        item.prepared.contents
                    )
                    written.push(item)
                }
            }
            catch (error) {
                await Promise.allSettled(written.map((item) =>
                    writeAtomically(fileSystem, item.file, item.contents)
                ))
                await refreshDocuments(input.characterId, input.chatId)
                throw error
            }
            await rebuildIndex(input.characterId, input.chatId)
            
            return {
                matches: staged.reduce(
                    (total, item) => total + item.matches,
                    0
                ),
                documents: staged.length,
            }
            })
        },

        async embeddingCatalog(input: {
            characterId: string; chatId: string; offset?: number; revision?: string
        }): Promise<WikiEmbeddingCatalog> {
            const snapshot = await loadDocuments(input.characterId, input.chatId)
            let catalog = embeddingCatalogCache.get(snapshot)
            if (!catalog) {
                const documents = snapshot
                    .filter(document => document.status === 'active'
                        && document.contextMode !== 'never' && document.type !== 'scene')
                    .sort((a, b) => a.id.localeCompare(b.id))
                const revision = createHash('sha256').update(JSON.stringify(documents.map(
                    document => [document.id, document.contentHash, document.contextMode],
                ))).digest('base64url')
                catalog = { revision, chunks: documents.flatMap(chunkWikiDocument) }
                embeddingCatalogCache.set(snapshot, catalog)
            }
            const { revision, chunks } = catalog
            if (input.revision !== undefined && input.revision !== revision) {
                throw new Error('Embedding catalog revision changed')
            }
            const offset = input.offset ?? 0
            if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && !input.revision)) {
                throw new Error('Invalid embedding catalog offset')
            }
            return { revision, chunks: chunks.slice(offset, offset + 64),
                nextOffset: offset + 64 < chunks.length ? offset + 64 : null }
        },

        async inquire(input: {
            contextSelection?: 'required' | 'auto'
            /** Server-owned committed path hashes; not accepted from HTTP clients. */
            expectedPaths?: Readonly<Record<string, string>>
            characterId: string
            chatId: string
            currentInput: string
            fallbackInput?: string
            retrievalLimits?: { candidates: number; directSeeds: number }
            entityHints?: readonly { kind: 'character'; names: readonly string[] }[]
            semanticMatches?: readonly {
                documentId: string
                score: number
                contentHash?: string
                start?: number
                end?: number
            }[]
            sourceMatches?: readonly {
                retrieval?: 'semantic'
                messageId: string
                role: 'user' | 'assistant'
                content: string
                score: number
                occurredAt: number
            }[]
            sourceLimit?: number
            tokenBudget?: {
                target: number
                events?: number
                perSource?: number
                maximum: number
            }
        }) {
            let documents = await loadDocuments(input.characterId, input.chatId)
            if (input.expectedPaths) {
                const paths = Object.keys(input.expectedPaths)
                    .filter(path => trackedWikiPath(path) && !path.startsWith('.'))
                // Markdown edit tokens encode the same SHA-256 as base64url; VCS uses hex.
                const matches = () => paths.length === documents.length && documents.every(document =>
                    input.expectedPaths![document.relativePath]
                        === Buffer.from(document.contentHash, 'base64url').toString('hex'))
                if (!matches()) {
                    documents = await refreshDocuments(input.characterId, input.chatId)
                    if (!matches()) throw new Error('Wiki inquiry conflict: the working documents changed')
                }
            }
            return inquireMarkdownDocuments({
                contextSelection: input.contextSelection,
                documents,
                currentInput: input.currentInput,
                ...(input.retrievalLimits ? { retrievalLimits: input.retrievalLimits } : {}),
                ...(input.entityHints ? { entityHints: input.entityHints } : {}),
                ...(input.fallbackInput
                    ? { fallbackInput: input.fallbackInput }
                    : {}),
                ...(input.semanticMatches
                    ? { semanticMatches: input.semanticMatches }
                    : {}),
                ...(input.sourceMatches
                    ? { sourceMatches: input.sourceMatches }
                    : {}),
                ...(input.sourceLimit === undefined
                    ? {}
                    : { sourceLimit: input.sourceLimit }),
                ...(input.tokenBudget
                    ? { tokenBudget: input.tokenBudget }
                    : {}),
            })
        },
    }
    return service
}
