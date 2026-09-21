// Keep this entry independent of the app, its styles, stores and translations.
export async function startWithBranding(loadApp: () => Promise<unknown>): Promise<void> {
    const korean = document.documentElement.lang === 'ko'
    const status = document.getElementById('preloading-status')
    const logo = document.querySelector<HTMLImageElement>('[data-startup-logo="preloader"]')
    if (status) status.textContent = korean ? '브랜딩 배너를 준비하는 중...' : 'Preparing the branding banner...'
    try { await logo?.decode() } catch { /* A missing image must not prevent startup. */ }
    // Give the decoded banner a paint opportunity before evaluating the app.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (status) status.textContent = korean ? '앱 코드와 화면 스타일을 불러오는 중...' : 'Loading app code and styles...'
    try {
        await loadApp()
    } catch (cause) {
        const error = document.getElementById('preloading-error')
        if (error) {
            error.hidden = false
            error.textContent = `${korean ? '시작 실패' : 'Startup failed'}: ${cause instanceof Error ? cause.message : String(cause)}`
        }
        console.error('RisuBard startup failed', cause)
    }
}
