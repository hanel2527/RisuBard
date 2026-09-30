# 응답 대기 중 채팅 전환 안전성 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 봇의 A와 B 사이를 응답 대기 중 전환해도 메시지, 입력 초안, 스크립트 상태와 위키가 원래 채팅에 귀속되게 한다.

**Architecture:** 화면 선택과 생성 작업 대상을 분리한다. 요청 시작 시 characterId와 chatId를 고정하고, 비동기 작업의 읽기와 쓰기는 이 ID로 최신 저장소에서 대상을 찾는다. 기존 채팅별 생성 상태와 복구 체계를 재사용한다.

**Tech Stack:** TypeScript, Svelte, Vitest, 기존 Node 파일 정본 저장소.

**Spec:** 전환을 막지 않고 일반 응답과 스트리밍을 원래 채팅에 저장한다. 후속 요청으로 구현이 승인됐으며 100턴과 장시간 반복 테스트는 제외한다.

## Global Constraints

- 공개판 현재 체크아웃에서만 작업한다. 기존 미커밋 변경을 보존한다.
- 응답 생성 중 같은 봇의 채팅 전환과 입력 초안 작성을 유지한다.
- 여러 채팅의 동시 생성 허용이나 다른 봇 전환 정책 변경은 이번 범위에 추가하지 않는다.
- 실제 사용자 데이터나 유료 모델 요청 없이 합성 데이터와 지연 가능한 응답으로 재현한다.
- 공식 위키, 저장 형식, 백업 정책은 변경하지 않는다. 추가 의존성을 도입하지 않는다.
- 완료 시 최신 SemVer 패치노트에 실제 구현한 변경만 기록한다. 이 계획 작성만으로 수정 완료 항목을 넣지 않는다.

## 조사 결과와 증거 범위

1. `src/ts/process/index.svelte.ts:2248`에서 시작 트리거를 await한 뒤 `setCurrentChat(currentChat)`을 호출한다.
2. `src/ts/storage/database.svelte.ts:1141`의 해당 함수는 현재 선택 캐릭터의 현재 `chatPage` 슬롯을 통째로 교체한다. 요청 대상과 결과의 ID 일치 검사가 없다.
3. 실제 setter 선언을 TypeScript AST로 추출해 실행했다. 202개 메시지의 A와 빈 B를 만들고 A 결과를 기다리는 동안 선택을 B로 옮긴 뒤 A 복사본을 넘기면 ID가 `[A, B]`에서 `[A, A]`, 메시지 수가 `[202, 0]`에서 `[202, 202]`로 바뀐다. 메모리 fixture만 사용했고 사용자 파일은 접근하지 않았다.
4. 이 실험은 setter의 덮어쓰기를 입증한다. 제보 환경의 트리거 구성, 실제 앱 전체 흐름, 서버 저장 후 유실은 아직 재현하지 않았다. 트리거가 없으면 `runTrigger`는 null을 반환하므로 해당 분기는 실행되지 않는다.
5. `triggers.ts:2802`는 비동기 처리 후 `getCurrentChat()`에 scriptstate를 쓴다. `scripts.ts:127`도 처리 대상 대신 현재 화면의 채팅을 읽는다.
6. `index.svelte.ts:3321,3365`의 자동 이어쓰기와 재요청은 원래 채팅 ID를 인자로 전달하지 않고 `sendChat`에 재진입한다.
7. 일반 응답 쓰기는 캡처한 배열 인덱스 `selectedChat`을 다수 사용한다. 단순 전환에는 인덱스가 유지되지만 새 채팅 삽입, 삭제, 재정렬에는 안전하지 않다.
8. `DefaultChatScreen.svelte:593-670`은 입력 트리거와 스크립트를 await한 뒤 현재 chatPage에 메시지를 쓰고 현재 draft ID를 지운다. 입력 준비 중 전환도 검증 대상이다.
9. 기존 `generationState.ts`와 `chatDraft.ts`는 이미 채팅 ID 기준 상태와 초안 저장을 제공한다. `chatStorage.ts`의 hydration은 로드 완료 시 ID로 위치를 다시 찾는 방식을 사용한다.

## Review Focus

- 지연된 시작 트리거 완료: A 결과가 B의 객체나 ID를 바꾸지 않아야 한다.
- 입력 준비 중 전환: A 전송이 B 초안이나 첨부 입력을 비우지 않아야 한다.
- 목록 이동 및 대상 삭제: 인덱스가 바뀌어도 같은 ID에 기록하고, 대상이 없으면 다른 채팅에 대체 기록하지 않는다.
- 자동 이어쓰기 및 출력 트리거: 요청, 변수, 모델 설정과 위키 대상이 B로 바뀌지 않아야 한다.
- 오류, 취소, 재시작: 결과 복구와 생성 상태 정리가 원래 작업에만 적용되어야 한다.

## Task 1: 실패 재현과 ID 기반 대상 접근

**Files:** Create `src/ts/process/generationTarget.ts`, `src/ts/process/generationTarget.test.ts`, `src/ts/process/sendChatTarget.test.ts`; modify `src/ts/process/index.svelte.ts`.

**Interfaces:** `GenerationTarget = Readonly<{ characterId: string; chatId: string }>`; `resolveGenerationTarget(characters: character[], target: GenerationTarget)` returns `{ character, chat, characterIndex, chatIndex }` or throws if identity is missing or ambiguous. `replaceGenerationChat(characters, target, next)` validates `next.id === target.chatId`, normalizes the chat and replaces only the freshly resolved slot.

- [ ] Convert the isolated setter reproduction into a regression exercising the actual delayed start-trigger write-back. Assert that A and B keep distinct IDs, B is deeply unchanged, and A receives its own result. Observe failure before changing production code.
- [ ] Implement target resolution with no fallback to current selection or old array position:

```ts
const owners = characters.filter(c => c.chaId === target.characterId)
if (owners.length !== 1) throw new Error('Generation character identity mismatch')
const character = owners[0]
const matches = character.chats.filter(c => c.id === target.chatId)
if (matches.length !== 1) throw new Error('Generation chat identity mismatch')
const chat = matches[0]
return { character, chat, characterIndex: characters.indexOf(character), chatIndex: character.chats.indexOf(chat) }
```

- [ ] Capture target before asynchronous send preparation; ensure legacy chats obtain a stable ID before creating generation guards. Internal continuation takes an explicit target; ordinary callers may default to selection only at entry.
- [ ] Replace start-trigger `setCurrentChat` and response/error/streaming slot access with explicit target access. Validate response chat ID before replacement; never silently rewrite a mismatched ID to make it fit.
- [ ] Add tests for reordering, insertion, missing target, duplicate IDs and mismatched result IDs. On unresolved target, end the original generation and report the conflict; retain existing recoverable response/job data rather than clearing it as success.
- [ ] Run `pnpm exec vitest run src/ts/process/generationTarget.test.ts src/ts/process/sendChatTarget.test.ts src/ts/process/sendSyncSelection.test.ts src/ts/process/sendChatFailureCleanup.test.ts`.

## Task 2: 트리거, 스크립트와 후속 생성의 대상 유지

**Files:** Modify `src/ts/process/index.svelte.ts`, `src/ts/process/triggers.ts`, `src/ts/process/scripts.ts`, and relevant parser call sites; create `src/ts/process/triggerChatTarget.test.ts`. Inspect `src/ts/parser/chatVar.svelte.ts`, `src/ts/parser/parser.svelte.ts`, `src/ts/process/request/request.ts`, `src/ts/process/request/jobRecovery.ts` and `src/ts/risubard/narrativeContext.ts` for affected implicit selection use before editing.

**Interfaces:** Pass optional explicit generation scope through script/trigger processing. Non-generation display/manual callers retain their existing selection-based default. Recursive `sendChat` calls pass the original `GenerationTarget`.

- [ ] Add a deferred trigger test: start with A scriptstate, switch to B, resolve the trigger; assert only A scriptstate changed. Add a script-processing test with different A/B variables and module bindings.
- [ ] Replace generation-related `getCurrentChat` reads/writes with the explicit scope. Parser variable access must use the same chat even when its owner object's mutable chatPage points to B. Do not temporarily switch global selection around an await.
- [ ] Audit preset/persona/module settings that `changeChatTo` applies globally. Capture the request's required settings before asynchronous work or resolve its bindings by target. Use A/B with different bindings to assert A's request content is unchanged by the switch.
- [ ] Add automatic continuation and resend tests: finish A while B is selected and verify the next request's target, prompt history, generation key, AbortController and output message all remain A.
- [ ] Verify existing wiki requests and receipt writes carry original character/chat/message IDs. Add a regression that A completion cannot update B's wiki or memory receipt; edit only affected paths.
- [ ] Run `pnpm exec vitest run src/ts/process/triggerChatTarget.test.ts src/ts/process/sendChatTarget.test.ts src/ts/process/generationState.test.ts src/ts/process/sendChatMemoryBoundary.test.ts src/ts/process/request/jobRecovery.test.ts`.

## Task 3: 입력 준비, 초안과 화면 상태

**Files:** Modify `src/lib/ChatScreens/DefaultChatScreen.svelte`; extend `src/lib/ChatScreens/ChatSendPreparation.test.ts`, `src/ts/storage/chatDraft.test.ts`. Change draft implementation only if regression exposes a defect.

- [ ] Add a test delaying A input trigger, switching to B and typing a different draft before release. Assert A gets exactly one user message, B keeps its draft, and the request target remains A.
- [ ] Capture A's target, input text, translated text and attachments before awaiting preparation. Clear only the submitted A input snapshot; any new B input must survive. Pass A's target into `sendChatMain` and `sendChat` rather than recapturing selection after `sleep(10)`.
- [ ] Add assertions for input-processing failure and cancellation: no cross-chat rollback, draft deletion, duplicate user message or clearing of a newer draft.
- [ ] Keep navigation enabled. Verify A's stop button aborts A and B's composer does not inherit A's stop action. Retain existing concurrent-send policy.
- [ ] Run `pnpm exec vitest run src/lib/ChatScreens/ChatSendPreparation.test.ts src/ts/storage/chatDraft.test.ts src/ts/process/sendChatTarget.test.ts`.

## Task 4: 저장 왕복과 실제 화면 검증

**Files:** Add `src/ts/process/chatSwitchPersistence.test.ts` using existing storage mocks/integration fixtures; extend an existing server chat persistence test only if needed. Update the highest SemVer file under `patchnote/` after implementation.

- [ ] Build short isolated A/B fixtures with fake responses and controllable delays. Long-chat stress testing is explicitly excluded by the user.
- [ ] Exercise an A/B switching cycle and compare stable IDs, generated message ownership, input drafts and scope. Repeated manual usage is left to the user.
- [ ] Include streaming and non-streaming response paths, automatic continuation, trigger variable writes, network error, cancellation, list insertion/reorder and hydrated chat loading. Preserve recoverable output if the original target disappears.
- [ ] Save through the normal persistence boundary, reload from that boundary, and verify distinct A/B identities and histories. The test must reload stored data rather than assert only the live DB object.
- [ ] Use `impeccable` and `webapp-testing` for scoped UI review and browser execution. Capture the actual screen after switching during generation; inspect composer contents, stop/send states, message ownership and completion behavior at desktop and a narrow viewport.
- [ ] Verify desktop behavior separately when available; report untested environments explicitly. Synthetic storage tests do not establish browser or desktop success.
- [ ] Run the targeted tests for changed paths plus type checking if signatures changed. Record commands and results, add the user-facing patchnote, and report remaining limits. No commit, push or release is part of this planning request.

## 완료 판정

전환 가능 상태를 유지하면서 원래 기록, 응답, 초안, 변수와 위키의 귀속이 보존되고, 실제 저장 후 다시 열어도 A/B가 별도 채팅으로 유지되어야 한다. setter 한 곳 수정이나 메모리 테스트 통과만으로 완료라고 판단하지 않는다.

## 실행 결과

- 사용자 지시에 따라 현재 체크아웃에서 구현했고, 기존 미커밋 변경을 보존했다. 100턴과 장시간 반복 검증은 제외했다.
- 시작 트리거에서 `[A, A]`로 덮어쓰는 실패를 관찰한 뒤 ID 기반 대상 접근으로 수정했다. 자동 이어쓰기, 일반 응답과 스트리밍에 같은 대상을 전달한다.
- 트리거, Lua, 명령 파이프라인, CBS 변수, 로어북, 페르소나와 모듈에 명시적 채팅 범위를 전달한다. 입력 준비 전에 요청 설정도 캡처하고 출력 정규식까지 전달한다.
- 화면 밖에서 생성 중인 채팅을 기존 자동 저장 큐에서 관찰한다. 종료와 마지막 청크가 같은 갱신에 묶인 경우도 저장 대상으로 추적한다.
- 입력 초안은 전송한 내용과 일치할 때만 제거하고, 새 초안과 다른 채팅의 저장 대기를 보존한다. 제출한 첨부만 제거한다.
- 독립 코드 검토에서 발견한 최신 초안 삭제, 첨부 잔류, 삭제된 대상의 스트림 정리와 프리셋 혼입 문제를 보완했다.
- 최종 관련 테스트 21개 파일, 257개 통과. 짧은 A/B, 일반 응답, 스트리밍 세 모드, 자동 이어쓰기, 저장 API 경계의 저장 및 hydration 재로드를 포함한다. 저장 왕복은 격리된 mock 저장소를 사용하며 실제 사용자 파일 검증이 아니다.
- 실행 화면과 스크린샷 검증은 수행하지 않았다. Playwright와 격리된 앱 서버가 없으며, 사용자 데이터 서버는 검증에 사용하지 않았다. 실제 반복 전환은 사용자가 직접 확인하기로 했다.
- 최신 패치노트 0.9.52에 변경 내용을 반영했다. 커밋, push, 릴리스는 수행하지 않았다.
- 최종 `svelte-check` 결과 6,586개 파일에서 오류 0개, 경고 0개. 변경 파일의 `git diff --check`도 통과했다.
