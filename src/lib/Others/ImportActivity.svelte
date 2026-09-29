<script lang="ts">
    import { importProgress } from 'src/ts/importProgress';
    import { language } from 'src/lang';
    let now = $state(Date.now());
    $effect(() => {
        if (!$importProgress.active) return;
        now = Date.now();
        const timer = setInterval(() => { now = Date.now() }, 1000);
        return () => clearInterval(timer);
    });
    const age = $derived(Math.max(0, Math.floor((now - $importProgress.activityAt) / 1000)));
    const elapsed = $derived(Math.max(0, Math.floor((now - $importProgress.startedAt) / 1000)));
    const stage = $derived(language.importInstall.stages[$importProgress.stage as keyof typeof language.importInstall.stages] ?? language.importInstall.saving);
</script>

{#if $importProgress.active}
    <div class="w-full min-w-0 space-y-3 text-sm">
        {#if $importProgress.server}
            <div class="rounded-md border border-darkborderc bg-bgcolor p-3 text-textcolor whitespace-pre-wrap break-words" role="status" aria-live="polite">
                <span class="text-textcolor2 tabular-nums">{new Date($importProgress.activityAt).toLocaleTimeString()}</span>
                {stage}{#if $importProgress.completed !== undefined && $importProgress.total} ({$importProgress.completed.toLocaleString()} / {$importProgress.total.toLocaleString()}){/if}
                {#if $importProgress.detail}<div class="mt-1 break-all">{$importProgress.detail}</div>{/if}
            </div>
            {#if $importProgress.percent === undefined}<p class="text-textcolor2 text-center">{language.importInstall.unknownTotal}</p>{/if}
        {/if}
        <div class="flex flex-wrap justify-between gap-2 text-textcolor2 tabular-nums">
            <span>{language.importInstall.elapsed} {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
            <span>{language.importInstall.lastActivity} {age}{language.importInstall.secondsAgo}</span>
        </div>
        {#if $importProgress.server && ($importProgress.connection === 'lost' || age >= 30)}
            <p class="text-textcolor rounded-md border border-darkborderc p-3" role="status">{$importProgress.connection === 'lost' ? language.importInstall.unavailable : language.importInstall.stale}</p>
        {/if}
    </div>
{/if}
