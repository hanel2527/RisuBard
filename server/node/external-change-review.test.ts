import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createExternalChangeReview, diffLore } = require('./external-change-review.cjs')

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-external-review-'))
    const repository = createUserDataRepository({ dataRoot: root })
    const db = {
        characters: [{
            chaId: 'one', name: 'One', type: 'character', desc: 'old line\nsecond',
            globalLore: [
                { id: 'a', comment: 'Alpha', key: 'alpha', content: 'alpha body', mode: 'normal' },
                { id: 'b', comment: 'Beta', key: 'beta', content: 'beta body', mode: 'normal' },
            ],
            chats: [{ id: 'chat-1', name: 'Chat 1', message: [], localLore: [] }],
        }, {
            chaId: 'two', name: 'Two', type: 'character', desc: 'untouched', globalLore: [], chats: [],
        }],
        loreBook: [{ id: 'book', name: 'Book', data: [{ id: 'x', comment: 'X', content: 'x body' }] }],
    }
    repository.importLegacyDatabase(db, { mode: 'sync' })
    const review = createExternalChangeReview({ repository, dataRoot: root })
    const metadataFile = path.join(root, repository.characterDirectoryPath('one'), 'metadata.json')
    const bookFile = path.join(root, repository.collectionItemPath('lorebooks', repository.loadSidebarIndex().collections.loreBook[0]))
    const app = JSON.parse(JSON.stringify(db))
    return { root, repository, review, db: app, metadataFile, bookFile }
}

test('unedited files produce no differences', () => {
    const { root, review, db } = setup()
    try {
        const result = review.inspect('r1', db)
        expect(result.changes).toEqual([])
        expect(result.errors).toEqual([])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an edited character reports changed fields and lore without blessing the checksum', () => {
    const { root, review, db, metadataFile } = setup()
    try {
        const original = fs.readFileSync(`${metadataFile}.sha256`, 'utf8')
        const edited = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
        edited.desc = 'new line\nsecond'
        edited.globalLore = [
            { ...edited.globalLore[0], content: 'alpha changed' },
            { id: 'c', comment: 'Gamma', key: 'gamma', content: 'gamma body', mode: 'normal' },
        ]
        fs.writeFileSync(metadataFile, JSON.stringify(edited, null, 2))

        const result = review.inspect('r2', db)
        expect(result.changes).toHaveLength(1)
        const change = result.changes[0]
        expect(change).toMatchObject({ kind: 'character', id: 'one', name: 'One' })
        expect(change.fields.map((field: any) => field.field)).toEqual(['desc'])
        expect(change.fields[0]).toMatchObject({ before: 'old line\nsecond', after: 'new line\nsecond' })
        expect(change.lore.changed.map((entry: any) => entry.name)).toEqual(['Alpha'])
        expect(change.lore.added.map((entry: any) => entry.name)).toEqual(['Gamma'])
        expect(change.lore.removed.map((entry: any) => entry.name)).toEqual(['Beta'])
        // Inspection must not accept the external bytes.
        expect(fs.readFileSync(`${metadataFile}.sha256`, 'utf8')).toBe(original)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('accepting replaces only the edited entities and keeps chats', () => {
    const { root, review, db, metadataFile, bookFile } = setup()
    try {
        const edited = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
        edited.desc = 'from editor'
        fs.writeFileSync(metadataFile, JSON.stringify(edited))
        const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'))
        book.name = 'Renamed book'
        fs.writeFileSync(bookFile, JSON.stringify(book))
        db.characters[1].desc = 'app-only edit'

        const result = review.inspect('r3', db)
        expect(result.changes.map((change: any) => change.kind)).toEqual(['character', 'lorebook'])
        const next = review.applyExternal(db, result)
        expect(next.characters[0].desc).toBe('from editor')
        expect(next.characters[0].chats).toEqual(db.characters[0].chats)
        expect(next.characters[1].desc).toBe('app-only edit')
        expect(next.loreBook[0].name).toBe('Renamed book')
        expect(db.characters[0].desc).toBe('old line\nsecond')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('invalid JSON is reported with its location and backed up when keeping the app version', () => {
    const { root, review, db, metadataFile } = setup()
    try {
        fs.writeFileSync(metadataFile, '{\n  "name": "One",\n  "desc": oops\n}')
        const result = review.inspect('r4', db)
        expect(result.changes).toEqual([])
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0].error).toMatch(/^line \d+, column \d+: /)
        const backup = review.backup(result)
        const copied = path.join(root, backup, path.relative(root, metadataFile))
        expect(fs.readFileSync(copied, 'utf8')).toContain('oops')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('inspection is cached per revision', () => {
    const { root, review, db, metadataFile } = setup()
    try {
        const edited = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
        edited.desc = 'first edit'
        fs.writeFileSync(metadataFile, JSON.stringify(edited))
        const first = review.inspect('same', db)
        edited.desc = 'second edit'
        fs.writeFileSync(metadataFile, JSON.stringify(edited))
        expect(review.inspect('same', db)).toBe(first)
        expect(review.inspect('next', db).changes[0].fields[0].after).toBe('second edit')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('lore entries without ids are matched by name and position', () => {
    const result = diffLore([{ comment: 'A', content: '1' }], [{ comment: 'A', content: '2' }])
    expect(result.changed.map((entry: any) => entry.name)).toEqual(['A'])
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
})

test('acknowledging reviewed files lets the decided version replace them', () => {
    const { root, review, db, metadataFile } = setup()
    try {
        const edited = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
        edited.desc = 'unseen edit'
        fs.writeFileSync(metadataFile, JSON.stringify(edited))
        const result = review.inspect('r5', db)
        review.acknowledge(result)
        const crypto = require('node:crypto')
        const digest = crypto.createHash('sha256').update(fs.readFileSync(metadataFile)).digest('hex')
        expect(fs.readFileSync(`${metadataFile}.sha256`, 'utf8').trim()).toBe(digest)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
