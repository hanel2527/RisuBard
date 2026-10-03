/**
 * Closed vocabulary the planner selects by ID. The application, not the model, writes
 * the image tags, so adult acts and states never have to appear in model prose.
 */
interface PainterCatalogAct {
    /** Tags added to the global prompt. */
    scene?: string
    /** NovelAI action tag routed to participants as source#/target# or mutual#. */
    actor?: string
    mutual?: boolean
    explicit?: boolean
}

interface PainterCatalogState {
    tags: string
    explicit?: boolean
}

const act = (actor: string, extra: Omit<PainterCatalogAct, 'actor'> = {}): PainterCatalogAct => ({ actor, ...extra })
const adult = (scene: string, actor?: string, mutual = false): PainterCatalogAct => ({ scene, ...(actor ? { actor } : {}), mutual, explicit: true })

export const PAINTER_CATALOG_ACTS: Readonly<Record<string, PainterCatalogAct>> = Object.freeze({
    hug: act('hug', { mutual: true }),
    kiss: act('kiss', { mutual: true }),
    kiss_cheek: act('kissing cheek'),
    kiss_forehead: act('kissing forehead'),
    holding_hands: act('holding hands', { mutual: true }),
    headpat: act('headpat'),
    princess_carry: act('princess carry'),
    piggyback: act('piggyback'),
    lap_pillow: act('lap pillow'),
    feeding: act('feeding'),
    hand_on_shoulder: act("hand on another's shoulder"),
    cheek_touch: act("hand on another's cheek"),
    pushing: act('pushing'),
    slapping: act('slapping'),
    punching: act('punching'),
    french_kiss: adult('french kiss', 'french kiss', true),
    groping: adult('groping', 'groping'),
    breast_grab: adult("grabbing another's breast", "grabbing another's breast"),
    breast_sucking: adult('breast sucking', 'breast sucking'),
    spanking: adult('spanking', 'spanking'),
    handjob: adult('handjob', 'handjob'),
    fingering: adult('fingering', 'fingering'),
    footjob: adult('footjob', 'footjob'),
    paizuri: adult('paizuri', 'paizuri'),
    fellatio: adult('oral, fellatio', 'fellatio'),
    irrumatio: adult('oral, irrumatio', 'irrumatio'),
    cunnilingus: adult('oral, cunnilingus', 'cunnilingus'),
    anilingus: adult('oral, anilingus', 'anilingus'),
    sixty_nine: adult('69', '69', true),
    sex: adult('sex', 'sex'),
    vaginal: adult('sex, vaginal', 'vaginal'),
    anal: adult('sex, anal', 'anal'),
    tribadism: adult('tribadism', 'tribadism', true),
    position_missionary: adult('missionary'),
    position_doggystyle: adult('doggystyle'),
    position_cowgirl: adult('cowgirl position, girl on top'),
    position_reverse_cowgirl: adult('reverse cowgirl position, girl on top'),
    position_standing: adult('standing sex'),
    position_mating_press: adult('mating press'),
    position_prone_bone: adult('prone bone'),
    position_full_nelson: adult('full nelson'),
    position_spooning: adult('spooning'),
})

const state = (tags: string, explicit = true): PainterCatalogState => ({ tags, explicit })

export const PAINTER_CATALOG_STATES: Readonly<Record<string, PainterCatalogState>> = Object.freeze({
    torn_clothes: state('torn clothes', false),
    undressing: state('undressing', false),
    heavy_breathing: state('heavy breathing', false),
    trembling: state('trembling', false),
    nude: state('nude'),
    completely_nude: state('completely nude'),
    topless: state('topless'),
    bottomless: state('bottomless'),
    clothing_aside: state('clothing aside'),
    panties_aside: state('panties aside'),
    shirt_lift: state('shirt lift'),
    skirt_lift: state('skirt lift'),
    nipples: state('nipples'),
    pussy: state('pussy'),
    penis: state('penis'),
    erection: state('penis, erection'),
    pussy_juice: state('pussy juice'),
    spread_legs: state('spread legs'),
    spread_pussy: state('spread pussy'),
    presenting: state('presenting'),
    cum: state('cum'),
    cum_on_body: state('cum on body'),
    facial: state('cum on face, facial'),
    cum_in_mouth: state('cum in mouth'),
    cum_in_pussy: state('cum in pussy'),
    cum_overflow: state('cum overflow'),
    after_sex: state('after sex'),
    ahegao: state('ahegao'),
    bound: state('bound'),
    bound_wrists: state('bound wrists'),
    gag: state('gag'),
    ball_gag: state('ball gag'),
    blindfold: state('blindfold'),
    collar: state('collar'),
    leash: state('leash'),
    vibrator: state('vibrator'),
    dildo: state('dildo'),
})

const ids = (record: Readonly<Record<string, unknown>>) => Object.keys(record).join(', ')

/** Compact ID list embedded in the planner contract. */
export const PAINTER_CATALOG_PROMPT = `Catalog acts (interaction acts; mutual: ${Object.entries(PAINTER_CATALOG_ACTS).filter(([, item]) => item.mutual).map(([id]) => id).join(', ')}; position_* set only the overall position): ${ids(PAINTER_CATALOG_ACTS)}
Catalog states (subject stateIds): ${ids(PAINTER_CATALOG_STATES)}`

function catalogIds(value: unknown, field: string, catalog: Readonly<Record<string, unknown>>): string[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== 'string')) {
        throw new Error(`장면 계획의 ${field} 항목을 확인해 주세요.`)
    }
    // Unknown IDs are dropped instead of rejected so one stray value cannot fail the whole plan.
    return [...new Set((value as string[]).map(id => id.trim()))].filter(id => Object.hasOwn(catalog, id))
}

export interface CompiledCatalogAct { scene: string[]; source: string[]; target: string[]; explicit: boolean }

export function compileCatalogActs(value: unknown): CompiledCatalogAct {
    const result: CompiledCatalogAct = { scene: [], source: [], target: [], explicit: false }
    for (const id of catalogIds(value, '상호작용 동작', PAINTER_CATALOG_ACTS)) {
        const item = PAINTER_CATALOG_ACTS[id]
        if (item.scene) result.scene.push(item.scene)
        if (item.actor) {
            result.source.push(`${item.mutual ? 'mutual' : 'source'}#${item.actor}`)
            result.target.push(`${item.mutual ? 'mutual' : 'target'}#${item.actor}`)
        }
        result.explicit ||= !!item.explicit
    }
    return result
}

export function compileCatalogStates(value: unknown): { tags: string[]; explicit: boolean } {
    const items = catalogIds(value, '상태 ID', PAINTER_CATALOG_STATES).map(id => PAINTER_CATALOG_STATES[id])
    return { tags: items.map(item => item.tags), explicit: items.some(item => item.explicit) }
}
