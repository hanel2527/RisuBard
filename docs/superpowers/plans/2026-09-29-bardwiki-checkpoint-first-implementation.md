# 바드위키 체크포인트 첫 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설계 체크포인트를 원격에 보존한 뒤 직접 편집과 바드챗의 본문 글자 제한을 제거하고, 대형 문서 처리의 데이터 유실 위험을 먼저 고친다.

**Architecture:** 기존 단일 JSON 명령, 전체 문서 upsert와 hash 조건부 저장을 유지한다. 편집기 textarea 및 바드챗 스키마와 parser에 남아 있는 12,000자 제한을 제거하고, 전체 교체에 사용되는 기존 문서는 모델 입력에서 절단하지 않는다. 예산 부족은 모델 호출과 저장 이전에 구분 가능한 오류로 반환한다. 새 임의의 문서 글자 상한으로 교체하지 않는다.

**Tech Stack:** TypeScript, Vitest, 기존 runValidatedModelRequest, Windows PowerShell, Git/gh.

**Spec:** `docs/architecture/2026-09-29-bardwiki-long-chat-checkpoint.md`

## Global Constraints

- 사용자가 지정한 공개판 현재 브랜치에서 작업한다. worktree를 만들지 않는다.
- 체크포인트 커밋 및 push를 구현보다 먼저 완료한다.
- GitHub 쓰기는 프로세스에 rpaddict 자격 증명을 고정하고 같은 자격 증명으로 로그인 이름을 확인한다. 다른 계정으로 순회하지 않는다.
- 다른 작업의 변경은 보존하며 선택한 파일만 커밋한다.
- 모델 출력 잘림, 구조 검증, target/hash 검증과 파괴적 후속 작업 차단은 유지한다.
- 구현된 사용자 동작만 최신 패치노트에 기록한다. 설계 문서만 작성한 체크포인트는 개발 문서이므로 기능 출시로 기록하지 않는다.
- 이 계획은 전체 장기 기억 설계 중 첫 안전 수정만 실행한다. 나머지 범위와 상태는 Spec 9절에 명시한다.

## Review Focus

1. 12,000자가 넘는 정상 결과도 다른 필수 필드와 제목 계층을 검사해야 한다.
2. 길이가 예산을 넘는 기존 문서의 끝에 있는 사실을 모델 입력에서 버리면 안 된다.
3. 참고 컨텍스트를 줄여도 명시적 사용자 지시와 기존 문서 전문은 보존해야 한다.
4. 예산 부족 또는 잘린 응답에서 저장, beforeApply, 삭제 API가 호출되면 안 된다.
5. 충분한 예산의 큰 위키, 제목으로 좁힌 대상, 재시도와 기존 aliases 호환이 유지되어야 한다.
6. 18,961자 이상 기존 문서에서 추가 입력, 치환, 저장과 재열기가 가능해야 하며 기존 링크와 마지막 사실이 유지되어야 한다.

## Task 1: 체크포인트

**Files:** 이 계획 및 연결된 Spec.

- [x] 두 문서의 결정, 대체된 제안, 미확정 계수와 검증 상태를 교차 확인한다.
- [x] `git diff --check`와 선택된 staged 파일 목록을 확인한다.
- [x] 커밋 제목: `docs: 바드위키 체크포인트 - 초장기 기억 설계와 구현 순서`.
- [x] 원격 main과 비교하고 rpaddict만으로 push한다. 원격 커밋 작성자와 커밋 SHA를 확인한다.

## Task 2: 대형 문서 출력 허용과 정확한 오류

**Files:**
- Modify: `src/ts/risubard/directWikiCommand.ts`
- Test: `src/ts/risubard/directWikiCommand.test.ts`

**Interfaces:** 기존 `executeDirectWikiCommand(input)`과 `directWikiCommandSchema`를 유지한다. 정상 Markdown은 고정 글자 상한 없이 받아도 빈 본문, 잘못된 유형, 제목과 H1/H2 누락은 거부한다.

- [x] 12,001자 이상 본문 결과가 saveDocument까지 동일하게 전달되는 테스트를 추가한다.
- [x] 본문 누락, 제목 누락, 제목 계층 누락, 잘못된 유형의 오류를 구분하는 테스트를 추가한다.
- [x] `node node_modules/vitest/vitest.mjs run src/ts/risubard/directWikiCommand.test.ts`로 새 테스트 실패를 확인한다.
- [x] 스키마의 Markdown maxLength만 제거하고 parser의 본문 길이 제한을 없앤다. 오류 원인별 메시지를 제공한다. 기존 필드 검증은 보존한다.
- [x] 같은 테스트를 실행해 통과와 기존 재시도 안전성을 확인한다.

테스트 입력의 핵심:

```ts
const markdown = '## 기존 인물\n\n### 지식과 비밀\n' + '확인된 사실. '.repeat(2000)
// 정상 종료한 JSON 응답으로 반환한 뒤 saveDocument의 markdown이 완전히 같은지 확인.
// schema.properties.operations.items.properties.markdown의 string 분기에는 maxLength가 없어야 함.
```

## Task 3: 전체 교체 입력의 원문 보존

**Files:** Task 2와 동일.

**Interfaces:** boundedInput은 전체 대상 문서를 넣을 수 없으면 명시적 오류를 던진다. 반환 가능한 경우 documents[].markdown은 공급된 문서와 정확히 같다.

- [x] 문서 끝에 고유한 사실이 있는 대형 입력으로, 예산이 충분하면 끝부분까지 모델에 전달됨을 검증한다.
- [x] 예산이 부족하면 requestModel, saveDocument, trashDocument, retractEvent, beforeApply가 호출되지 않음을 검증한다.
- [x] 긴 선택 컨텍스트를 축소해 맞출 수 있는 경우에도 기존 문서 전문이 보존됨을 검증한다.
- [x] 기존 큰 위키 테스트의 32,768/65,536 설정이 전문 기준으로 안전하게 처리되는지 확인한다.
- [x] 실패 확인 후 문서 본문을 축소 대상에서 제외한다. 예산을 맞출 수 없는 경우 대상 범위 축소 또는 설정 조정을 안내하고 원문 보존 때문에 중단됐음을 알린다.
- [x] 해당 테스트와 연결된 Memory Wiki 테스트를 실행한다.

테스트 기대값:

```ts
expect(JSON.parse(request.formated[1].content).documents[0].markdown).toBe(original)
// 부족한 예산 경로:
await expect(command).rejects.toThrow(/문서 전문|원문/)
expect(requestModel).not.toHaveBeenCalled()
expect(saveDocument).not.toHaveBeenCalled()
```

## Task 4: 직접 편집의 본문 제한 제거

**Files:**
- Modify: `src/lib/Others/RisuBardWikiEditor.svelte`
- Test: `src/lib/Others/RisuBardWikiEditor.test.ts`

- [x] 18,961자 이상 문서를 연 뒤 본문에 maxlength가 없고 편집한 전체 내용이 저장되는 회귀 테스트를 추가한다.
- [x] 기존 maxlength 때문에 테스트가 실패함을 확인한다.
- [x] Markdown textarea의 maxlength만 제거한다. 제목과 별칭 등 메타데이터 검증은 유지한다.
- [x] 컴포넌트 테스트를 실행한다. 브라우저에서 실제 키보드 추가 입력, 수정, 저장 및 재열기를 데스크톱과 모바일 화면 크기로 확인하고 스크린샷을 검사한다.

```ts
expect(editor.hasAttribute('maxlength')).toBe(false)
expect(editor.value.length).toBeGreaterThan(18_961)
// 키보드 입력은 실제 브라우저에서 확인. 값 대입만으로 maxlength 검증을 대신하지 않음.
```

## Task 5: 검증과 기록

**Files:** 최신 `patchnote/0.9.52.md`에 이번 작업의 항목만 추가. 다른 작업의 기존 내용을 보존한다.

- [x] 실패를 재현한 테스트와 관련 회귀 테스트의 최종 결과를 기록한다.
- [x] `git diff --check`를 실행하고 이번 수정만 검토한다.
- [x] 긴 결과의 불필요한 저장 거부 해소와 입력 전문을 보존할 수 없을 때의 안내를 사용자 관점으로 패치노트에 기록한다.
- [x] 체크포인트 SHA, 실제 수정 범위, 남은 전체 설계 범위를 보고한다. 이번 수정이 부분 편집이나 회수율 목표를 달성했다고 쓰지 않는다.

## 실행 기록

- 문서 작성 시점: 구현 전. 사용자 요청에 따라 문서 push 후 Task 2부터 시작한다.
- Ruling: 저장소에 다른 작업의 미커밋 변경이 있으므로 체크포인트에는 새 설계 문서 두 개만 포함한다. 기존 작업 전체를 체크포인트로 묶지 않는다.
- Ruling: 초기 구현은 실제 확인된 바드챗 안전 결함부터 수행한다. 사용자 지시는 '그런 뒤 구현 시작'이며 장기 기억 전체를 한 번에 완성했다고 보고하지 않는다.
- Ruling: 추가 제보와 직접 편집기 코드 확인 후 첫 구현에 textarea 제한 제거와 브라우저 입력 검증을 포함한다. 사용자가 본문 글자 제한의 완전 제거를 명시했다. 모델 컨텍스트 예산과 안전 검증은 문서 저장 상한과 구분한다.

### 2026-09-29 실행 결과

- Task 1 완료: `c286fe653e8379b1aa0a515302684d00ec9982ff`, `origin/main` push 및 GitHub 작성자/커미터 `rpaddict` 확인 후 구현 시작.
- Task 2~4 완료: 직접 편집 textarea와 바드챗 스키마/parser의 본문 길이 제한 제거. 모델 입력에서 편집 대상 문서 전문 보존. 원인이 다른 불완전 결과의 오류 안내 분리.
- RED: 기존 코드에서 새 회귀 테스트 8개 실패, 기존 테스트 60개 통과. 길이 초과와 편집기 maxlength를 재현했다.
- GREEN: `directWikiCommand.test.ts`, `RisuBardWikiEditor.test.ts`, `memoryWiki.test.ts` 총 93개 통과.
- 실제 Chromium: 운영 편집기 컴포넌트, 실제 수동 저장 HTTP 경로와 Markdown 저장 서비스를 별도 임시 데이터에 연결했다. 18,961자 문서를 키보드로 추가 및 중간 수정하고, 데스크톱 1,360×900에서 18,979자, 모바일 390×844에서 18,996자로 저장했다. 페이지 재열기와 실제 파일 읽기로 내용 및 두 위키 링크 보존을 확인했다. 사용자 실제 데이터는 사용하지 않았다.
- 시각 검증: 두 화면의 스크린샷에서 편집기 배치, 줄바꿈, 가로 넘침과 조작부를 확인했다. 브라우저 페이지 오류 0건.
- 독립 코드 리뷰: 변경한 구현 및 테스트 4개 파일을 검토했고 조치가 필요한 문제를 발견하지 못했다.
- 검증 한계: 외부 AI 제공자의 실제 응답은 호출하지 않았다. 바드챗 경로는 정상/잘림/잘못된 응답 fixture로 검증했다. 전체 앱 배포본과 물리 모바일 기기는 검증 대상이 아니다.
- 남은 전체 설계: 동적 예산 드롭다운, 주제별 부분 편집, 캐릭터 연대기, 원문 의미 검색 및 실제 회수율 측정은 별도 후속 단계이며 이 수정에 포함되지 않았다.
