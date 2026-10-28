import { startTranslationViewer } from './main.js';

startTranslationViewer(Risuai).catch(error => {
    console.error('[원문 보존 번역] 플러그인을 시작하지 못했습니다.', error);
});
