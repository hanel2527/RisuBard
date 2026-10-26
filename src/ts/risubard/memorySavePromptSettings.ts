import type { Chat } from '../storage/database.svelte'

export function applyMemorySavePromptSettings(chat: Chat, currentChat?: Chat): void {
    // Save slots rewind story state, not the current sidebar preferences.
    for (const key of [
        'bindedPersona', 'bindedBotPreset', 'usePromptPresetParams',
        'useModelPreset', 'modelBinding', 'useLocallySetGlobalVariables',
        'togglePresetBaseline',
    ] as const) {
        delete chat[key]
        if (currentChat?.[key] !== undefined) {
            Object.assign(chat, { [key]: currentChat[key] })
        }
    }
    delete chat.savedToggleValues
    const legacyToggles = currentChat?.GLGlobalVariables === undefined
        ? currentChat?.savedToggleValues
        : undefined
    const currentVariables = currentChat?.GLGlobalVariables ?? legacyToggles ?? {}
    const variables = Object.fromEntries([
        ...Object.entries(chat.GLGlobalVariables ?? {})
            .filter(([key]) => !key.startsWith('toggle_')),
        ...Object.entries(currentVariables)
            .filter(([key]) => key.startsWith('toggle_')),
    ])
    if (Object.keys(variables).length > 0) chat.GLGlobalVariables = variables
    else delete chat.GLGlobalVariables
    // Normalize only the current chat's old pin format; never migrate saved settings.
    if (legacyToggles) chat.useLocallySetGlobalVariables = true
}
