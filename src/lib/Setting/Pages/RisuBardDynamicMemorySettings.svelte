<script lang="ts">
    import { DBState, selIdState } from 'src/ts/stores.svelte'
    import RisuBardCurrentChatSettings from 'src/lib/Others/RisuBardCurrentChatSettings.svelte'
    let character = $derived(DBState.db.characters[selIdState.selId])
    let chat = $derived(character?.chats[character.chatPage])
</script>

<RisuBardCurrentChatSettings global={DBState.db} {chat} globalDynamicOnly />
