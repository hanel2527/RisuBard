function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length > 1200) {
        throw new Error(`장면 계획의 ${field} 항목을 확인해 주세요.`)
    }
    // Keep each instruction within the pose paragraph used by the existing editor.
    return value.replace(/\s+/g, ' ').trim()
}

const lines = (...values: string[]) => [...new Set(values.filter(Boolean))].join('\n')

/** Project AI-only planning fields into the existing editable draft; never recompile saved edits. */
export function compilePainterScenePlan(value: unknown, excludedSubjectNames?: ReadonlySet<string>): unknown {
    if (!object(value) || value.version === undefined) return value
    if (value.version !== 2 || !object(value.scene) || !Array.isArray(value.subjects)
        || value.subjects.length > 22 || !Array.isArray(value.interactions) || value.interactions.length > 64) {
        throw new Error('장면 계획 형식이 올바르지 않습니다.')
    }
    const composition = lines(...['tags', 'location', 'framing', 'camera'].map(key => text(value.scene[key], key)))
    if (!composition) throw new Error('장면 계획에 구도나 배경 설명이 필요합니다.')

    const actions = value.subjects.map(() => [] as string[])
    const excluded = new Set<number>()
    value.subjects.forEach((subject, index) => {
        if (object(subject) && subject.kind === 'character'
            && [subject.name, ...(Array.isArray(subject.aliases) ? subject.aliases : [])]
                .some(name => typeof name === 'string' && excludedSubjectNames?.has(name.trim().toLowerCase()))) {
            excluded.add(index)
        }
    })
    const relations: string[] = []
    for (const relation of value.interactions) {
        if (!object(relation)) throw new Error('상호작용 형식을 확인해 주세요.')
        const { source, target } = relation
        if (typeof source !== 'number' || typeof target !== 'number'
            || !Number.isInteger(source) || !Number.isInteger(target)
            || source < 0 || target < 0 || source >= actions.length || target >= actions.length || source === target) {
            throw new Error('상호작용에 연결된 인물 또는 사물을 확인해 주세요.')
        }
        const description = text(relation.description, '관계')
        if (!description) throw new Error('상호작용의 관계 설명이 필요합니다.')
        const sourceAction = text(relation.sourceAction, '행동 주체')
        const targetAction = text(relation.targetAction, '행동 상대')
        // Preserve original indices until routing is complete; the viewer must not survive as another actor's prose.
        if (excluded.has(source) || excluded.has(target)) continue
        relations.push(description)
        actions[source].push(sourceAction)
        actions[target].push(targetAction)
    }

    return {
        rendering: value.rendering,
        scene: lines(composition, ...relations),
        negative: value.negative,
        subjects: value.subjects.map((subject, index) => {
            if (!object(subject) || !object(subject.pose)) throw new Error('인물의 자세 계획을 확인해 주세요.')
            const pose = subject.pose
            return {
                ...subject,
                // The model must incorporate old edits into its plan, not mask the plan with a stale override.
                prompt: undefined,
                pose: lines(text(pose.tags, '자세 태그'), text(pose.placement, '화면 배치'),
                    text(pose.posture, '자세'), text(pose.action, '독립 행동'), ...actions[index],
                    text(pose.expression, '표정'), text(pose.gaze, '시선')),
            }
        }).filter((_, index) => !excluded.has(index)),
    }
}
