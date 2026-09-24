import { describe, expect, test } from 'vitest'
import { selectMarkdownExcerpt } from './risubard-markdown-excerpt'

const longCharacter = [
    '## 체사레',
    '',
    '### 작중 행적',
    '',
    `- ${'오래된 사건 '.repeat(500)}`,
    '',
    '### 현재 상태',
    '',
    '- 쉽독이다.',
    '- 이탈리아에 남기로 했다.',
    '',
    '### 관계',
    '',
    '- 연인과 교제한 지 21개월이다.',
    '',
    '### 목표',
    '',
    '- 유럽에서 취업한다.',
].join('\n')

describe('bounded Markdown excerpts', () => {
    test('keeps a matched allegation under its enclosing disproof heading', () => {
        const excerpt = selectMarkdownExcerpt({
            content: ['## Archive', '### Background', 'Unrelated scenery. '.repeat(400),
                '### Disproven rumors', '#### Courier', 'The courier stole the ledger.',
                '### Confirmed events', '#### Gate', 'The gate opened.'].join('\n\n'),
            documentType: 'event', query: 'courier ledger', maximumCharacters: 250,
            chronologyIntent: false,
        })
        expect(excerpt).toContain('### Disproven rumors');
        expect(excerpt).toContain('#### Courier');
        expect(excerpt).toContain('The courier stole the ledger.');
        expect(excerpt).not.toContain('Confirmed events');
        expect(excerpt.length).toBeLessThanOrEqual(250);
    })

    test('does not leak matching subsections of character history into current state', () => {
        const excerpt = selectMarkdownExcerpt({
            content: ['## Alice', '### Story History', '#### Fortress',
                'Alice lives in the fortress. '.repeat(200),
                '### Current State', '#### Home', 'Alice now lives in the village.'].join('\n\n'),
            documentType: 'character', query: 'Alice fortress', maximumCharacters: 250,
            chronologyIntent: false,
        })
        expect(excerpt).toContain('Alice now lives in the village.');
        expect(excerpt).not.toContain('fortress');
    })

    test.each([40, 80, 120, 240])('never emits a nested claim without its qualifier at budget %i', maximumCharacters => {
        const excerpt = selectMarkdownExcerpt({
            content: ['## Archive', '### Background', 'Scenery. '.repeat(300),
                '### Disproven rumors', '#### Courier', 'The courier stole the ledger.'].join('\n\n'),
            documentType: 'event', query: 'courier ledger', maximumCharacters,
            chronologyIntent: false,
        })
        if (excerpt.includes('stole')) expect(excerpt).toContain('### Disproven rumors')
        expect(excerpt.length).toBeLessThanOrEqual(maximumCharacters)
    })

    test.each([65, 75])('keeps qualifications even when the claim is itself a heading at budget %i', maximumCharacters => {
        const excerpt = selectMarkdownExcerpt({
            content: ['## Archive', '### Background', 'Scenery. '.repeat(300),
                '### Disproven rumors', '#### The courier stole the ledger.', '### Other', 'Unrelated'].join('\n\n'),
            documentType: 'event', query: 'courier ledger', maximumCharacters,
            chronologyIntent: false,
        })
        if (excerpt.includes('stole')) expect(excerpt).toContain('### Disproven rumors')
        expect(excerpt.length).toBeLessThanOrEqual(maximumCharacters)
    })

    test('restores a parent heading when ranked siblings belong to different scopes', () => {
        const excerpt = selectMarkdownExcerpt({
            content: ['## Archive', '### Background', 'Scenery. '.repeat(300),
                '### Beliefs', '#### Alice', 'Alice suspects the courier.',
                '### Facts', '#### Bob', 'Bob helped the courier.'].join('\n\n'),
            documentType: 'event', query: 'Bob courier', maximumCharacters: 400,
            chronologyIntent: false,
        })
        expect(excerpt).toContain('### Facts\n\n#### Bob')
        expect(excerpt).toContain('### Beliefs\n\n#### Alice')
    })

    test('keeps character current-state lanes ahead of long history', () => {
        const excerpt = selectMarkdownExcerpt({
            content: longCharacter,
            documentType: 'character',
            query: '체사레가 산책을 계속한다.',
            maximumCharacters: 2_000,
            chronologyIntent: false,
        })

        expect(excerpt).toContain('## 체사레')
        expect(excerpt).toContain('### 현재 상태')
        expect(excerpt).toContain('쉽독이다')
        expect(excerpt).toContain('### 관계')
        expect(excerpt).toContain('### 목표')
        expect(excerpt).not.toContain('오래된 사건 오래된 사건 오래된 사건')
        expect(excerpt.length).toBeLessThanOrEqual(2_000)
    })

    test('includes character history only for chronology intent', () => {
        const ordinary = selectMarkdownExcerpt({
            content: longCharacter, documentType: 'character',
            query: '체사레의 현재 상태', maximumCharacters: 2_000,
            chronologyIntent: false,
        })
        const chronology = selectMarkdownExcerpt({
            content: longCharacter, documentType: 'character',
            query: '체사레의 작중 행적', maximumCharacters: 2_000,
            chronologyIntent: true,
        })

        expect(ordinary).not.toContain('### 작중 행적')
        expect(chronology).toContain('### 작중 행적')
        expect(chronology).toContain('### 현재 상태')
    })

    test('keeps matched history ahead of oversized current sections for chronology intent', () => {
        const excerpt = selectMarkdownExcerpt({
            content: [
                '## 체사레',
                '### 현재 상태',
                `- ${'세부 상태 '.repeat(500)}`,
                '### 작중 행적',
                '- 양치기 대회에서 우승했다.',
            ].join('\n\n'),
            documentType: 'character', query: '체사레의 작중 행적',
            maximumCharacters: 500, chronologyIntent: true,
        })

        expect(excerpt).toContain('### 작중 행적')
        expect(excerpt).toContain('양치기 대회에서 우승했다')
    })

    test('recognizes English current character headings', () => {
        const excerpt = selectMarkdownExcerpt({
            content: [
                '## Cesare',
                '### Story History',
                `- ${'Old event '.repeat(400)}`,
                '### Identity',
                '- Sheepdog',
                '### Current State',
                '- Staying in Italy',
                '### Relationships',
                '- Dating for 21 months',
            ].join('\n\n'),
            documentType: 'character', query: 'Cesare continues.',
            maximumCharacters: 1_000, chronologyIntent: false,
        })

        expect(excerpt).toContain('### Identity')
        expect(excerpt).toContain('Sheepdog')
        expect(excerpt).toContain('### Current State')
        expect(excerpt).toContain('### Relationships')
        expect(excerpt).not.toContain('### Story History')
    })

    test('keeps non-character excerpts centered on the matching section', () => {
        const excerpt = selectMarkdownExcerpt({
            content: [
                '## 오래된 사건',
                '### 도입',
                `- ${'무관한 설명 '.repeat(400)}`,
                '### 결정적 단서',
                '- 붉은 구체는 숨겨진 문을 연다.',
                '### 결말',
                '- 문이 열렸다.',
            ].join('\n\n'),
            documentType: 'event', query: '붉은 구체와 숨겨진 문',
            maximumCharacters: 500, chronologyIntent: false,
        })

        expect(excerpt).toContain('## 오래된 사건')
        expect(excerpt).toContain('### 결정적 단서')
        expect(excerpt).toContain('붉은 구체는 숨겨진 문을 연다')
        expect(excerpt).not.toContain('무관한 설명 무관한 설명')
        expect(excerpt.length).toBeLessThanOrEqual(500)
    })
})

test('prioritizes modular character state over a long major-transition map', () => {
    const content = ['## 쿠루미', '### 주요 전환', '과거 전투 '.repeat(800),
        '### 인물 핵심', '육상부 출신', '### 관계와 신뢰', '쇼지를 신뢰한다',
        '### 지식과 비밀', '탈출 계획을 안다', '### 장비와 소지품', '공사용 삽'].join('\n\n')
    const excerpt = selectMarkdownExcerpt({ content, documentType: 'character', query: '쿠루미', maximumCharacters: 350, chronologyIntent: false })
    expect(excerpt).toContain('육상부 출신')
    expect(excerpt).toContain('쇼지를 신뢰한다')
    expect(excerpt).toContain('탈출 계획을 안다')
    expect(excerpt).toContain('공사용 삽')
    expect(excerpt).not.toContain('### 주요 전환')
})
