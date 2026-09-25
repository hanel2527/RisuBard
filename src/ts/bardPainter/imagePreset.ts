import type { Chat, Database, character } from '../storage/database.svelte'
import { composePromptBlockOverlay, getEffectivePromptToggleTemplate } from '../promptBlockOverlay'

export function painterPromptPreset(db: Database, chat: Chat) {
    return db.botPresets?.find(preset => preset.id === chat.bindedBotPreset)
        ?? db.botPresets?.[db.botPresetsId]
}

export function painterPromptDatabase(db: Database, chat: Chat): Database {
    const preset = painterPromptPreset(db, chat)
    const source = preset && preset !== db.botPresets?.[db.botPresetsId] ? preset : db
    return { ...db, mainPrompt: source.mainPrompt,
        promptTemplate: composePromptBlockOverlay(source.promptTemplate, db.promptBlockOverlayProfiles ?? [], source.promptBlockOverlay),
        customPromptTemplateToggle: getEffectivePromptToggleTemplate(source.customPromptTemplateToggle ?? '', db.promptBlockOverlayProfiles ?? [], source.promptBlockOverlay) }
}

/** Complete request-local toggle scope: omitted values never inherit active chat toggles. */
export async function painterImageToggleScope(db: Database, character: character, chat: Chat, values: Record<string, string>) {
    const { createPromptV2PreviewValues, parsePromptV2ToggleTree } = await import('../promptV2')
    const globals = { ...db.globalChatVariables, ...(!db.disableToggleBinding && chat.useLocallySetGlobalVariables ? chat.GLGlobalVariables : {}) }
    for (const key of Object.keys(globals)) if (key.startsWith('toggle_')) globals[key] = '0'
    const moduleIds = new Set([...(db.enabledModules ?? []), ...(character.modules ?? []), ...(chat.modules ?? []),
        ...(db.moduleIntergration ?? '').split(',').map(id => id.trim())])
    const template = [db.customPromptTemplateToggle, character.customModuleToggle,
        ...(db.modules ?? []).filter(module => moduleIds.has(module.id) || !!module.namespace && moduleIds.has(module.namespace))
            .map(module => module.customModuleToggle)].filter(Boolean).join('\n')
    const defaults = createPromptV2PreviewValues(parsePromptV2ToggleTree(template).definitions)
    const toggles = Object.fromEntries(Object.entries(values).filter(([key, value]) => key.startsWith('toggle_') && typeof value === 'string'))
    return { ...globals, ...defaults, ...toggles }
}
