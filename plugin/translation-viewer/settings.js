import { DEFAULT_PROMPT } from './engine.js';

const SETTINGS_ID = 'risubard-translation-viewer:settings';

export async function registerSettings(api, engine, onSave = () => {}) {
    const controller = new AbortController();
    let disposed = false;
    let visible = false;
    let saving = false;
    let containerTask = Promise.resolve();
    let selectedCharacterId = null;
    const root = document.createElement('main');
    root.className = 'rtv-settings';
    root.setAttribute('aria-labelledby', 'rtv-settings-title');
    root.hidden = true;
    const style = document.createElement('style');
    style.textContent = `
        .rtv-settings { color-scheme: light dark; --surface: #fff; --text: #18212b;
            --muted: #485668; --border: #738095; --accent: #174ea6;
            box-sizing: border-box; background: var(--surface); color: var(--text);
            font: 16px/1.6 system-ui, sans-serif; min-height: 100vh; padding: 24px;
            max-width: 900px; margin: 0 auto; overflow-wrap: anywhere; }
        .rtv-settings[hidden] { display: none; }
        .rtv-settings * { box-sizing: border-box; }
        .rtv-settings h1 { font-size: 1.6rem; margin-top: 0; }
        .rtv-settings label { display: block; font-weight: 600; margin-top: 18px; }
        .rtv-settings input:not([type=checkbox]), .rtv-settings textarea {
            display: block; width: 100%; background: var(--surface); color: var(--text);
            border: 1px solid var(--border); border-radius: 5px; padding: 10px;
            font: inherit; margin-top: 6px; }
        .rtv-settings textarea { min-height: 240px; resize: vertical; }
        .rtv-settings input[type=checkbox] { width: 20px; height: 20px;
            vertical-align: middle; margin-right: 10px; accent-color: var(--accent); }
        .rtv-settings .help { color: var(--muted); font-size: .92rem; margin: 6px 0 12px; }
        .rtv-settings .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
        .rtv-settings button { font: inherit; padding: 9px 16px; border-radius: 5px;
            border: 1px solid var(--border); color: var(--text); background: var(--surface);
            cursor: pointer; min-height: 44px; }
        .rtv-settings .save { background: var(--accent); color: #fff; }
        .rtv-settings button:disabled { opacity: .65; cursor: wait; }
        .rtv-settings :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
        .rtv-settings .status { min-height: 1.6em; white-space: pre-wrap; }
        .rtv-settings .status[data-error=true] { color: #b42318; }
        @media (prefers-color-scheme: dark) {
            .rtv-settings { --surface: #18202b; --text: #f0f3f8; --muted: #c0ccdc;
                --border: #8a9bb2; --accent: #285fb3; }
            .rtv-settings :focus-visible { outline-color: #9bc1ff; }
            .rtv-settings .status[data-error=true] { color: #ffb4ab; }
        }
        @media (max-width: 520px) { .rtv-settings { padding: 16px; } }
    `;
    const element = (tag, text, parent = root) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        parent.append(node);
        return node;
    };
    const title = element('h1', '원문 보존 번역');
    title.id = 'rtv-settings-title';
    element('p', '캐릭터 답변의 번역을 별도로 저장하고 표시합니다. 원문 메시지와 사용자 입력은 변경하지 않습니다.');
    const form = element('section');
    const controls = {};
    const field = (key, label, type, placeholder, help) => {
        const labelNode = element('label', undefined, form);
        const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
        input.id = `rtv-setting-${key}`;
        input.name = key;
        if (type !== 'textarea') input.type = type;
        labelNode.htmlFor = input.id;
        if (type === 'checkbox') {
            labelNode.append(input, document.createTextNode(label));
        } else {
            labelNode.textContent = label;
            form.append(input);
        }
        if (placeholder) input.placeholder = placeholder;
        if (help) {
            const note = element('p', help, form);
            note.className = 'help';
            note.id = `${input.id}-help`;
            input.setAttribute('aria-describedby', note.id);
        }
        controls[key] = input;
        return input;
    };
    field('enabled', '원문 보존 번역 사용 (전체)', 'checkbox');
    const characterEnabled = field('characterEnabled', '이 챗봇에서 번역 사용', 'checkbox', '',
        '설정 창을 열 때 선택한 챗봇의 모든 채팅에 적용합니다. 전체 사용이 켜져 있어야 번역하며, 꺼도 저장된 번역은 삭제하지 않습니다.');
    const characterSummary = element('p', '', form);
    characterSummary.className = 'help';
    characterSummary.id = 'rtv-setting-character-summary';
    characterEnabled.setAttribute('aria-describedby', `${characterEnabled.id}-help ${characterSummary.id}`);
    field('autoTranslate', '새로 완료된 캐릭터 답변만 자동 번역', 'checkbox', '',
        '이전 대화의 번역되지 않은 메시지는 자동 처리하지 않습니다. 해당 메시지의 수동 번역 버튼을 사용하세요.');
    field('model', '번역 모델', 'text', '비워 두면 기본 번역 보조 모델 / [PM] 모델 이름',
        '비워 두면 앱의 현재 번역 보조 모델 선택을 사용합니다. Provider Manager 모델은 정확한 이름인 [PM] 모델 이름 또는 pluginmodel:::[PM] 모델 이름을 입력하세요.');
    field('targetLanguage', '번역할 언어', 'text', 'ko', '예: ko (한국어), en (영어), ja (일본어)');
    field('sourceLanguage', '원문 언어', 'text', 'en', '예: en (영어), ko (한국어)');
    const prompt = field('prompt', '번역 프롬프트', 'textarea', '번역 지시문을 입력하세요.',
        '앱 기본 번역 프롬프트와 동일한 기본값을 사용합니다. 기본 번역 설정의 사용자 지정 프롬프트를 쓰려면 직접 복사해 넣으세요. API 접근 제한으로 기본 설정 및 프리셋과 자동 동기화하지 않습니다.');
    prompt.spellcheck = false;
    element('p', '지원 치환: {{slot}}, {{slot::from}}, {{slot::tnote}}. ChatML에서는 {{slot::content}}와 {{solt::content}}도 지원합니다. 프롬프트와 삽입된 번역가 노트의 토글·조건문은 내장 CBS 파서로 해석합니다. 채팅별 토글 설정도 따르며, setvar·addvar 등 저장 변수 쓰기와 표시 스크립트는 실행하지 않습니다. 번역할 원문 자체는 CBS로 해석하지 않습니다.', form).className = 'help';
    element('p', '번역가의 노트를 보내려면 프롬프트에 {{slot::tnote}}를 넣으세요. 앱 기본 프롬프트에는 이 슬롯이 없습니다. 사용자 지정 내장 프롬프트를 복사하면 그 프롬프트의 슬롯 위치와 토글 조건에 따라 반영됩니다.', form).className = 'help';
    const reset = element('button', '앱 기본 번역 프롬프트로 초기화', form);
    reset.type = 'button';
    element('p', 'runLLMModel API는 기본 번역 프리셋의 maxResponse를 노출하지 않습니다. 요청의 응답 길이 제한은 호스트 모델 설정을 따릅니다.', form).className = 'help';
    element('h2', '사용 안내', form);
    const help = element('ul', undefined, form);
    for (const text of [
        '앱의 내장 자동 번역은 꺼 두세요. 이 플러그인은 별도의 번역 표시와 원문/번역 전환 버튼을 제공합니다.',
        '메시지를 편집할 때는 원문 모드로 전환한 뒤 편집하세요.',
        '원문을 편집해도 저장된 번역은 유지됩니다. 수동 재번역은 현재 원문으로 새 번역을 생성합니다.',
        '번역은 캐릭터·대화·메시지의 고유 ID로 별도 저장합니다. 모델·프롬프트·토글·번역가 노트를 바꿔도 기존 번역은 유지하며, 다시 번역할 때 현재 토글과 노트를 사용합니다.',
    ]) element('li', text, help);
    const actions = element('div', undefined, form);
    actions.className = 'actions';
    const save = element('button', '저장', actions);
    save.type = 'button';
    save.className = 'save';
    const close = element('button', '닫기', actions);
    close.type = 'button';
    const status = element('p', '', form);
    status.className = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const feedback = (text, error = false) => {
        status.textContent = text;
        status.dataset.error = String(error);
    };
    const errorText = error => error instanceof Error ? error.message : String(error);
    const container = operation => {
        containerTask = containerTask.catch(() => {}).then(operation);
        return containerTask;
    };
    const load = async () => {
        for (const [key, input] of Object.entries(controls)) {
            if (input === characterEnabled) continue;
            if (input.type === 'checkbox') input.checked = Boolean(engine.settings[key]);
            else input.value = String(engine.settings[key] ?? '');
        }
        selectedCharacterId = null;
        characterEnabled.checked = true;
        characterEnabled.disabled = true;
        characterSummary.textContent = '챗봇을 선택한 뒤 설정을 다시 열어 주세요. 전체 설정은 저장할 수 있습니다.';
        try {
            const character = await api.getCharacter();
            if (disposed || typeof character?.chaId !== 'string' || !character.chaId.trim()) return;
            selectedCharacterId = character.chaId;
            characterSummary.textContent = `설정 대상: ${character.name || '(이름 없음)'}`;
            characterEnabled.checked = !engine.settings.disabledCharacterIds.includes(selectedCharacterId);
            characterEnabled.disabled = false;
        } catch (error) {
            if (!disposed) characterSummary.textContent = `챗봇 설정을 불러오지 못했습니다: ${errorText(error)}. 전체 설정만 저장할 수 있습니다.`;
        }
    };
    reset.addEventListener('click', () => {
        prompt.value = DEFAULT_PROMPT;
        feedback('앱 기본 번역 프롬프트를 불러왔습니다. 저장을 눌러 적용하세요.');
    }, { signal: controller.signal });
    // API v3 iframes do not allow forms; submission is blocked before submit fires.
    save.addEventListener('click', async () => {
        if (saving || disposed) return;
        saving = true;
        save.disabled = true;
        feedback('저장 중입니다.');
        const settings = { ...engine.settings };
        for (const [key, input] of Object.entries(controls)) {
            if (input === characterEnabled) continue;
            settings[key] = input.type === 'checkbox' ? input.checked : input.value;
        }
        if (selectedCharacterId && !characterEnabled.disabled) {
            const disabled = new Set(settings.disabledCharacterIds);
            if (characterEnabled.checked) disabled.delete(selectedCharacterId);
            else disabled.add(selectedCharacterId);
            settings.disabledCharacterIds = [...disabled];
        }
        try {
            await engine.saveSettings(settings);
            if (!disposed) {
                onSave();
                feedback('설정을 저장했습니다. 기존 번역은 그대로 유지됩니다.');
            }
        } catch (error) {
            if (!disposed) feedback(`저장하지 못했습니다: ${errorText(error)}`, true);
        } finally {
            saving = false;
            save.disabled = false;
        }
    }, { signal: controller.signal });
    const hide = async () => {
        await api.hideContainer();
        visible = false;
        root.hidden = true;
    };
    close.addEventListener('click', async () => {
        try {
            await container(hide);
        } catch (error) {
            if (!disposed) feedback(`닫지 못했습니다: ${errorText(error)}`, true);
        }
    }, { signal: controller.signal });
    document.head.append(style);
    document.body.append(root);
    let registration;
    try {
        registration = await api.registerSetting('원문 보존 번역', async () => {
            if (disposed) return;
            try {
                await container(async () => {
                    if (disposed) return;
                    if (!visible && !saving) {
                        await load();
                        feedback('');
                    }
                    if (disposed) return;
                    root.hidden = false;
                    await api.showContainer('fullscreen');
                    visible = true;
                    controls.enabled.focus();
                });
            } catch (error) {
                if (!disposed) feedback(`설정을 열지 못했습니다: ${errorText(error)}`, true);
            }
        }, '', 'none', SETTINGS_ID);
    } catch (error) {
        disposed = true;
        controller.abort();
        root.remove();
        style.remove();
        throw error;
    }
    return async () => {
        if (disposed) return;
        disposed = true;
        controller.abort();
        try {
            await api.unregisterUIPart(registration.id);
        } finally {
            try {
                await container(async () => {
                    if (visible) await hide();
                });
            } finally {
                root.remove();
                style.remove();
            }
        }
    };
}
