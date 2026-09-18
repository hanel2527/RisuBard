// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createUserDataRepository } = require('../../../server/node/user-data-repository.cjs')
const { createCanonicalProjectionSync } = require('../../../server/node/canonical-projection-sync.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

test('server restart does not classify its own sidebar reconciliation as an external edit', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-restart-contract-'))
    roots.push(dataRoot)
    const repository = createUserDataRepository({ dataRoot })
    const database = {
        customCSS: 'body { color: red; }',
        botPresets: [{ id: 'preset-1', name: 'test' }], modules: [], personas: [], loreBook: [],
        characters: [{ chaId: 'char-1', name: 'Character without modification_date', chats: [
            { id: 'chat-1', name: 'Chat', message: [{ role: 'user', data: 'preserve me' }] },
        ] }],
    }
    repository.importLegacyDatabase(database, { mode: 'sync' })
    // Re-saving an unchanged character still updates the sidebar save time,
    // while its metadata file keeps its older mtime (unchanged-file fast path).
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const before = repository.loadSidebarIndex()
    let accepted = repository.getProjectionRevision()
    for (let restart = 0; restart < 2; restart++) {
        const reopened = createUserDataRepository({ dataRoot })
        const sync = createCanonicalProjectionSync({
            repository: reopened,
            readAcceptedRevision: () => accepted,
            writeAcceptedRevision: (revision: string) => { accepted = revision },
        })
        expect(sync.hasExternalChanges()).toBe(false)
        expect(reopened.loadSidebarIndex()).toEqual(before)
        expect(reopened.exportLegacyDatabase()).toEqual(database)
    }
})
