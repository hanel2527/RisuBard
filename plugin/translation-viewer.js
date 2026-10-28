//@name risubard-translation-viewer
//@display-name 원문 보존 번역
//@api 3.0
//@version 1.3.0
// 1.3.0: Journal originals before temporary native display processing; cache rendered HTML/assets, restore before automatic wiki, recover interrupted swaps on startup.
// Built from plugin/translation-viewer/; rebuild with node plugin/translation-viewer/build.mjs.
(function() {
	//#region plugin/translation-viewer/engine.js
	var DEFAULT_PROMPT = "You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.";
	var DEFAULT_SETTINGS = Object.freeze({
		enabled: true,
		autoTranslate: true,
		disabledCharacterIds: Object.freeze([]),
		model: "",
		targetLanguage: "ko",
		sourceLanguage: "en",
		prompt: DEFAULT_PROMPT
	});
	var PREFIX = "risubard-translation-viewer:";
	var SETTINGS_KEY = `${PREFIX}settings`;
	function normalizeSettings(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("번역 설정 형식이 올바르지 않습니다.");
		const settings = { ...DEFAULT_SETTINGS };
		for (const field of ["enabled", "autoTranslate"]) {
			if (typeof value[field] !== "boolean") throw new Error("번역 사용 설정을 확인해 주세요.");
			settings[field] = value[field];
		}
		const disabled = value.disabledCharacterIds === void 0 ? [] : value.disabledCharacterIds;
		if (!Array.isArray(disabled) || disabled.some((id) => typeof id !== "string" || !id.trim())) throw new Error("챗봇별 번역 설정을 확인해 주세요.");
		settings.disabledCharacterIds = Object.freeze([...disabled]);
		for (const [field, label] of [
			["model", "모델"],
			["targetLanguage", "대상 언어"],
			["sourceLanguage", "원본 언어"],
			["prompt", "번역 프롬프트"]
		]) {
			if (typeof value[field] !== "string") throw new Error(`${label}은(는) 문자열이어야 합니다.`);
			settings[field] = field === "prompt" ? value[field] : value[field].trim();
			if (field !== "model" && !settings[field].trim()) throw new Error(`${label}을(를) 입력해 주세요.`);
		}
		if (settings.model.startsWith("[PM]")) settings.model = `pluginmodel:::${settings.model}`;
		if (settings.model === "pluginmodel:::") throw new Error("사용할 모델 이름을 입력해 주세요.");
		return Object.freeze(settings);
	}
	function identity$1(context) {
		const parts = [
			context?.characterId,
			context?.chatId,
			context?.messageId
		];
		if (parts.some((part) => typeof part !== "string" || !part.trim())) return null;
		return `${PREFIX}cache:${JSON.stringify(parts)}`;
	}
	function parseChatML(prompt) {
		const start = "<|im_start|>";
		const separator = "<|im_sep|>";
		const end = "<|im_end|>";
		const trimmed = prompt.trim();
		if (!trimmed.startsWith(start)) return null;
		return trimmed.split(start).filter((part) => part !== "").map((part) => {
			let role = "user";
			for (const candidate of [
				"user",
				"system",
				"assistant"
			]) {
				const boundary = [
					separator,
					" ",
					"\n"
				].find((suffix) => part.startsWith(candidate + suffix));
				if (boundary !== void 0) {
					role = candidate;
					part = part.substring(candidate.length + boundary.length);
					break;
				}
			}
			part = part.trim();
			if (part.endsWith(end)) part = part.substring(0, part.length - 10);
			const thoughts = [];
			part = part.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_, thought) => {
				thoughts.push(thought);
				return "";
			});
			return {
				role,
				content: part,
				thoughts
			};
		});
	}
	async function expandPrompt(api, context, template) {
		const macros = template.replace(/\{\{(?:slot|solt)::content\}\}/g, "");
		if (!/\{\{|<(?:user|char|bot)>/i.test(macros)) return template;
		const messageIndex = async () => {
			const character = await api.getCharacter();
			const chat = character?.chats?.[character.chatPage];
			const index = chat?.message?.findIndex((message) => message.chatId === context.messageId);
			if (character?.chaId !== context.characterId || chat?.id !== context.chatId || !(index >= 0)) throw new Error("번역 대상 채팅으로 돌아온 뒤 다시 번역해 주세요. 다른 채팅의 토글은 사용하지 않습니다.");
			return index;
		};
		const before = await messageIndex();
		const expanded = await api.parseRisuChat(template, {
			messageIndex: before,
			role: "char",
			processRegex: false,
			runVar: false,
			rmVar: true
		});
		if (await messageIndex() !== before) throw new Error("프롬프트 해석 중 메시지 위치가 바뀌었습니다. 다시 번역해 주세요.");
		return expanded;
	}
	async function prepareRequest(api, context, settings) {
		const styles = [];
		const source = context.source.replace(/<risu-style>(.+?)<\/risu-style>/gms, (_, style) => {
			styles.push(style);
			return `<style-data style-index="${styles.length - 1}"></style-data>`;
		});
		const note = typeof context.translatorNote === "string" ? context.translatorNote : "";
		const prompt = await expandPrompt(api, context, settings.prompt.replaceAll("{{slot::from}}", settings.sourceLanguage).replaceAll("{{slot}}", settings.targetLanguage).replaceAll("{{slot::tnote}}", note));
		const chatML = parseChatML(prompt);
		const insertSource = (text) => text.replace(/\{\{(?:slot|solt)::content\}\}/g, () => source);
		return {
			messages: chatML ? chatML.map((message) => ({
				...message,
				content: insertSource(message.content),
				thoughts: message.thoughts.map(insertSource)
			})) : [{
				role: "system",
				content: prompt
			}, {
				role: "user",
				content: source
			}],
			styles
		};
	}
	function recoverStyles(text, styles) {
		return text.replace(/<style-data style-index="(\d+)" ?\/?>/g, (_, index) => styles[Number(index)] ?? "").replace(/<\/style-data>/g, "");
	}
	function errorMessage(error) {
		return `번역하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
	}
	function validEntry(entry) {
		return entry && typeof entry.text === "string" && entry.text.trim() && typeof entry.source === "string" && Number.isFinite(entry.updatedAt);
	}
	async function createEngine(api, onChange = () => {}, render) {
		const storage = await api.getLocalPluginStorage();
		const savedSettings = await storage.getItem(SETTINGS_KEY);
		let settings = normalizeSettings({
			...DEFAULT_SETTINGS,
			...savedSettings ?? {}
		});
		let disabledCharacters = new Set(settings.disabledCharacterIds);
		let disposed = false;
		let generationQueue = Promise.resolve();
		let settingsQueue = Promise.resolve();
		let activeReader = null;
		const cache = /* @__PURE__ */ new Map();
		const reads = /* @__PURE__ */ new Map();
		const pending = /* @__PURE__ */ new Map();
		const errors = /* @__PURE__ */ new Map();
		function isEnabled(characterId) {
			return !disposed && settings.enabled && typeof characterId === "string" && Boolean(characterId) && !disabledCharacters.has(characterId);
		}
		function notify() {
			if (disposed) return;
			try {
				Promise.resolve(onChange()).catch(() => {});
			} catch {}
		}
		async function readEntry(key) {
			if (disposed) return null;
			if (cache.has(key)) return cache.get(key);
			if (reads.has(key)) return reads.get(key);
			const reading = (async () => {
				const stored = await storage.getItem(key);
				if (disposed) return null;
				const entry = validEntry(stored) ? Object.freeze({
					text: stored.text,
					source: stored.source,
					updatedAt: stored.updatedAt,
					...stored.htmlVersion === 1 && typeof stored.html === "string" ? {
						html: stored.html,
						htmlVersion: 1
					} : {}
				}) : null;
				cache.set(key, entry);
				return entry;
			})();
			reads.set(key, reading);
			try {
				return await reading;
			} finally {
				if (!disposed) reads.delete(key);
			}
		}
		async function responseText(response) {
			if (!response || typeof response !== "object") throw new Error("모델 응답 형식이 올바르지 않습니다.");
			if (response.type === "fail") throw new Error(typeof response.result === "string" ? response.result : "모델 요청이 실패했습니다.");
			if (response.type === "success") {
				if (typeof response.result !== "string") throw new Error("모델의 번역 응답이 문자열이 아닙니다.");
				return response.result;
			}
			if (response.type === "multiline") {
				if (!Array.isArray(response.result) || response.result.some((part) => !Array.isArray(part) || !["user", "char"].includes(part[0]) || typeof part[1] !== "string")) throw new Error("모델의 여러 줄 응답 형식이 올바르지 않습니다.");
				return response.result.filter(([role]) => role === "char").map(([, text]) => text).join("\n\n");
			}
			if (response.type !== "streaming" || typeof response.result?.getReader !== "function") throw new Error("지원하지 않는 모델 응답 형식입니다.");
			const reader = response.result.getReader();
			activeReader = reader;
			let text = "";
			try {
				while (!disposed) {
					const chunk = await reader.read();
					if (disposed || chunk.done) break;
					const snapshot = chunk.value;
					if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("모델의 스트리밍 응답 형식이 올바르지 않습니다.");
					const first = Object.hasOwn(snapshot, "0") ? "0" : Object.keys(snapshot)[0];
					if (typeof snapshot[first] !== "string") throw new Error("모델의 스트리밍 번역이 문자열이 아닙니다.");
					text = snapshot[first];
				}
				return text;
			} catch (error) {
				try {
					await reader.cancel();
				} catch {}
				throw error;
			} finally {
				reader.releaseLock();
				if (!disposed) activeReader = null;
			}
		}
		return {
			get settings() {
				return settings;
			},
			key: identity$1,
			isEnabled,
			isBusy(context) {
				return !disposed && pending.has(identity$1(context));
			},
			error(context) {
				return disposed ? "" : errors.get(identity$1(context)) ?? "";
			},
			async saveSettings(value) {
				if (disposed) return;
				const saving = settingsQueue.then(async () => {
					if (disposed) return;
					const next = normalizeSettings(typeof value === "function" ? value(settings) : value);
					try {
						await storage.setItem(SETTINGS_KEY, next);
					} catch (error) {
						try {
							await storage.setItem(SETTINGS_KEY, settings);
						} catch (rollbackError) {
							throw new Error(`${String(error)}; 설정 복구도 실패했습니다: ${String(rollbackError)}`);
						}
						throw error;
					}
					if (disposed) return;
					settings = next;
					disabledCharacters = new Set(next.disabledCharacterIds);
					notify();
				});
				settingsQueue = saving.catch(() => {});
				await saving;
			},
			async get(context) {
				const key = identity$1(context);
				if (!key || disposed) return null;
				try {
					return await readEntry(key);
				} catch (error) {
					if (!disposed) {
						errors.set(key, errorMessage(error));
						notify();
					}
					return null;
				}
			},
			async render(context) {
				return await this.translate(context, { cachedOnly: true });
			},
			async translate(context, { force = false, cachedOnly = false } = {}) {
				const key = identity$1(context);
				if (!key || !isEnabled(context.characterId)) return null;
				if (pending.has(key)) return await pending.get(key);
				const snapshot = { ...context };
				const requestSettings = settings;
				const task = generationQueue.then(async () => {
					if (!isEnabled(snapshot.characterId)) return null;
					let previous = null;
					try {
						previous = await readEntry(key);
						if (!isEnabled(snapshot.characterId)) return null;
						if (cachedOnly && !previous) return null;
						if (previous && !force && (!render || typeof previous.html === "string")) return previous;
						let text = previous?.text;
						let source = previous?.source;
						let updatedAt = previous?.updatedAt;
						if (!previous || force) {
							if (typeof snapshot.source !== "string" || !snapshot.source.trim()) throw new Error("번역할 원문이 없습니다.");
							const { messages, styles } = await prepareRequest(api, snapshot, requestSettings);
							if (!isEnabled(snapshot.characterId)) return null;
							const options = {
								mode: "translate",
								allowPlugins: true,
								messages
							};
							if (requestSettings.model) options.staticModel = requestSettings.model;
							const response = await api.runLLMModel(options);
							if (disposed) {
								if (response?.type === "streaming" && typeof response.result?.cancel === "function") try {
									await response.result.cancel();
								} catch {}
								return null;
							}
							text = recoverStyles(await responseText(response), styles);
							source = snapshot.source;
							updatedAt = Date.now();
						}
						if (disposed) return null;
						if (!text.trim()) throw new Error("모델이 빈 번역을 반환했습니다.");
						let html;
						if (render && isEnabled(snapshot.characterId)) {
							html = await render(snapshot, text);
							if (typeof html !== "string") throw new Error("표시 후처리 결과가 올바르지 않습니다.");
						}
						if (disposed) return null;
						const entry = Object.freeze({
							text,
							source,
							updatedAt,
							...html === void 0 ? {} : {
								html,
								htmlVersion: 1
							}
						});
						try {
							await storage.setItem(key, entry);
						} catch (error) {
							try {
								if (previous) await storage.setItem(key, previous);
								else await storage.removeItem(key);
							} catch (rollbackError) {
								throw new Error(`${errorMessage(error)}; 캐시 복구도 실패했습니다: ${String(rollbackError)}`);
							}
							throw error;
						}
						if (disposed) return null;
						cache.set(key, entry);
						errors.delete(key);
						return entry;
					} catch (error) {
						if (disposed) return null;
						errors.set(key, errorMessage(error));
						return previous;
					}
				});
				pending.set(key, task);
				errors.delete(key);
				generationQueue = task.catch(() => {});
				notify();
				try {
					return await task;
				} finally {
					if (!disposed) {
						pending.delete(key);
						notify();
					}
				}
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				if (activeReader) {
					const reader = activeReader;
					(async () => {
						try {
							await reader.cancel();
						} catch {}
					})();
				}
				cache.clear();
				reads.clear();
				pending.clear();
				errors.clear();
				activeReader = null;
			}
		};
	}
	//#endregion
	//#region plugin/translation-viewer/settings.js
	var SETTINGS_ID = "risubard-translation-viewer:settings";
	async function registerSettings(api, engine, onSave = () => {}) {
		const controller = new AbortController();
		let disposed = false;
		let visible = false;
		let saving = false;
		let containerTask = Promise.resolve();
		let selectedCharacterId = null;
		let characterDirty = false;
		const root = document.createElement("main");
		root.className = "rtv-settings";
		root.setAttribute("aria-labelledby", "rtv-settings-title");
		root.hidden = true;
		const style = document.createElement("style");
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
			if (text !== void 0) node.textContent = text;
			parent.append(node);
			return node;
		};
		const title = element("h1", "원문 보존 번역");
		title.id = "rtv-settings-title";
		element("p", "캐릭터 답변의 원문과 번역을 별도로 보관합니다. 본체 후처리를 위해 번역문을 메시지에 잠시 넣은 뒤 원문을 복구합니다. 사용자 입력은 번역하지 않습니다.");
		const form = element("section");
		const controls = {};
		const field = (key, label, type, placeholder, help) => {
			const labelNode = element("label", void 0, form);
			const input = document.createElement(type === "textarea" ? "textarea" : "input");
			input.id = `rtv-setting-${key}`;
			input.name = key;
			if (type !== "textarea") input.type = type;
			labelNode.htmlFor = input.id;
			if (type === "checkbox") labelNode.append(input, document.createTextNode(label));
			else {
				labelNode.textContent = label;
				form.append(input);
			}
			if (placeholder) input.placeholder = placeholder;
			if (help) {
				const note = element("p", help, form);
				note.className = "help";
				note.id = `${input.id}-help`;
				input.setAttribute("aria-describedby", note.id);
			}
			controls[key] = input;
			return input;
		};
		field("enabled", "원문 보존 번역 사용 (전체)", "checkbox");
		const characterEnabled = field("characterEnabled", "이 챗봇에서 번역 사용", "checkbox", "", "설정 창을 열 때 선택한 챗봇의 모든 채팅에 적용합니다. 채팅 사이드바의 프리셋 고정 제목 옆 번역 버튼으로도 즉시 변경할 수 있습니다. 해당 영역이 숨겨지거나 없으면 이동 가능한 번역 버튼이 표시되며 위치는 본체가 저장합니다. 전체 사용이 꺼진 상태에서 버튼을 누르면 이 설정을 엽니다. 꺼도 저장된 번역은 삭제하지 않습니다.");
		const characterSummary = element("p", "", form);
		characterSummary.className = "help";
		characterSummary.id = "rtv-setting-character-summary";
		characterEnabled.setAttribute("aria-describedby", `${characterEnabled.id}-help ${characterSummary.id}`);
		characterEnabled.addEventListener("change", () => {
			characterDirty = true;
		}, { signal: controller.signal });
		field("autoTranslate", "새로 완료된 캐릭터 답변만 자동 번역", "checkbox", "", "열어 둔 대화에서는 답변 확정 이벤트 안에서 번역을 먼저 마친 뒤 후속 자동 바드위키 작업으로 넘깁니다. 자동 이어쓰기는 확정된 각 구간마다 번역 요청이 발생하며, 같은 메시지의 최종 번역으로 갱신합니다. 다른 대화의 답변은 해당 대화를 열 때 처리합니다. 이전 대화의 미번역 메시지는 수동 번역 버튼을 사용하세요.");
		field("model", "번역 모델", "text", "비워 두면 기본 번역 보조 모델 / [PM] 모델 이름", "비워 두면 앱의 현재 번역 보조 모델 선택을 사용합니다. Provider Manager 모델은 정확한 이름인 [PM] 모델 이름 또는 pluginmodel:::[PM] 모델 이름을 입력하세요.");
		field("targetLanguage", "번역할 언어", "text", "ko", "예: ko (한국어), en (영어), ja (일본어)");
		field("sourceLanguage", "원문 언어", "text", "en", "예: en (영어), ko (한국어)");
		const prompt = field("prompt", "번역 프롬프트", "textarea", "번역 지시문을 입력하세요.", "앱 기본 번역 프롬프트와 동일한 기본값을 사용합니다. 기본 번역 설정의 사용자 지정 프롬프트를 쓰려면 직접 복사해 넣으세요. API 접근 제한으로 기본 설정 및 프리셋과 자동 동기화하지 않습니다.");
		prompt.spellcheck = false;
		element("p", "지원 치환: {{slot}}, {{slot::from}}, {{slot::tnote}}. ChatML에서는 {{slot::content}}와 {{solt::content}}도 지원합니다. 프롬프트와 삽입된 번역가 노트의 토글·조건문은 내장 CBS 파서로 해석하며 채팅별 토글을 따릅니다. 프롬프트 생성에서는 setvar·addvar 등 저장 변수 쓰기와 표시 스크립트를 실행하지 않고, 번역 요청에 넣는 원문도 CBS로 해석하지 않습니다. 번역문 표시 후처리는 별도로 본체에서 실행하므로 해당 스크립트의 변수 변경 등 부작용은 발생할 수 있습니다.", form).className = "help";
		element("p", "번역가의 노트를 보내려면 프롬프트에 {{slot::tnote}}를 넣으세요. 앱 기본 프롬프트에는 이 슬롯이 없습니다. 사용자 지정 내장 프롬프트를 복사하면 그 프롬프트의 슬롯 위치와 토글 조건에 따라 반영됩니다.", form).className = "help";
		const reset = element("button", "앱 기본 번역 프롬프트로 초기화", form);
		reset.type = "button";
		element("p", "runLLMModel API는 기본 번역 프리셋의 maxResponse를 노출하지 않습니다. 요청의 응답 길이 제한은 호스트 모델 설정을 따릅니다.", form).className = "help";
		element("h2", "사용 안내", form);
		const help = element("ul", void 0, form);
		for (const text of [
			"앱의 내장 자동 번역은 꺼 두세요. 이 플러그인은 별도의 번역 표시와 원문/번역 전환 버튼을 제공합니다.",
			"메시지를 편집할 때는 원문 모드로 전환한 뒤 편집하세요.",
			"원문을 편집해도 저장된 번역은 유지됩니다. 수동 재번역은 현재 원문으로 새 번역을 생성합니다.",
			"번역은 캐릭터·대화·메시지의 고유 ID로 별도 저장합니다. 모델·프롬프트·토글·번역가 노트를 바꿔도 기존 번역은 유지하며, 다시 번역할 때 현재 토글과 노트를 사용합니다.",
			"번역 → 원문 영구 백업 → 번역문 임시 삽입 → 본체 표시 정규식·Lua·어셋 처리 → HTML 확보 → 원문 복구 순서로 처리합니다. 본체의 저장소·메인 화면 접근 권한이 필요합니다. 표시 후처리가 번역문과 복구된 원문에 각각 실행되므로, 표시 스크립트의 부작용이 없다고 보장하지는 않습니다.",
			"자동 바드위키 후속 작업은 이 번역 작업 뒤에 진행합니다. 일시적인 원문 저장 실패는 복구될 때까지 재시도하며 후속 작업을 기다리게 합니다. 모델·후처리 실패 시 기존 번역은 유지합니다. 이미 실행 중인 바드위키 요청은 중단하지 않습니다.",
			"주의: 임시 번역문이 본체 자동 저장에 포함될 수 있습니다. 브라우저 종료·충돌 때는 즉시 복구를 보장할 수 없으며, 다음 실행에서 이 플러그인을 켜야 백업으로 복구합니다. 처리 중에는 다른 탭·기기에서 같은 대화를 편집하거나 내보내지 마세요. 본체에 저장 잠금·원자적 교체 API가 없어 동시 수정 충돌을 완전히 막을 수 없습니다.",
			"복구 백업은 이 기기의 플러그인 저장소에 계속 보관합니다. 본체의 디스크 저장 완료를 확인할 API가 없어 성공 후에도 자동 삭제하지 않습니다. 복구 전에는 플러그인 저장소를 지우지 마세요. 대상이 삭제되거나 ID가 모호하면 백업을 남기고 오류를 표시하며, 표식 없는 후속 편집은 덮어쓰지 않습니다. 보관량은 번역 횟수와 어셋 크기에 따라 증가합니다.",
			"번역문은 후처리된 정적 HTML로 표시합니다. 어셋 이미지·인레이는 별도로 보존하지만, 본체 전용 클릭 동작·동적 스크립트 UI까지 복제하지는 않습니다. 기존 버전의 번역은 모델을 다시 호출하지 않고 표시 후처리만 추가합니다.",
			"처리 중에는 대상 메시지 편집을 잠시 막습니다. 화면·대상 메시지가 바뀌거나 렌더 완료를 확인할 수 없으면 원문을 복구하고 오류를 표시합니다. 복잡한 본문 CBS나 원문과 같은 번역 결과는 새 렌더를 구분할 수 없어 안전하게 중단할 수 있습니다. 오류를 확인한 뒤 수동 재번역할 수 있습니다."
		]) element("li", text, help);
		const actions = element("div", void 0, form);
		actions.className = "actions";
		const save = element("button", "저장", actions);
		save.type = "button";
		save.className = "save";
		const close = element("button", "닫기", actions);
		close.type = "button";
		const status = element("p", "", form);
		status.className = "status";
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		const feedback = (text, error = false) => {
			status.textContent = text;
			status.dataset.error = String(error);
		};
		const errorText = (error) => error instanceof Error ? error.message : String(error);
		const container = (operation) => {
			containerTask = containerTask.catch(() => {}).then(operation);
			return containerTask;
		};
		const refreshPreference = () => {
			if (!selectedCharacterId || characterDirty || saving) return;
			characterEnabled.checked = !engine.settings.disabledCharacterIds.includes(selectedCharacterId);
		};
		const load = async () => {
			for (const [key, input] of Object.entries(controls)) {
				if (input === characterEnabled) continue;
				if (input.type === "checkbox") input.checked = Boolean(engine.settings[key]);
				else input.value = String(engine.settings[key] ?? "");
			}
			selectedCharacterId = null;
			characterDirty = false;
			characterEnabled.checked = true;
			characterEnabled.disabled = true;
			characterSummary.textContent = "챗봇을 선택한 뒤 설정을 다시 열어 주세요. 전체 설정은 저장할 수 있습니다.";
			try {
				const character = await api.getCharacter();
				if (disposed || typeof character?.chaId !== "string" || !character.chaId.trim()) return;
				selectedCharacterId = character.chaId;
				characterSummary.textContent = `설정 대상: ${character.name || "(이름 없음)"}`;
				characterEnabled.checked = !engine.settings.disabledCharacterIds.includes(selectedCharacterId);
				characterEnabled.disabled = false;
			} catch (error) {
				if (!disposed) characterSummary.textContent = `챗봇 설정을 불러오지 못했습니다: ${errorText(error)}. 전체 설정만 저장할 수 있습니다.`;
			}
		};
		reset.addEventListener("click", () => {
			prompt.value = DEFAULT_PROMPT;
			feedback("앱 기본 번역 프롬프트를 불러왔습니다. 저장을 눌러 적용하세요.");
		}, { signal: controller.signal });
		save.addEventListener("click", async () => {
			if (saving || disposed) return;
			saving = true;
			save.disabled = true;
			feedback("저장 중입니다.");
			const fields = {};
			for (const [key, input] of Object.entries(controls)) {
				if (input === characterEnabled) continue;
				fields[key] = input.type === "checkbox" ? input.checked : input.value;
			}
			const preferenceId = characterDirty && !characterEnabled.disabled ? selectedCharacterId : null;
			const useTranslation = characterEnabled.checked;
			try {
				await engine.saveSettings((current) => {
					const next = {
						...current,
						...fields
					};
					if (preferenceId) {
						const disabled = new Set(current.disabledCharacterIds);
						if (useTranslation) disabled.delete(preferenceId);
						else disabled.add(preferenceId);
						next.disabledCharacterIds = [...disabled];
					}
					return next;
				});
				if (!disposed) {
					characterDirty = false;
					onSave();
					feedback("설정을 저장했습니다. 기존 번역은 그대로 유지됩니다.");
				}
			} catch (error) {
				if (!disposed) feedback(`저장하지 못했습니다: ${errorText(error)}`, true);
			} finally {
				saving = false;
				save.disabled = false;
				refreshPreference();
			}
		}, { signal: controller.signal });
		const hide = async () => {
			await api.hideContainer();
			visible = false;
			root.hidden = true;
		};
		close.addEventListener("click", async () => {
			try {
				await container(hide);
			} catch (error) {
				if (!disposed) feedback(`닫지 못했습니다: ${errorText(error)}`, true);
			}
		}, { signal: controller.signal });
		document.head.append(style);
		document.body.append(root);
		let registration;
		const open = async () => {
			if (disposed) return;
			try {
				await container(async () => {
					if (disposed) return;
					if (!visible && !saving) {
						await load();
						feedback("");
					}
					if (disposed) return;
					root.hidden = false;
					await api.showContainer("fullscreen");
					visible = true;
					controls.enabled.focus();
				});
			} catch (error) {
				if (!disposed) feedback(`설정을 열지 못했습니다: ${errorText(error)}`, true);
			}
		};
		try {
			registration = await api.registerSetting("원문 보존 번역", open, "", "none", SETTINGS_ID);
		} catch (error) {
			disposed = true;
			controller.abort();
			root.remove();
			style.remove();
			throw error;
		}
		const dispose = async () => {
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
		return {
			open,
			refreshPreference,
			dispose
		};
	}
	//#endregion
	//#region plugin/translation-viewer/quick-toggle.js
	var BUTTON_ID = "risubard-translation-viewer:toggle";
	var MARK = "x-rtv-quick-heading";
	var HEADING = "[data-current-chat-section] ~ div > div.text-\\[11px\\]:has(+ div.items-stretch .lucide-folder-heart)";
	var release$1 = (object) => {
		object?.release?.();
	};
	var quickToggleCSS = `
[${MARK}]:not([${MARK}=""]) { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.rtv-quick { flex-shrink: 0; margin-inline-start: auto; }
.rtv-quick button { font: inherit; font-size: 12px; padding: 4px 8px; border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
.rtv-quick button[aria-pressed="true"] { color: var(--color-success, currentColor); }
.rtv-quick button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.rtv-quick button:disabled { opacity: .6; cursor: wait; }
[data-plugin-fab$=":${BUTTON_ID}"] > div { width: auto; height: auto; white-space: nowrap; font-size: 13px; }
`;
	function createQuickToggle(api, doc, engine, { readSelection, onChange, openSettings, reportError }) {
		let disposed = false;
		let busy = false;
		let mounted = null;
		let floating = null;
		let floatingState = "";
		let sequence = 0;
		async function clearInline() {
			const old = mounted;
			mounted = null;
			if (!old) return;
			await Promise.allSettled([
				old.heading.setAttribute(MARK, ""),
				old.wrapper.remove(),
				old.button?.removeEventListener("click", old.listener)
			]);
			for (const element of [
				old.heading,
				old.wrapper,
				old.button
			]) release$1(element);
		}
		async function clearFloating() {
			if (!floating) return;
			await api.unregisterUIPart(floating.id);
			floating = null;
			floatingState = "";
		}
		async function findHeading() {
			const safe = await doc.querySelectorAll(HEADING);
			const candidates = await api.unwarpSafeArray(safe);
			release$1(safe);
			let found = null;
			try {
				const width = await doc.clientWidth();
				const height = await doc.clientHeight();
				for (const candidate of candidates) {
					const rect = await candidate.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height) {
						found = candidate;
						break;
					}
				}
				return found;
			} finally {
				for (const candidate of candidates) if (candidate !== found) release$1(candidate);
			}
		}
		async function toggle(characterId) {
			if (disposed || busy) return;
			busy = true;
			onChange();
			try {
				const current = await readSelection();
				if (disposed || current?.character.chaId !== characterId) return;
				if (!engine.settings.enabled) {
					await openSettings();
					return;
				}
				await engine.saveSettings((settings) => {
					const disabled = new Set(settings.disabledCharacterIds);
					if (disabled.has(characterId)) disabled.delete(characterId);
					else disabled.add(characterId);
					return {
						...settings,
						disabledCharacterIds: [...disabled]
					};
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
				if (!characterId || characterId === "§playground") {
					await clearInline();
					await clearFloating();
					return;
				}
				const enabled = engine.isEnabled(characterId);
				const label = busy ? "저장 중…" : !engine.settings.enabled ? "번역 전체 꺼짐" : enabled ? "번역 켜짐" : "번역 꺼짐";
				const title = !engine.settings.enabled ? "전체 번역이 꺼져 있습니다. 설정 열기" : "이 챗봇의 모든 채팅에서 번역 켜기/끄기 · 저장된 번역은 유지됩니다";
				const state = JSON.stringify([characterId, label]);
				let heading = await findHeading();
				try {
					if (disposed) return;
					if (heading) {
						await clearFloating();
						const child = await heading.querySelector(".rtv-quick");
						const retained = mounted && child && await heading.getAttribute(MARK) === mounted.token;
						release$1(child);
						if (!retained) {
							await clearInline();
							const wrapper = await doc.createElement("span");
							mounted = {
								heading,
								wrapper,
								token: `rtv-${++sequence}`,
								state: "",
								button: null,
								listener: null
							};
							heading = null;
							await wrapper.setClassName("rtv-quick");
							await mounted.heading.setAttribute(MARK, mounted.token);
							await mounted.heading.appendChild(wrapper);
						}
						if (mounted.state !== state) {
							if (mounted.characterId !== characterId) mounted.restoreFocus = false;
							if (mounted.button) {
								if (mounted.characterId === characterId && await mounted.button.matches(":focus")) mounted.restoreFocus = true;
								await mounted.button.removeEventListener("click", mounted.listener);
								release$1(mounted.button);
							}
							await mounted.wrapper.setInnerHTML(`<button type="button" title="${title}" aria-pressed="${enabled}" ${busy ? "disabled" : ""}>${label}</button>`);
							mounted.button = await mounted.wrapper.querySelector("button");
							mounted.listener = await mounted.button.addEventListener("click", () => {
								toggle(characterId);
							});
							mounted.state = state;
							mounted.characterId = characterId;
							if (mounted.restoreFocus && !busy) {
								const focused = await doc.querySelector(":focus");
								try {
									if (!focused || await focused.matches("body")) await mounted.button.focus();
								} finally {
									release$1(focused);
									mounted.restoreFocus = false;
								}
							}
						}
					} else {
						await clearInline();
						if (floatingState !== state) {
							floating = await api.registerButton({
								id: BUTTON_ID,
								location: "action",
								name: `${label} — ${title}`,
								iconType: "html",
								icon: `<span>${label}</span>`
							}, () => {
								toggle(characterId);
							});
							floatingState = state;
						}
					}
				} finally {
					release$1(heading);
					if (disposed) {
						await clearInline();
						await clearFloating();
					}
				}
			},
			async dispose() {
				disposed = true;
				await Promise.allSettled([clearInline(), clearFloating()]);
			}
		};
	}
	//#endregion
	//#region plugin/translation-viewer/message-swap.js
	var MESSAGE_SWAP_JOURNAL_KEY = "risubard-translation-viewer:message-swap-journal";
	var TEMPORARY_MARK = "risubardTranslationViewerSwap";
	var RETRY_MS = 100;
	var identity = (context) => JSON.stringify([
		context.characterId,
		context.chatId,
		context.messageId
	]);
	var hasId = (value) => typeof value === "string" && value.length > 0;
	var messageOf = (error) => error instanceof Error ? error.message : String(error);
	var abortError = () => Object.assign(/* @__PURE__ */ new Error("Message rendering was cancelled."), { name: "AbortError" });
	var failure = (code, message) => Object.assign(new Error(message), { code });
	function validateJournal(value) {
		if (value === null || value === void 0) return {
			version: 1,
			entries: []
		};
		if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Unsupported message backup journal; it has not been overwritten.");
		const tokens = /* @__PURE__ */ new Set();
		for (const entry of value.entries) {
			if (!entry || ![
				entry.token,
				entry.characterId,
				entry.chatId,
				entry.messageId
			].every(hasId) || typeof entry.original !== "string" || typeof entry.temporary !== "string" || !Array.isArray(entry.displaced) || entry.displaced.some((text) => typeof text !== "string") || tokens.has(entry.token)) throw new Error("Invalid message backup journal; it has not been overwritten.");
			tokens.add(entry.token);
		}
		return value;
	}
	/**
	* Temporary native-render transaction, using only public plugin APIs.
	*
	* The journal is append-only: setChatToIndex acknowledges an in-memory update,
	* NOT a durable chat save. Even successfully restored records must survive a
	* restart that loads an older autosave carrying their marker. Without a host
	* save acknowledgement there is no safe time-based compaction rule.
	*
	* The host setters replace a whole chat and have no CAS/save lock. We resolve
	* stable IDs and use a fresh snapshot immediately before every write, changing
	* only data and our marker. A reorder/edit between that last read and the setter
	* is still an unavoidable plugin-API race. The marker proves ownership, not the
	* author of later text changes; displaced marked text is backed up before it is
	* restored, including native-script output or a concurrent user's edit.
	*/
	async function createMessageSwap(api, onChange = () => {}) {
		const storage = await api.getLocalPluginStorage();
		let journal;
		let journalDirty = false;
		let queue = Promise.resolve();
		let pending = 0;
		let disposed = false;
		let active = null;
		let phase = "idle";
		let error = "";
		let unavailable = 0;
		let conflicts = 0;
		let sequence = 0;
		const session = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		function notify() {
			try {
				Promise.resolve(onChange()).catch(() => {});
			} catch {}
		}
		function setPhase(value) {
			phase = value;
			notify();
		}
		function status() {
			return {
				phase,
				retained: journal?.entries.length ?? 0,
				unavailable,
				conflicts,
				error
			};
		}
		function enqueue(work) {
			pending++;
			notify();
			const result = queue.then(work).finally(() => {
				pending--;
				notify();
			});
			queue = result.catch(() => {});
			return result;
		}
		async function loadJournal() {
			if (!journal) {
				journal = validateJournal(await storage.getItem(MESSAGE_SWAP_JOURNAL_KEY));
				journalDirty = journal.entries.length > 0;
			}
		}
		async function publish(next = journal) {
			journal = next;
			journalDirty = true;
			await storage.setItem(MESSAGE_SWAP_JOURNAL_KEY, next);
			journalDirty = false;
		}
		async function locate(context) {
			for (let attempt = 0; attempt < 3; attempt++) {
				const database = await api.getDatabase(["characters"]);
				if (!database?.characters) throw new Error("Cannot read the database to locate the original message.");
				const matches = Object.values(database.characters).flatMap((character, index) => character?.chaId === context.characterId ? [index] : []);
				if (matches.length !== 1) throw failure(matches.length ? "conflict" : "unavailable", matches.length ? "Character ID is ambiguous; original backup retained." : "Character is missing; original backup retained.");
				const characterIndex = matches[0];
				const character = await api.getCharacterFromIndex(characterIndex);
				if (character?.chaId !== context.characterId) continue;
				const chats = character.chats;
				const chatMatches = Array.isArray(chats) ? chats.flatMap((chat, index) => chat?.id === context.chatId ? [index] : []) : [];
				if (chatMatches.length !== 1) throw failure(chatMatches.length ? "conflict" : "unavailable", chatMatches.length ? "Chat ID is ambiguous; original backup retained." : "Chat is missing; original backup retained.");
				const chatIndex = chatMatches[0];
				const chat = chats[chatIndex];
				if (chat._placeholder || !Array.isArray(chat.message)) throw failure("unavailable", "Chat is not hydrated; original backup retained.");
				const messageMatches = chat.message.flatMap((message, index) => message?.chatId === context.messageId ? [index] : []);
				if (messageMatches.length !== 1) throw failure(messageMatches.length ? "conflict" : "unavailable", messageMatches.length ? "Message ID is ambiguous; original backup retained." : "Message is missing; original backup retained.");
				const messageIndex = messageMatches[0];
				return {
					characterIndex,
					chatIndex,
					messageIndex,
					chat,
					message: chat.message[messageIndex]
				};
			}
			throw new Error("Character ordering changed repeatedly; no message was written.");
		}
		async function restoreOnce(entry) {
			for (;;) {
				const target = await locate(entry);
				const marker = target.message[TEMPORARY_MARK];
				if (marker !== entry.token) {
					if (marker !== void 0) throw failure("conflict", "Message ownership changed; original backup retained.");
					if (target.message.data === entry.original) return target;
					if (target.message.data === entry.temporary) throw failure("temporary", "Temporary text lost its ownership marker; waiting for safe restoration.");
					throw failure("changed", "Message was edited outside the transaction; that edit was preserved and the original backup retained.");
				}
				const current = journal.entries.find((item) => item.token === entry.token);
				const text = target.message.data;
				if (typeof text !== "string") throw failure("conflict", "Marked message text is invalid; original backup retained.");
				if (text !== entry.original && text !== entry.temporary && !current.displaced.includes(text)) {
					await publish({
						version: 1,
						entries: journal.entries.map((item) => item.token === entry.token ? {
							...item,
							displaced: [...item.displaced, text]
						} : item)
					});
					continue;
				}
				if (journalDirty) {
					await publish();
					continue;
				}
				target.message.data = entry.original;
				delete target.message[TEMPORARY_MARK];
				await api.setChatToIndex(target.characterIndex, target.chatIndex, target.chat);
				const restored = await locate(entry);
				if (restored.message.data !== entry.original || restored.message["risubardTranslationViewerSwap"] !== void 0) throw new Error("The original message restoration was not acknowledged by the chat API.");
				return restored;
			}
		}
		async function recoverJournal(onlyContext) {
			setPhase("recovering");
			error = "";
			unavailable = 0;
			conflicts = 0;
			try {
				await loadJournal();
				const groups = /* @__PURE__ */ new Map();
				const byToken = new Map(journal.entries.map((entry) => [entry.token, entry]));
				for (const entry of journal.entries) if (!onlyContext || identity(entry) === identity(onlyContext)) groups.set(identity(entry), entry);
				for (const context of groups.values()) {
					if (disposed) break;
					try {
						const marker = (await locate(context)).message[TEMPORARY_MARK];
						if (marker === void 0) continue;
						const entry = byToken.get(marker);
						if (!entry || identity(entry) !== identity(context)) throw failure("conflict", "Unknown message swap marker; original backups retained.");
						await restoreOnce(entry);
					} catch (cause) {
						if (cause.code === "unavailable") unavailable++;
						else conflicts++;
						error = messageOf(cause);
					}
				}
			} catch (cause) {
				error = messageOf(cause);
				setPhase("blocked");
				throw cause;
			}
			setPhase(disposed ? "disposed" : conflicts ? "blocked" : "idle");
			return status();
		}
		async function waitForRetry(signal) {
			if (signal.aborted) return;
			await new Promise((resolve) => {
				const done = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, RETRY_MS);
				signal.addEventListener("abort", done, { once: true });
			});
		}
		async function restoreActive(transaction) {
			for (;;) try {
				return await restoreOnce(transaction.entry);
			} catch (cause) {
				error = `Original restoration pending: ${messageOf(cause)}`;
				notify();
				if (disposed || ["unavailable", "changed"].includes(cause.code)) throw cause;
				await waitForRetry(transaction.controller.signal);
			}
		}
		async function captureUntilAbort(transaction, capture, target) {
			const { signal } = transaction.controller;
			if (signal.aborted) throw abortError();
			let onAbort;
			const cancelled = new Promise((_, reject) => {
				onAbort = () => reject(abortError());
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				return await Promise.race([Promise.resolve().then(() => {
					if (signal.aborted) throw abortError();
					return capture({
						signal,
						token: transaction.entry.token,
						target: {
							characterIndex: target.characterIndex,
							chatIndex: target.chatIndex,
							messageIndex: target.messageIndex
						}
					});
				}), cancelled]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
		async function runTransaction(context, temporaryText, capture) {
			if (disposed) throw abortError();
			if (![
				context?.characterId,
				context?.chatId,
				context?.messageId
			].every(hasId) || typeof context.source !== "string" || typeof temporaryText !== "string" || typeof capture !== "function") throw new Error("Stable character/chat/message IDs, source, temporary text and a capture callback are required.");
			if (temporaryText === context.source) throw new Error("The translation equals the source; a fresh native render cannot be confirmed.");
			await recoverJournal(context);
			if (disposed) throw abortError();
			const initial = await locate(context);
			if (initial.message.data !== context.source || initial.message["risubardTranslationViewerSwap"] !== void 0) throw new Error("The source message changed or still needs recovery; no temporary message was written.");
			const entry = {
				token: `${session}:${++sequence}`,
				characterId: context.characterId,
				chatId: context.chatId,
				messageId: context.messageId,
				original: initial.message.data,
				temporary: temporaryText,
				displaced: [],
				createdAt: Date.now()
			};
			const transaction = {
				entry,
				controller: new AbortController(),
				mayHaveWritten: false
			};
			active = transaction;
			let result;
			let cause;
			try {
				setPhase("backing-up");
				await publish({
					version: 1,
					entries: [...journal.entries, entry]
				});
				if (disposed) throw abortError();
				const target = await locate(entry);
				if (disposed) throw abortError();
				if (target.message.data !== entry.original || target.message["risubardTranslationViewerSwap"] !== void 0) throw new Error("The source changed during backup; no temporary message was written.");
				target.message.data = temporaryText;
				target.message[TEMPORARY_MARK] = entry.token;
				transaction.mayHaveWritten = true;
				await api.setChatToIndex(target.characterIndex, target.chatIndex, target.chat);
				const written = await locate(entry);
				if (written.message["risubardTranslationViewerSwap"] !== entry.token) throw new Error("The temporary message write was not acknowledged by the chat API.");
				setPhase("capturing");
				result = await captureUntilAbort(transaction, capture, written);
			} catch (caught) {
				cause = caught;
			} finally {
				if (transaction.mayHaveWritten) {
					setPhase("restoring");
					try {
						await restoreActive(transaction);
					} catch (restorationError) {
						cause = restorationError;
					}
				}
				active = null;
				if (disposed && !cause) cause = abortError();
				error = cause ? messageOf(cause) : "";
				setPhase(disposed ? "disposed" : cause ? "blocked" : "idle");
			}
			if (cause) throw cause;
			return result;
		}
		await recoverJournal().catch(() => {});
		return {
			run(context, temporaryText, capture) {
				const snapshot = context && { ...context };
				return enqueue(async () => {
					try {
						return await runTransaction(snapshot, temporaryText, capture);
					} catch (cause) {
						error = messageOf(cause);
						setPhase(disposed ? "disposed" : "blocked");
						throw cause;
					}
				});
			},
			recover() {
				return enqueue(() => disposed ? status() : recoverJournal());
			},
			dispose() {
				disposed = true;
				active?.controller.abort();
				setPhase("disposed");
				return queue.then(status);
			},
			original(context) {
				return active && context && identity(active.entry) === identity(context) ? active.entry.original : void 0;
			},
			get busy() {
				return pending > 0;
			},
			get error() {
				return error;
			},
			get status() {
				return status();
			}
		};
	}
	//#endregion
	//#region plugin/translation-viewer/native-render.js
	var BODY_STAMP = "x-rtv-capture";
	var PROBE = "x-rtv-render-probe";
	var TIMEOUT = 3e4;
	var release = (value) => {
		value?.release?.();
	};
	var cancelled = () => /* @__PURE__ */ new Error("표시 후처리가 중단되었습니다. 원문을 복구합니다.");
	var rowSelector$1 = (index, id) => `.risu-chat[data-chat-index="${index}"][data-chat-id="${CSS.escape(id)}"]`;
	function pause(signal, milliseconds = 60) {
		if (signal.aborted) return Promise.reject(cancelled());
		return new Promise((resolve, reject) => {
			const abort = () => {
				clearTimeout(timer);
				reject(cancelled());
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, milliseconds);
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	function literalDisplayInput(text) {
		return !/\{\{|\{#|<(?:user|char|bot)>/i.test(text.replace(/\{\{(?:asset|emotion|audio|bg|bgm|video|video-img|image|img|path|raw|inlay|inlayed|inlayeddata|source)::[^{}]*\}\}/gi, ""));
	}
	var htmlDocument;
	function parseHTML(html) {
		htmlDocument ??= document.implementation.createHTMLDocument("");
		const body = htmlDocument.createElement("div");
		body.innerHTML = html;
		return body;
	}
	function nativeAssetKey(url) {
		const match = url.match(/^(?:https?:\/\/[^/]+)?\/(?:api\/asset|sw\/img)\/([a-f\d]+)(?:[?#].*)?$/i);
		if (!match || match[1].length % 2) return null;
		return new TextDecoder().decode(Uint8Array.from(match[1].match(/../g), (byte) => parseInt(byte, 16)));
	}
	function dataURL(bytes, type) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = () => reject(/* @__PURE__ */ new Error("어셋 데이터를 읽지 못했습니다."));
			reader.readAsDataURL(new Blob([bytes], { type }));
		});
	}
	async function materialize(api, html, signal) {
		const body = parseHTML(html);
		const resources = /* @__PURE__ */ new Map();
		const inlays = /* @__PURE__ */ new Map();
		const readInlay = (id) => {
			if (!inlays.has(id)) inlays.set(id, (async () => {
				const asset = await api.readInlay(id);
				if (!asset || typeof asset.data !== "string" || !asset.data.startsWith("data:")) throw new Error("인레이를 읽지 못했습니다. 인레이 접근 권한과 원본 파일을 확인해 주세요.");
				return asset;
			})());
			return inlays.get(id);
		};
		const resource = async (url) => {
			if (signal.aborted) throw cancelled();
			if (!url || /^(?:data:|https?:|\/)/i.test(url) && !nativeAssetKey(url)) return url;
			if (!resources.has(url)) resources.set(url, (async () => {
				const key = nativeAssetKey(url);
				if (key?.startsWith("inlay/")) return (await readInlay(key.slice(6))).data;
				if (key?.startsWith("assets/")) {
					const bytes = await api.readImage(key);
					if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error("어셋 파일을 읽지 못했습니다.");
					return await dataURL(bytes, {
						jpg: "image/jpeg",
						jpeg: "image/jpeg",
						webp: "image/webp",
						gif: "image/gif",
						svg: "image/svg+xml",
						avif: "image/avif",
						mp4: "video/mp4",
						webm: "video/webm",
						mp3: "audio/mpeg",
						ogg: "audio/ogg",
						wav: "audio/wav"
					}[key.split(".").at(-1).toLowerCase()] ?? "image/png");
				}
				if (/^(?:blob:|file:|tauri:|asset:)/i.test(url)) throw new Error("이 어셋의 임시 URL을 안전하게 저장할 수 없습니다. 원문을 복구했습니다.");
				return url;
			})());
			return await resources.get(url);
		};
		for (const node of body.querySelectorAll("[data-inlay-id]")) {
			const id = node.getAttribute("data-inlay-id");
			const asset = await readInlay(id);
			const media = body.ownerDocument.createElement(asset.type === "video" ? "video" : asset.type === "audio" ? "audio" : "img");
			media.setAttribute("src", asset.data);
			if (media.tagName !== "IMG") media.setAttribute("controls", "");
			if (media.tagName === "IMG") {
				media.setAttribute("data-inlay-image-id", id);
				media.setAttribute("data-inlay-occurrence", node.getAttribute("data-inlay-occurrence") ?? "0");
			}
			node.replaceWith(media);
		}
		for (const image of body.querySelectorAll("img[data-inlay-image-id]")) {
			image.setAttribute("src", (await readInlay(image.getAttribute("data-inlay-image-id"))).data);
			image.style.removeProperty("animation");
		}
		for (const node of body.querySelectorAll("[src], [poster]")) for (const name of ["src", "poster"]) if (node.hasAttribute(name)) node.setAttribute(name, await resource(node.getAttribute(name)));
		for (const node of body.querySelectorAll("[srcset]")) {
			let set = node.getAttribute("srcset");
			for (const match of [...set.matchAll(/(?:https?:\/\/[^/\s,]+)?\/(?:api\/asset|sw\/img)\/[a-f\d]+(?:[?#][^\s,]*)?/gi)]) set = set.replaceAll(match[0], await resource(match[0]));
			if (/(?:blob:|file:|tauri:|asset:)/i.test(set)) throw new Error("어셋의 임시 srcset URL을 안전하게 저장할 수 없습니다.");
			node.setAttribute("srcset", set);
		}
		const rewriteCSS = async (css) => {
			const matches = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)];
			for (const match of matches) {
				const replacement = await resource(match[2]);
				if (replacement !== match[2]) css = css.replace(match[0], `url("${replacement}")`);
			}
			return css;
		};
		for (const node of body.querySelectorAll("[style]")) node.setAttribute("style", await rewriteCSS(node.getAttribute("style")));
		for (const node of body.querySelectorAll("style")) node.textContent = await rewriteCSS(node.textContent);
		for (const node of body.querySelectorAll(".inlay-image-remove")) node.remove();
		for (const node of body.querySelectorAll(".inlay-image-control")) node.replaceWith(...node.childNodes);
		if (signal.aborted) throw cancelled();
		return body.innerHTML;
	}
	function createNativeRenderer(api, doc, swaps, onChange = () => {}) {
		let disposed = false;
		let active;
		let rendering;
		let gate;
		let error = "";
		const notify = () => {
			try {
				onChange();
			} catch {}
		};
		const closeGate = () => {
			if (disposed || gate) return;
			let open;
			gate = {
				promise: new Promise((resolve) => {
					open = resolve;
				}),
				open
			};
		};
		const openGate = () => {
			const previous = gate;
			gate = null;
			previous?.open();
		};
		const displayGate = async (text) => {
			const barrier = gate;
			if (barrier) await barrier.promise;
			return text;
		};
		async function target(context, signal, token) {
			if (disposed || signal.aborted) throw cancelled();
			const characterIndex = await api.getCurrentCharacterIndex();
			const chatIndex = await api.getCurrentChatIndex();
			const character = await api.getCharacter();
			const chat = character?.chats?.[chatIndex];
			const index = chat?.message?.findIndex((message) => message.chatId === context.messageId);
			if (character?.chaId !== context.characterId || chat?.id !== context.chatId || !(index >= 0) || characterIndex !== await api.getCurrentCharacterIndex() || chatIndex !== await api.getCurrentChatIndex()) throw new Error("후처리 중 대화가 바뀌었습니다. 원문을 복구합니다.");
			const message = chat.message[index];
			if (chat.isStreaming || message.role !== "char" || message.isComment || token && message["risubardTranslationViewerSwap"] !== token) throw new Error("후처리 대상 메시지가 변경되었습니다. 원문을 복구합니다.");
			const row = await doc.querySelector(rowSelector$1(index, context.messageId));
			let body;
			let original;
			let nativeTranslation;
			try {
				body = row && await row.querySelector(".chattext");
				original = body && await body.querySelector(":scope > [data-painter-body]");
				nativeTranslation = row && await row.querySelector(".button-icon-translate.text-info");
				if (!original || nativeTranslation) throw new Error("원문 메시지 화면에서 후처리할 수 있습니다. 편집·내장 번역을 끄고 대상 메시지를 열어 주세요.");
				return {
					row,
					body,
					original,
					index,
					message
				};
			} catch (cause) {
				release(row);
				release(body);
				release(original);
				throw cause;
			} finally {
				release(nativeTranslation);
			}
		}
		const releaseTarget = (found) => {
			if (found) for (const element of [
				found.row,
				found.body,
				found.original
			]) release(element);
		};
		async function probeCommit(context, signal, stamp, token) {
			const found = await target(context, signal, token);
			const probe = await doc.createElement("span");
			try {
				await found.original.setAttribute(BODY_STAMP, stamp);
				await probe.setAttribute(PROBE, stamp);
				await probe.setStyle("display", "none");
				await found.original.appendChild(probe);
			} finally {
				release(probe);
				releaseTarget(found);
			}
			openGate();
			const deadline = Date.now() + TIMEOUT;
			while (Date.now() < deadline) {
				const current = await target(context, signal, token);
				let pending;
				try {
					if (await current.original.getAttribute(BODY_STAMP) !== stamp) throw new Error("후처리 도중 표시 영역이 교체되었습니다. 다시 시도해 주세요.");
					pending = await current.original.querySelector(`[${PROBE}="${stamp}"]`);
					if (!pending) return await current.original.getInnerHTML();
				} finally {
					release(pending);
					releaseTarget(current);
				}
				await pause(signal);
			}
			throw new Error("본체의 표시 후처리 완료를 확인하지 못했습니다. 원문을 복구합니다.");
		}
		return {
			get busy() {
				return Boolean(active);
			},
			get error() {
				return error || swaps.error;
			},
			async render(context, text) {
				if (disposed) throw cancelled();
				if (active) throw new Error("다른 메시지의 후처리와 원문 복구가 진행 중입니다.");
				const controller = new AbortController();
				let finish;
				rendering = new Promise((resolve) => {
					finish = resolve;
				});
				active = controller;
				error = "";
				notify();
				const stamp = `rtv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
				let style;
				let registered = false;
				let restored = false;
				let swapped = false;
				try {
					const before = await target(context, controller.signal);
					try {
						if (before.message.data !== context.source) throw new Error("번역 중 원문이 수정되었습니다. 현재 원문으로 다시 시도해 주세요.");
						await before.original.setAttribute(BODY_STAMP, stamp);
						style = await doc.createElement("style");
						await style.setTextContent(`${rowSelector$1(before.index, context.messageId)} { pointer-events: none !important; } ${rowSelector$1(before.index, context.messageId)} .chattext > [data-painter-body] { visibility: hidden !important; }`);
						const head = await doc.querySelector("head");
						try {
							await head.appendChild(style);
						} finally {
							release(head);
						}
					} finally {
						releaseTarget(before);
					}
					closeGate();
					await api.addRisuScriptHandler("display", displayGate);
					registered = true;
					const html = await swaps.run(context, text, async ({ signal, token }) => {
						swapped = true;
						const abort = () => controller.abort();
						signal.addEventListener("abort", abort, { once: true });
						if (signal.aborted) controller.abort();
						try {
							const current = await target(context, controller.signal, token);
							try {
								if (!(await current.original.getAttribute(BODY_STAMP) !== stamp) && (text === context.source || !literalDisplayInput(context.source) || !literalDisplayInput(text))) throw new Error("본문 CBS가 같아지거나 같은 원문을 반환하여 새 렌더링을 식별할 수 없습니다. 안전을 위해 원문을 복구합니다.");
							} finally {
								releaseTarget(current);
							}
							await probeCommit(context, controller.signal, stamp, token);
							const deadline = Date.now() + TIMEOUT;
							let html;
							while (Date.now() < deadline) {
								const found = await target(context, controller.signal, token);
								try {
									if (await found.original.getAttribute(BODY_STAMP) !== stamp) throw new Error("후처리 표시 영역이 교체되었습니다.");
									html = await found.original.getInnerHTML();
								} finally {
									releaseTarget(found);
								}
								if (![...parseHTML(html).querySelectorAll("img[src]:not([noimage])")].some((image) => {
									const src = image.getAttribute("src");
									return src && !/^(?:data:|https?:|blob:|file:|tauri:|\/)/i.test(src);
								})) return await materialize(api, html, controller.signal);
								await pause(controller.signal);
							}
							throw new Error("어셋 주소가 준비되지 않았습니다. 원문을 복구합니다.");
						} finally {
							signal.removeEventListener("abort", abort);
							closeGate();
						}
					});
					restored = true;
					return html;
				} catch (cause) {
					error = cause instanceof Error ? cause.message : String(cause);
					throw cause;
				} finally {
					try {
						if (swapped && !disposed && !controller.signal.aborted && !swaps.busy) try {
							await probeCommit(context, controller.signal, `${stamp}-restore`);
							restored = true;
						} catch (cause) {
							if (!restored) error = cause instanceof Error ? cause.message : String(cause);
						}
						openGate();
						if (registered) await api.removeRisuScriptHandler("display", displayGate).catch(() => {});
						const probes = await doc.querySelectorAll(`[${PROBE}="${stamp}"], [${PROBE}="${stamp}-restore"]`).catch(() => null);
						if (probes) try {
							for (const probe of await api.unwarpSafeArray(probes)) {
								await probe.remove().catch(() => {});
								release(probe);
							}
						} finally {
							release(probes);
						}
						const bodies = await doc.querySelectorAll(`[${BODY_STAMP}="${stamp}"], [${BODY_STAMP}="${stamp}-restore"]`).catch(() => null);
						if (bodies) try {
							for (const body of await api.unwarpSafeArray(bodies)) {
								await body.setAttribute(BODY_STAMP, "").catch(() => {});
								release(body);
							}
						} finally {
							release(bodies);
						}
					} finally {
						await style?.remove().catch(() => {});
						release(style);
						active = null;
						finish();
						notify();
					}
				}
			},
			async dispose() {
				disposed = true;
				active?.abort();
				openGate();
				await swaps.dispose();
				await rendering;
			}
		};
	}
	//#endregion
	//#region plugin/translation-viewer/main.js
	var ROW_MARK = "x-rtv-row";
	var BODY_MARK = "x-rtv-body";
	var MODE_MARK = "x-rtv-show";
	var css = `
.rtv-translation { display: none; overflow-wrap: anywhere; pointer-events: none; user-select: none; }
.chattext[x-rtv-show="translation"] > [data-painter-body] { display: none !important; }
.chattext[x-rtv-show="translation"] > .rtv-translation { display: block; }
.rtv-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .65em; margin: .6em 0; font-size: .8rem; color: inherit; }
.rtv-controls button { cursor: pointer; padding: .25em .6em; border: 1px solid currentColor; border-radius: .35em; background: transparent; color: inherit; }
.rtv-controls button:hover { opacity: .75; }
.rtv-status { opacity: .8; white-space: pre-wrap; overflow-wrap: anywhere; }
${quickToggleCSS}
`;
	function contextFor(character, chat, message) {
		if (![
			character?.chaId,
			chat?.id,
			message?.chatId
		].every((id) => typeof id === "string" && id) || message.role !== "char" || message.isComment || typeof message.data !== "string" || !message.data.trim()) return null;
		return {
			characterId: character.chaId,
			chatId: chat.id,
			messageId: message.chatId,
			source: message.data,
			translatorNote: character.type === "character" ? character.translatorNote ?? "" : ""
		};
	}
	function rowSelector(index, id) {
		return `.risu-chat[data-chat-index="${index}"][data-chat-id="${CSS.escape(id)}"]`;
	}
	async function startTranslationViewer(api) {
		let disposed = false;
		let doc;
		let style;
		let observer;
		let engine;
		let swaps;
		let nativeRenderer;
		let settingsUI;
		let quickToggle;
		let timer;
		let poll;
		let refreshing = false;
		let refreshAgain = false;
		let sequence = 0;
		let selection = null;
		let uiError = "";
		let initialization = Promise.resolve();
		let recoveredSelection = "";
		let activeRefresh = Promise.resolve();
		const views = /* @__PURE__ */ new Map();
		const originalMode = /* @__PURE__ */ new Set();
		const pendingOutputs = /* @__PURE__ */ new Map();
		const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const release = (object) => {
			object?.release?.();
		};
		const logError = (error) => {
			uiError = error instanceof Error ? error.message : String(error);
			console.error("[원문 보존 번역]", error);
		};
		const cleanupView = async (view) => {
			views.delete(view.token);
			await Promise.allSettled([
				view.body.setAttribute(MODE_MARK, ""),
				view.body.setAttribute(BODY_MARK, ""),
				view.row.setAttribute(ROW_MARK, ""),
				view.translation.remove(),
				view.controls.remove(),
				...view.listeners.map(([button, id]) => button.removeEventListener("click", id))
			]);
			for (const element of [
				view.row,
				view.body,
				view.translation,
				view.controls,
				view.toggle,
				view.retry,
				view.status
			]) release(element);
		};
		const dispose = async () => {
			if (disposed) return;
			disposed = true;
			clearTimeout(timer);
			clearInterval(poll);
			engine?.dispose();
			const restoring = nativeRenderer?.dispose() ?? swaps?.dispose();
			pendingOutputs.clear();
			await style?.remove();
			await Promise.allSettled([
				restoring,
				initialization,
				activeRefresh
			]);
			engine?.dispose();
			await swaps?.dispose();
			clearInterval(poll);
			await style?.remove();
			await Promise.allSettled([
				observer?.disconnect(),
				...Array.from(views.values(), cleanupView),
				settingsUI?.dispose(),
				quickToggle?.dispose(),
				api.removeRisuChatListener("output", onOutput)
			]);
		};
		await api.onUnload(dispose);
		function schedule(mutations) {
			release(mutations);
			if (disposed || timer) return;
			timer = setTimeout(() => {
				timer = null;
				if (refreshing) {
					refreshAgain = true;
					return;
				}
				activeRefresh = refresh().catch(logError);
			}, 100);
		}
		async function readSelection() {
			const characterIndex = await api.getCurrentCharacterIndex();
			if (characterIndex === null || characterIndex === void 0 || characterIndex < 0) return null;
			const chatIndex = await api.getCurrentChatIndex();
			const character = await api.getCharacter();
			if (disposed || characterIndex !== await api.getCurrentCharacterIndex() || chatIndex !== await api.getCurrentChatIndex()) return null;
			const chat = character?.chats?.[chatIndex];
			if (chat && swaps) for (const message of chat.message ?? []) {
				const original = swaps.original({
					characterId: character.chaId,
					chatId: chat.id,
					messageId: message.chatId
				});
				if (original !== void 0) message.data = original;
			}
			return chat?.id && Array.isArray(chat.message) ? {
				characterIndex,
				chatIndex,
				character,
				chat
			} : null;
		}
		async function setLabel(view, field, element, value) {
			if (view[field] === value) return;
			await element.setTextContent(value);
			view[field] = value;
		}
		async function paint(view, snapshot) {
			const entry = await engine.get(view.context);
			if (disposed) return;
			const busy = engine.isBusy(view.context);
			const nativeButton = await view.row.querySelector(".button-icon-translate.text-info");
			view.nativeTranslated = Boolean(nativeButton);
			release(nativeButton);
			const ready = entry && typeof entry.html === "string";
			const showTranslation = Boolean(ready && engine.isEnabled(view.context.characterId) && !view.nativeTranslated && !snapshot.chat.isStreaming && !originalMode.has(view.key));
			if (ready && view.renderedHTML !== entry.html) {
				await view.translation.setInnerHTML(entry.html);
				const images = await view.translation.querySelectorAll("img[class*=\"root-loaded-image\"]");
				try {
					for (const image of await api.unwarpSafeArray(images)) try {
						const classes = await image.getClassName();
						await image.addClass("root-loaded-image");
						if (classes.includes("root-loaded-image-dynamic")) await image.addClass("root-loaded-image-dynamic");
					} finally {
						release(image);
					}
				} finally {
					release(images);
				}
				view.renderedHTML = entry.html;
			}
			const mode = showTranslation ? "translation" : "original";
			if (view.mode !== mode) {
				await view.body.setAttribute(MODE_MARK, mode);
				view.mode = mode;
			}
			await setLabel(view, "toggleLabel", view.toggle, view.nativeTranslated ? "내장 번역 끄기 필요" : !entry ? "번역" : !ready ? "후처리 재시도" : showTranslation ? "원문 보기" : "번역 보기");
			await setLabel(view, "retryLabel", view.retry, busy ? "번역·후처리 중…" : "다시 번역");
			const error = swaps?.error || engine.error(view.context) || uiError;
			const status = view.nativeTranslated ? "앱의 번역 버튼과 자동 번역을 꺼 주세요." : error || (busy ? "번역·표시 후처리 중 — 원문 복구 후 표시" : snapshot.chat.isStreaming ? "응답 완료 후 번역할 수 있습니다." : entry && !ready ? "저장된 번역을 본체 표시 방식으로 후처리합니다. 추가 번역 요청은 보내지 않습니다." : entry && entry.source !== view.context.source ? "원문 수정됨 · 기존 번역 유지" : showTranslation ? "번역문은 읽기 전용 · 편집은 원문 보기" : "");
			await setLabel(view, "statusLabel", view.status, status);
			if (entry && !ready && !busy && !engine.error(view.context) && !view.nativeTranslated && !snapshot.chat.isStreaming) engine.render(view.context).catch(logError);
		}
		async function freshContext(view) {
			const current = await readSelection();
			if (!current || current.chat.isStreaming || !engine.isEnabled(current.character.chaId)) return null;
			const message = current.chat.message.find((message) => message.chatId === view.context.messageId);
			const context = contextFor(current.character, current.chat, message);
			return context && engine.key(context) === view.key ? context : null;
		}
		async function act(view, force) {
			if (disposed || nativeRenderer?.busy || swaps?.busy || view.nativeTranslated || engine.isBusy(view.context)) return;
			const context = await freshContext(view);
			if (!context || disposed) return;
			const entry = await engine.get(context);
			if (entry && typeof entry.html === "string" && !force) {
				if (originalMode.has(view.key)) originalMode.delete(view.key);
				else originalMode.add(view.key);
				schedule();
				return;
			}
			try {
				if ((entry && !force ? await engine.render(context) : await engine.translate(context, { force })) && !disposed && !engine.error(context)) originalMode.delete(view.key);
			} catch (error) {
				logError(error);
			}
			schedule();
		}
		async function mount(row, body, index, context) {
			const token = `${session}-${++sequence}`;
			const translation = await doc.createElement("span");
			await translation.setClassName("rtv-translation");
			const controls = await doc.createElement("div");
			await controls.setClassName("rtv-controls");
			await controls.setAttribute("x-rtv-controls", token);
			const toggle = await doc.createElement("button");
			const retry = await doc.createElement("button");
			const status = await doc.createElement("span");
			await toggle.setAttribute("x-rtv-action", "toggle");
			await retry.setAttribute("x-rtv-action", "retry");
			await status.setClassName("rtv-status");
			await controls.appendChild(toggle);
			await controls.appendChild(retry);
			await controls.appendChild(status);
			const view = {
				token,
				row,
				body,
				index,
				context,
				key: engine.key(context),
				translation,
				controls,
				toggle,
				retry,
				status,
				listeners: []
			};
			views.set(token, view);
			try {
				await row.setAttribute(ROW_MARK, token);
				await body.setAttribute(BODY_MARK, token);
				await body.appendChild(translation);
				const parent = await body.getParent();
				await parent.appendChild(controls);
				release(parent);
				view.listeners.push([toggle, await toggle.addEventListener("click", () => {
					act(view, false).catch(logError);
				})]);
				view.listeners.push([retry, await retry.addEventListener("click", () => {
					act(view, true).catch(logError);
				})]);
				if (disposed) await cleanupView(view);
				return view;
			} catch (error) {
				await cleanupView(view);
				throw error;
			}
		}
		async function reconcile(snapshot) {
			const seen = /* @__PURE__ */ new Set();
			if (snapshot && engine.isEnabled(snapshot.character.chaId)) {
				const safeRows = await doc.querySelectorAll(".risu-chat[data-chat-index]");
				const rows = await api.unwarpSafeArray(safeRows);
				release(safeRows);
				for (const row of rows) {
					let body;
					let original;
					let retained = false;
					try {
						if (disposed || !engine.isEnabled(snapshot.character.chaId)) continue;
						const token = await row.getAttribute(ROW_MARK);
						let view = views.get(token);
						let index = view?.index;
						let message = snapshot.chat.message[index];
						if (!view || !message || !await row.matches(rowSelector(index, message.chatId))) {
							const html = await row.getOuterHTML();
							const tag = new DOMParser().parseFromString(html.slice(0, html.indexOf(">") + 1), "text/html").body.firstElementChild;
							index = Number(tag?.getAttribute("data-chat-index"));
							message = snapshot.chat.message[index];
							if (!Number.isInteger(index) || index < 0 || !message || tag?.getAttribute("data-chat-id") !== message.chatId) continue;
						}
						const context = contextFor(snapshot.character, snapshot.chat, message);
						if (!context) continue;
						body = await row.querySelector(".chattext");
						original = body && await body.querySelector(":scope > [data-painter-body]");
						if (!original) continue;
						const bodyToken = await body.getAttribute(BODY_MARK);
						if (view && (view.key !== engine.key(context) || bodyToken !== token)) {
							await cleanupView(view);
							view = null;
						}
						if (!view) {
							view = await mount(row, body, index, context);
							retained = true;
						}
						if (disposed) continue;
						view.context = context;
						view.index = index;
						seen.add(view.token);
						await paint(view, snapshot);
					} finally {
						release(original);
						if (!retained) {
							release(row);
							release(body);
						}
					}
				}
			}
			await Promise.all(Array.from(views.values()).filter((view) => !seen.has(view.token)).map(cleanupView));
		}
		async function translateOutput(context) {
			const entry = await engine.get(context);
			if (disposed || !engine.settings.autoTranslate || !engine.isEnabled(context.characterId)) return;
			await engine.translate(context, { force: Boolean(entry && entry.source !== context.source) });
		}
		async function onOutput(output) {
			if (disposed || !engine?.isEnabled(output.char?.chaId) || !engine.settings.autoTranslate) return;
			const message = output.chat?.message?.[output.messageIndex];
			const context = contextFor(output.char, output.chat, message);
			if (!context) return;
			const current = await readSelection();
			if (disposed) return;
			if (current?.character.chaId !== context.characterId || current.chat.id !== context.chatId) {
				pendingOutputs.set(engine.key(context), context);
				schedule();
				return;
			}
			pendingOutputs.delete(engine.key(context));
			try {
				await translateOutput(context);
			} catch (error) {
				logError(error);
			} finally {
				schedule();
			}
		}
		function discardDisabledOutputs() {
			for (const [key, context] of pendingOutputs) if (!engine.settings.autoTranslate || !engine.isEnabled(context.characterId)) pendingOutputs.delete(key);
		}
		async function refresh() {
			if (disposed || !doc || !engine) return;
			if (refreshing) {
				refreshAgain = true;
				return;
			}
			refreshing = true;
			try {
				if (nativeRenderer?.busy || swaps?.busy) {
					const status = swaps.error || "표시 후처리·원문 복구 중 — 대상 메시지 편집 잠금";
					for (const view of views.values()) await setLabel(view, "statusLabel", view.status, status);
					return;
				}
				selection = await readSelection();
				if (disposed) return;
				const selectionKey = selection ? JSON.stringify([selection.character.chaId, selection.chat.id]) : "";
				if (selectionKey && selectionKey !== recoveredSelection) {
					recoveredSelection = selectionKey;
					await swaps.recover();
					selection = await readSelection();
					if (disposed) return;
				}
				settingsUI?.refreshPreference();
				await quickToggle?.refresh(selection);
				if (disposed) return;
				discardDisabledOutputs();
				if (selection && !selection.chat.isStreaming) for (const [key, context] of pendingOutputs) {
					if (context.characterId !== selection.character.chaId || context.chatId !== selection.chat.id) continue;
					pendingOutputs.delete(key);
					const message = selection.chat.message.find((item) => item.chatId === context.messageId);
					const current = contextFor(selection.character, selection.chat, message);
					if (current) (current.source === context.source ? translateOutput(current) : engine.translate(current)).catch(logError);
				}
				await reconcile(selection);
			} finally {
				refreshing = false;
				if (refreshAgain) {
					refreshAgain = false;
					schedule();
				}
			}
		}
		function preferencesChanged() {
			uiError = "";
			discardDisabledOutputs();
			schedule();
		}
		initialization = (async () => {
			doc = await api.getRootDocument();
			if (disposed) return;
			if (!doc) throw new Error("메인 화면 접근 권한이 필요합니다. 권한을 허용하고 플러그인을 다시 불러오세요.");
			swaps = await createMessageSwap(api, schedule);
			if (disposed) {
				await swaps.dispose();
				return;
			}
			nativeRenderer = createNativeRenderer(api, doc, swaps, schedule);
			engine = await createEngine(api, schedule, (context, text) => nativeRenderer.render(context, text));
			if (disposed) return;
			settingsUI = await registerSettings(api, engine, preferencesChanged);
			if (disposed) return;
			quickToggle = createQuickToggle(api, doc, engine, {
				readSelection,
				onChange: preferencesChanged,
				openSettings: () => settingsUI.open(),
				reportError: logError
			});
			style = await doc.createElement("style");
			if (disposed) return;
			await style.setTextContent(css);
			const head = await doc.querySelector("head");
			if (!disposed) await head.appendChild(style);
			release(head);
			if (disposed) return;
			await api.addRisuChatListener("output", onOutput);
			if (disposed) return;
			observer = await api.createMutationObserver(schedule);
			const body = await doc.querySelector("body");
			if (!disposed) await observer.observe(body, {
				childList: true,
				subtree: true
			});
			release(body);
			if (disposed) return;
			poll = setInterval(schedule, 1500);
			activeRefresh = refresh();
			await activeRefresh;
		})();
		try {
			await initialization;
			return dispose;
		} catch (error) {
			await dispose();
			throw error;
		}
	}
	//#endregion
	//#region plugin/translation-viewer/index.js
	startTranslationViewer(Risuai).catch((error) => {
		console.error("[원문 보존 번역] 플러그인을 시작하지 못했습니다.", error);
	});
	//#endregion
})();
