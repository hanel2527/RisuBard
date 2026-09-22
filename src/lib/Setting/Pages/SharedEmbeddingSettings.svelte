<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte'
    import { language } from 'src/lang'
    import Help from 'src/lib/Others/Help.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'

    const id = $props.id()
</script>

<div class="flex min-w-0 flex-col gap-3" data-shared-embedding-settings data-setting-id="hypa.embedding">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span class="text-sm text-textcolor">{language.embedding} <Help key="embedding" /></span>
        <!-- A wrapping label forwards clicks to the hidden select and closes the custom picker. -->
        <SelectInput bind:value={DBState.db.hypaModel} ariaLabel="임베딩 모델" className="w-full sm:w-80">
            {#if typeof navigator !== 'undefined' && 'gpu' in navigator}
                <OptionInput value="MiniLMGPU">MiniLM L6 v2 (GPU)</OptionInput>
                <OptionInput value="nomicGPU">Nomic Embed Text v1.5 (GPU)</OptionInput>
                <OptionInput value="bgeSmallEnGPU">BGE Small English (GPU)</OptionInput>
                <OptionInput value="bgem3GPU">BGE Medium 3 (GPU)</OptionInput>
                <OptionInput value="multiMiniLMGPU">Multilingual MiniLM L12 v2 (GPU)</OptionInput>
                <OptionInput value="bgeM3KoGPU">BGE Medium 3 Korean (GPU)</OptionInput>
            {/if}
            <OptionInput value="MiniLM">MiniLM L6 v2 (CPU)</OptionInput>
            <OptionInput value="nomic">Nomic Embed Text v1.5 (CPU)</OptionInput>
            <OptionInput value="bgeSmallEn">BGE Small English (CPU)</OptionInput>
            <OptionInput value="bgem3">BGE Medium 3 (CPU)</OptionInput>
            <OptionInput value="multiMiniLM">Multilingual MiniLM L12 v2 (CPU)</OptionInput>
            <OptionInput value="bgeM3Ko">BGE Medium 3 Korean (CPU)</OptionInput>
            <OptionInput value="openai3small">OpenAI text-embedding-3-small</OptionInput>
            <OptionInput value="openai3large">OpenAI text-embedding-3-large</OptionInput>
            <OptionInput value="ada">OpenAI Ada</OptionInput>
            <OptionInput value="custom">Custom (OpenAI-compatible)</OptionInput>
            <OptionInput value="voyageContext3">Voyage Context 3</OptionInput>
        </SelectInput>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-textcolor2">Hypa와 바드위키가 같은 모델, URL과 API 키를 사용합니다.</p>
    </div>
    {#if ['openai3small', 'openai3large', 'ada'].includes(DBState.db.hypaModel)}
        <div class="grid items-center gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <label for={`${id}-openai`} class="text-sm text-textcolor">OpenAI API Key <Help key="embeddingOpenAIKey" /></label>
            <TextInput id={`${id}-openai`} bind:value={DBState.db.supaMemoryKey} hideText fullwidth />
        </div>
    {:else if DBState.db.hypaModel === 'custom'}
        <div class="grid items-center gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <label for={`${id}-url`} class="text-sm text-textcolor">URL <Help key="embeddingCustomURL" /></label>
            <TextInput id={`${id}-url`} bind:value={DBState.db.hypaCustomSettings.url} fullwidth />
            <label for={`${id}-key`} class="text-sm text-textcolor">Key / Password <Help key="embeddingCustomKey" /></label>
            <TextInput id={`${id}-key`} bind:value={DBState.db.hypaCustomSettings.key} hideText fullwidth />
            <label for={`${id}-model`} class="text-sm text-textcolor">Request Model <Help key="embeddingCustomModel" /></label>
            <TextInput id={`${id}-model`} bind:value={DBState.db.hypaCustomSettings.model} fullwidth />
        </div>
    {:else if DBState.db.hypaModel === 'voyageContext3'}
        <div class="grid items-center gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <label for={`${id}-voyage`} class="text-sm text-textcolor">Voyage API Key <Help key="embeddingVoyageKey" /></label>
            <TextInput id={`${id}-voyage`} bind:value={DBState.db.voyageApiKey} hideText fullwidth />
        </div>
    {/if}
    {#if DBState.db.hypaModel === 'multiMiniLM' || DBState.db.hypaModel === 'multiMiniLMGPU'}
        <p class="text-xs text-textcolor2">Multilingual MiniLM은 PC에서 실행하는 다국어 임베딩 모델입니다. 처음 사용할 때 모델 파일을 내려받으며 API 키는 필요하지 않습니다.</p>
    {/if}
</div>
