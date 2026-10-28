const BUTTON_ID = 'risubard-translation-viewer:toggle';
const MARK = 'x-rtv-quick-heading';
// Scope to the live sidebar, not the preset preview or popup editor. The preset-list
// icon distinguishes this title from identical persona/prompt binding rows.
// If the host changes these hooks, use the official FAB API instead.
const HEADING = '[data-current-chat-section] ~ div > div.text-\\[11px\\]:has(+ div.items-stretch .lucide-folder-heart)';
const release = object => { object?.release?.(); };

export const quickToggleCSS = `
[${MARK}]:not([${MARK}=""]) { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.rtv-quick { flex-shrink: 0; margin-inline-start: auto; }
.rtv-quick button { font: inherit; font-size: 12px; padding: 4px 8px; border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
.rtv-quick button[aria-pressed="true"] { color: var(--color-success, currentColor); }
.rtv-quick button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.rtv-quick button:disabled { opacity: .6; cursor: wait; }
[data-plugin-fab$=":${BUTTON_ID}"] > div { width: auto; height: auto; white-space: nowrap; font-size: 13px; }
`;

export function createQuickToggle(api, doc, engine, { readSelection, onChange, openSettings, reportError }) {
    let disposed = false;
    let busy = false;
    let mounted = null;
    let floating = null;
    let floatingState = '';
    let sequence = 0;

    async function clearInline() {
        const old = mounted;
        mounted = null;
        if (!old) return;
        await Promise.allSettled([
            old.heading.setAttribute(MARK, ''), old.wrapper.remove(),
            old.button?.removeEventListener('click', old.listener),
        ]);
        for (const element of [old.heading, old.wrapper, old.button]) release(element);
    }

    async function clearFloating() {
        if (!floating) return;
        await api.unregisterUIPart(floating.id);
        floating = null;
        floatingState = '';
    }

    async function findHeading() {
        const safe = await doc.querySelectorAll(HEADING);
        const candidates = await api.unwarpSafeArray(safe);
        release(safe);
        let found = null;
        try {
            const width = await doc.clientWidth();
            const height = await doc.clientHeight();
            for (const candidate of candidates) {
                const rect = await candidate.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
                    && rect.left < width && rect.top < height) {
                    found = candidate;
                    break;
                }
            }
            return found;
        } finally {
            for (const candidate of candidates) if (candidate !== found) release(candidate);
        }
    }

    async function toggle(characterId) {
        if (disposed || busy) return;
        busy = true;
        onChange();
        try {
            const current = await readSelection();
            // A button painted for A must not change B after a fast chat switch.
            if (disposed || current?.character.chaId !== characterId) return;
            if (!engine.settings.enabled) {
                await openSettings();
                return;
            }
            await engine.saveSettings(settings => {
                const disabled = new Set(settings.disabledCharacterIds);
                if (disabled.has(characterId)) disabled.delete(characterId);
                else disabled.add(characterId);
                return { ...settings, disabledCharacterIds: [...disabled] };
            });
        } catch (error) {
            if (!disposed) {
                reportError(error);
                alert(`번역 사용 설정을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
            }
        } finally {
            busy = false;
            if (!disposed) onChange();
        }
    }

    return {
        async refresh(snapshot) {
            if (disposed) return;
            const characterId = snapshot?.character.chaId;
            if (!characterId || characterId === '§playground') {
                await clearInline();
                await clearFloating();
                return;
            }
            const enabled = engine.isEnabled(characterId);
            const label = busy ? '저장 중…' : !engine.settings.enabled ? '번역 전체 꺼짐' : enabled ? '번역 켜짐' : '번역 꺼짐';
            const title = !engine.settings.enabled ? '전체 번역이 꺼져 있습니다. 설정 열기'
                : '이 챗봇의 모든 채팅에서 번역 켜기/끄기 · 저장된 번역은 유지됩니다';
            const state = JSON.stringify([characterId, label]);
            let heading = await findHeading();
            try {
                if (disposed) return;
                if (heading) {
                    await clearFloating();
                    const child = await heading.querySelector('.rtv-quick');
                    const retained = mounted && child && await heading.getAttribute(MARK) === mounted.token;
                    release(child);
                    if (!retained) {
                        await clearInline();
                        const wrapper = await doc.createElement('span');
                        mounted = { heading, wrapper, token: `rtv-${++sequence}`, state: '', button: null, listener: null };
                        heading = null; // Ownership transferred to mounted.
                        await wrapper.setClassName('rtv-quick');
                        await mounted.heading.setAttribute(MARK, mounted.token);
                        await mounted.heading.appendChild(wrapper);
                    }
                    if (mounted.state !== state) {
                        if (mounted.characterId !== characterId) mounted.restoreFocus = false;
                        if (mounted.button) {
                            if (mounted.characterId === characterId && await mounted.button.matches(':focus')) mounted.restoreFocus = true;
                            await mounted.button.removeEventListener('click', mounted.listener);
                            release(mounted.button);
                        }
                        // Only constant labels go into this plugin-owned HTML; never character text.
                        await mounted.wrapper.setInnerHTML(`<button type="button" title="${title}" aria-pressed="${enabled}" ${busy ? 'disabled' : ''}>${label}</button>`);
                        mounted.button = await mounted.wrapper.querySelector('button');
                        mounted.listener = await mounted.button.addEventListener('click', () => { void toggle(characterId); });
                        mounted.state = state;
                        mounted.characterId = characterId;
                        if (mounted.restoreFocus && !busy) {
                            const focused = await doc.querySelector(':focus');
                            try {
                                if (!focused || await focused.matches('body')) await mounted.button.focus();
                            } finally {
                                release(focused);
                                mounted.restoreFocus = false;
                            }
                        }
                    }
                } else {
                    await clearInline();
                    if (floatingState !== state) {
                        floating = await api.registerButton({
                            id: BUTTON_ID, location: 'action', name: `${label} — ${title}`,
                            iconType: 'html', icon: `<span>${label}</span>`,
                        }, () => { void toggle(characterId); });
                        floatingState = state;
                    }
                }
            } finally {
                release(heading);
                if (disposed) { await clearInline(); await clearFloating(); }
            }
        },
        async dispose() {
            disposed = true;
            await Promise.allSettled([clearInline(), clearFloating()]);
        },
    };
}
