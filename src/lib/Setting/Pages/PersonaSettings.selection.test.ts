import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

// Execute the production functions with an isolated database, without loading
// the manager's unrelated image, AI, and storage dependencies.
function functionsFrom(path: string, names: string[]): string {
    const source = readFileSync(path, 'utf8').replace(/^[\s\S]*?<script[^>]*>/, '').split('</script>')[0]
    const parsed = ts.createSourceFile(path + '.ts', source, ts.ScriptTarget.Latest, true)
    return parsed.statements
        .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
        .map((node) => node.getText(parsed).replace(/^export /, ''))
        .join('\n')
}

const code = ts.transpile(
    functionsFrom('src/lib/Setting/Pages/PersonaSettings.svelte', ['syncGlobalLegacyFields'])
    + '\n' + functionsFrom('src/ts/persona.ts', ['saveUserPersona', 'changeUserPersona']),
    { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
)

function setup(selectedPersona = 1, activeScope = 'global') {
    const personas = ['리코', '미리'].map((name, index) => ({
        id: `persona-${index}`, name, icon: `${name}.png`, personaPrompt: `${name} 설명`, note: `${name} 메모`,
    }))
    const selected = personas[selectedPersona]
    const db = {
        personas, selectedPersona, username: selected.name, userIcon: selected.icon,
        personaPrompt: selected.personaPrompt, userNote: selected.note,
    }
    const context = createContext({ DBState: { db }, getDatabase: () => db, activeScope, editingPersona: personas[0] })
    runInContext(code, context)
    return { db, context, run: (command: string) => runInContext(command, context) }
}

describe('persona picker legacy field ownership', () => {
    test.each([0, 1])('preserves both personas when switching a bound Riko to Miri (global index %i)', (index) => {
        const { db, context, run } = setup(index)
        const before = structuredClone(db.personas)
        // The picker opens on the chat binding, which may differ from the global selection.
        run('syncGlobalLegacyFields()')
        context.editingPersona = db.personas[1]
        run('changeUserPersona(1)')
        run('syncGlobalLegacyFields()')
        expect(db.personas).toEqual(before)
        expect(db.selectedPersona).toBe(1)
        expect(db.username).toBe('미리')
    })

    test('opening and closing a different bound persona leaves the global mirror intact', () => {
        const { db, run } = setup()
        const before = structuredClone(db)
        run('syncGlobalLegacyFields()') // mount effect
        run('syncGlobalLegacyFields()') // destroy callback
        run('saveUserPersona()')
        expect(db).toEqual(before)
    })

    test('editing an inactive persona preserves its edits without contaminating the selected persona', () => {
        const { db, run } = setup()
        db.personas[0].name = '수정한 리코'
        const before = structuredClone(db.personas)
        run('syncGlobalLegacyFields(); saveUserPersona()')
        expect(db.personas).toEqual(before)
        expect(db.username).toBe('미리')
    })

    test('still synchronizes edits to the globally selected persona', () => {
        const { db, run } = setup(0)
        Object.assign(db.personas[0], { name: '새 이름', icon: 'new.png', personaPrompt: '새 설명', note: '새 메모' })
        run('syncGlobalLegacyFields()')
        expect([db.username, db.userIcon, db.personaPrompt, db.userNote]).toEqual(['새 이름', 'new.png', '새 설명', '새 메모'])
    })

    test('character personas never update the global mirror', () => {
        const { db, run } = setup(1, 'character')
        const before = structuredClone(db)
        run('syncGlobalLegacyFields()')
        expect(db).toEqual(before)
    })
})
