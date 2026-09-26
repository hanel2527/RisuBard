<script lang="ts">
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import type { LiveFileMonitoringStatus } from 'src/ts/storage/nodeStorage'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'

    let status = $state<LiveFileMonitoringStatus | null>(null)
    let checked = $state(false)
    let busy = $state(true)
    let error = $state('')

    async function load() {
        busy = true
        error = ''
        try {
            status = await forageStorage.getLiveFileMonitoring(true)
            checked = status.enabled
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function change(enabled: boolean) {
        if (busy || !status) return
        busy = true
        error = ''
        try {
            status = await forageStorage.setLiveFileMonitoring(enabled)
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            checked = status.enabled
            busy = false
        }
    }

    onMount(() => { void load() })
</script>

<section class="monitoring-setting" aria-label={language.liveFileMonitoringTitle} aria-busy={busy}>
    <div class="setting-row">
        <h2>{language.liveFileMonitoringTitle}</h2>
        <ShSwitch bind:checked onCheckedChange={change} disabled={busy || !status} ariaLabel={language.liveFileMonitoringTitle} />
    </div>
    <p>{language.liveFileMonitoringDesc}</p>
    {#if busy}<p role="status">{language.loading}</p>{/if}
    {#if error}<p role="alert">{language.liveFileMonitoringFailed}: {error}</p>{/if}
    {#if !status && !busy}
        <ShButton variant="outline" onclick={load}>{language.liveFileMonitoringRetry}</ShButton>
    {/if}
</section>

<style>
    .monitoring-setting { display: grid; gap: .7rem; padding: 1rem; background: var(--settings-surface); border: 1px solid var(--settings-border); border-radius: var(--settings-radius); }
    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; min-height: 44px; }
    h2 { font-size: 1rem; color: var(--color-textcolor); }
    p { color: var(--color-textcolor2); line-height: 1.5; }
    [role="alert"] { color: var(--color-danger); }
</style>
