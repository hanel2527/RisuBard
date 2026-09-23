import { startWithBranding } from './ts/startupScreen'

void startWithBranding(async () => {
    const { ready } = await import('./main')
    await ready
})
