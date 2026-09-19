import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const { createFileKv } = require('./file-kv.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createCanonicalProjectionSync } = require('./canonical-projection-sync.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const { attachCompatibilityCache } = require('./compatibility-cache.cjs')
const { decodeRisuSave, normalizeJSON } = require('./utils.cjs')
const KEY = 'database/canonical-projection-revision'
const FILE = 'cache/canonical-projection-revision.json'
const roots: string[] = []
const createStore = (options: any) => require('./projection-revision-store.cjs').createProjectionRevisionStore(options)

function fixture() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-revision-'))
    roots.push(dataRoot)
    const kv = createFileKv({ dataRoot })
    const repository = createUserDataRepository({ dataRoot })
    const database = { customCSS: 'before', botPresets: [{ id: 'preset', name: 'Original' }],
        characters: [], modules: [], personas: [], loreBook: [] }
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const legacy = {
        readAcceptedRevision: () => kv.kvGet(KEY)?.toString().trim() || null,
        writeAcceptedRevision: (revision: string) => kv.kvSet(KEY, Buffer.from(`${revision}\n`)),
    }
    const oldSync = createCanonicalProjectionSync({ repository, ...legacy })
    oldSync.accept()
    const storage = () => createStore({ dataRoot, readLegacyRevision: legacy.readAcceptedRevision })
    const sync = () => createCanonicalProjectionSync({ repository, ...storage() })
    return { dataRoot, kv, repository, database, oldSync, storage, sync }
}

afterEach(() => {
    vi.restoreAllMocks()
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }))
})

describe('projection revision storage', () => {
    it('upgrades without rewriting the asset manifest and retains acceptance across restart', () => {
        const f = fixture()
        const manifest = fs.readFileSync(path.join(f.dataRoot, 'kv/manifest.json'))
        expect(f.sync().hasExternalChanges()).toBe(false)
        f.database.customCSS = 'after'
        f.repository.syncLegacyPresetState(f.database)
        f.sync().accept()
        expect(fs.readFileSync(path.join(f.dataRoot, 'kv/manifest.json'))).toEqual(manifest)
        expect(f.sync().hasExternalChanges()).toBe(false)
        expect(fs.existsSync(path.join(f.dataRoot, `${FILE}.sha256`))).toBe(true)
        const source = `
            const dataRoot=process.env.RISUBARD_DATA_ROOT;
            const repository=require('./server/node/user-data-repository.cjs').createUserDataRepository({dataRoot});
            const storage=require('./server/node/projection-revision-store.cjs').createProjectionRevisionStore({dataRoot});
            const sync=require('./server/node/canonical-projection-sync.cjs').createCanonicalProjectionSync({repository,...storage});
            process.stdout.write(JSON.stringify({changed:sync.hasExternalChanges(),css:repository.exportLegacyDatabase().customCSS}));
        `
        expect(JSON.parse(execFileSync(process.execPath, ['-e', source], {
            cwd: process.cwd(), env: { ...process.env, RISUBARD_DATA_ROOT: f.dataRoot }, encoding: 'utf8',
        }))).toEqual({ changed: false, css: 'after' })
    })

    it('lets an old reader adopt new writes, then detects old-version and external edits on re-upgrade', () => {
        const f = fixture()
        f.database.botPresets[0].name = 'New version'
        f.repository.syncLegacyPresetState(f.database)
        f.sync().accept()
        const adopted = f.oldSync.loadExternalChanges()
        expect(adopted.database.botPresets[0].name).toBe('New version')
        f.oldSync.accept(adopted.revision)
        f.database.customCSS = 'Edited by old version'
        f.repository.syncLegacyPresetState(f.database)
        f.oldSync.accept()
        expect(f.sync().hasExternalChanges()).toBe(true)
        const upgraded = f.sync().loadExternalChanges()
        expect(upgraded.database.customCSS).toBe('Edited by old version')
        f.sync().accept(upgraded.revision)
        const preset = f.repository.exportLegacyDatabase().botPresets[0]
        atomicWriteJson(f.dataRoot, 'presets/preset.json', { ...preset, name: 'External edit' })
        expect(f.sync().hasExternalChanges()).toBe(true)
    })

    it.each(['deleted', 'corrupt', 'no-checksum', 'wrong-checksum', 'bad-schema'])('reconciles committed data after %s revision metadata', async mode => {
        const f = fixture()
        f.sync().accept()
        f.database.customCSS = 'Durable edit'
        f.repository.syncLegacyPresetState(f.database)
        // Simulates a crash after publication but before accepting its revision.
        const target = path.join(f.dataRoot, FILE)
        if (mode === 'deleted') fs.unlinkSync(target)
        if (mode === 'corrupt') fs.writeFileSync(target, '{')
        if (mode === 'no-checksum') fs.unlinkSync(`${target}.sha256`)
        if (mode === 'wrong-checksum') fs.writeFileSync(`${target}.sha256`, '0'.repeat(64))
        if (mode === 'bad-schema') atomicWriteJson(f.dataRoot, FILE, { schemaVersion: 2, revision: 'x' })
        const sync = f.sync()
        const recovered = sync.loadExternalChanges()
        expect(recovered.database.customCSS).toBe('Durable edit')
        sync.accept(recovered.revision)
        expect(f.sync().hasExternalChanges()).toBe(false)
        const cache = attachCompatibilityCache({ store: f.kv, repository: f.repository, dataRoot: f.dataRoot })
        cache.materialize()
        expect(normalizeJSON(await decodeRisuSave(f.kv.kvGet('database/database.bin')))).toEqual(recovered.database)
    })

    it('does not report acceptance when a revision write fails', () => {
        const f = fixture()
        f.sync().accept()
        f.database.customCSS = 'New data'
        f.repository.syncLegacyPresetState(f.database)
        const rename = fs.renameSync
        vi.spyOn(fs, 'renameSync').mockImplementation((source: any, target: any) => {
            if (String(target) === path.join(f.dataRoot, FILE)) throw new Error('simulated rename failure')
            return rename(source, target)
        })
        expect(() => f.sync().accept()).toThrow('simulated rename failure')
        expect(f.sync().hasExternalChanges()).toBe(true)
        expect(f.sync().loadExternalChanges().database.customCSS).toBe('New data')
    })

    it('recovers an interrupted canonical journal with the previous accepted revision', () => {
        const f = fixture()
        f.sync().accept()
        f.database.customCSS = 'Committed CSS'
        f.database.botPresets[0].name = 'Committed preset'
        const rename = fs.renameSync
        const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source: any, target: any) => {
            if (String(source).includes('.stage') && String(target).endsWith('preset.json')) {
                throw new Error('interrupted publication')
            }
            return rename(source, target)
        })
        expect(() => f.repository.syncLegacyPresetState(f.database)).toThrow('interrupted publication')
        spy.mockRestore()
        createFileKv({ dataRoot: f.dataRoot }) // Boot recovers prepared journals first.
        const repository = createUserDataRepository({ dataRoot: f.dataRoot })
        const sync = createCanonicalProjectionSync({ repository, ...f.storage() })
        const changed = sync.loadExternalChanges()
        expect(changed.database.customCSS).toBe('Committed CSS')
        expect(changed.database.botPresets[0].name).toBe('Committed preset')
        sync.accept(changed.revision)
        expect(sync.hasExternalChanges()).toBe(false)
        expect(fs.readdirSync(path.join(f.dataRoot, '.journal'))).toEqual([])
    })
})
