import { afterEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ blockquoteStyling: true }))
vi.mock('../../storage/database.svelte', () => ({ appVer: 'test', getCurrentCharacter: () => ({}), getDatabase: () => ({}) }))
vi.mock('../../stores.svelte', () => ({ DBState: { db: state }, selIdState: { selId: 0 }, selectedCharID: { set: vi.fn() } }))
vi.mock('../../globalApi.svelte', () => ({ aiWatermarkingLawApplies: () => false, getFileSrc: async () => '' }))
vi.mock('../../process/modules', () => ({ getModuleAssets: () => [], getModuleLorebooks: () => [], getModules: () => [] }))
vi.mock('../../process/scripts', () => ({ processScriptFull: () => '' }))
vi.mock('../chatVar.svelte', () => ({ getChatVar: () => '', setChatVar: () => {}, getGlobalChatVar: () => '' }))
vi.mock('../../process/infunctions', () => ({ calcString: () => '' }))
vi.mock('../../util', () => ({ findCharacterbyId: () => undefined, getPersonaPrompt: () => '', getUserIcon: () => '', getUserName: () => '', pickHashRand: () => 0, replaceAsync: async (s: string) => s }))
vi.mock('../../process/files/inlays', () => ({ getInlayInfosBatch: () => [] }))
vi.mock('../../model/modellist', () => ({ getModelInfo: () => undefined }))
vi.mock('../../cbs', () => ({ registerCBS: () => {} }))
vi.mock('src/lang', () => ({ language: {} }))
import { ParseMarkdown, trimMarkdown } from '../parser.svelte'
import { getPainterParagraphStops, nearestPainterParagraphStop } from '../../bardPainter/placement'
import { insertPainterReference } from '../../bardPainter/selection'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

test('places a middle illustration through the real renderer with style, substitutions and generated UI text', async () => {
    const source = '<style>p { line-height: 1.8; }</style>\n\n{{char}}는 역에 도착했다.\n\n"......잠깐."\n\n가방을 의자에 내려놓았다.\n\n멀리 기차가 보였다.'
    const displayed = '<p>생성된 장면 제목</p>\n\n' + source.replace('{{char}}', '아리아') + '\n\n<p>이번 턴 정보</p>'
    const root = document.body.appendChild(document.createElement('span'))
    root.setAttribute('data-painter-message', '0')
    root.innerHTML = `<span data-painter-body style="display:contents">${trimMarkdown(await ParseMarkdown(displayed))}</span>`
    const paragraphs = [...root.querySelectorAll('p')]
    for (const [index, paragraph] of paragraphs.entries()) paragraph.getBoundingClientRect = () => new DOMRect(20, 100 + index * 80, 500, 45)
    const expected = source.indexOf('가방을')
    const before = paragraphs.findIndex(p => p.textContent?.startsWith('가방을'))
    const clickY = 100 + before * 80 - 12
    const stops = getPainterParagraphStops(root, source, { char: '아리아' })
    const selected = nearestPainterParagraphStop(stops, clickY)!
    expect(selected.offset).toBe(expected)
    const inserted = insertPainterReference(source, { start: selected.offset!, end: selected.offset! }, 'test-image', 'after')
    expect(inserted.text.indexOf('{{inlay::test-image}}')).toBeGreaterThan(source.indexOf('잠깐'))
    expect(inserted.text).toContain('{{inlay::test-image}}\n\n가방을')
})
