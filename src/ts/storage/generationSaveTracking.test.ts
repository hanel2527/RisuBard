import { expect, it, vi } from 'vitest'
import { createGenerationSaveTracker } from './generationSaveTracking'

const persisted = vi.hoisted(() => new Map<string, string>())
vi.mock('../globalApi.svelte', () => ({forageStorage:{realStorage:{
    saveChatContent: async (owner:string, _index:number, id:string, chat:unknown) => {persisted.set(`${owner}/${id}`,JSON.stringify(chat))},
    fetchChatContent: async (owner:string, _index:number, id:string) => JSON.parse(persisted.get(`${owner}/${id}`)!),
}}}))
vi.mock('./database.svelte', () => ({isChatStub:(chat:any)=>chat?._stub===true && !Array.isArray(chat.message)}))
import { saveChatToServer, ensureChatHydrated, chatToStub, stubToPlaceholder } from './chatStorage'

it('tracks and saves unselected streaming A including the final update after generation ends', async () => {
    const a:any = {id:'A',message:[{role:'user',data:'question A'}],note:'',localLore:[]}
    const b:any = {id:'B',message:[{role:'user',data:'question B'}],note:'',localLore:[]}
    const char:any = {chaId:'bot',chatPage:1,chats:[a,b]}
    const track = createGenerationSaveTracker()
    const save = async (ids:string[]) => {
        const targets = track([char],ids)
        for(const {character,chat,chatIndex} of targets) await saveChatToServer(character.chaId,chatIndex,chat.id!,chat)
        return targets.map(t=>t.chat.id)
    }
    await saveChatToServer('bot',1,'B',b)
    a.message.push({role:'char',data:'partial A'})
    a.isStreaming=true
    expect(await save(['A'])).toEqual(['A'])
    expect(JSON.parse(persisted.get('bot/A')!).message[1].data).toBe('partial A')
    a.message[1].data='complete A'
    a.isStreaming=false
    expect(await save([])).toEqual(['A'])
    const reloaded = [a,b].map(c=>stubToPlaceholder(chatToStub(c)))
    await ensureChatHydrated(reloaded,0,'bot')
    await ensureChatHydrated(reloaded,1,'bot')
    expect(reloaded[0].message[1].data).toBe('complete A')
    expect(reloaded[1].message).toEqual(b.message)
    expect(reloaded.map(c=>c.id)).toEqual(['A','B'])
    expect(await save([])).toEqual([])
})
