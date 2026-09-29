# BardWiki 버전 관리 기반 세이브 시스템 구현 계획

- 상태: 설계 및 구현 계획. 이 문서 작성으로 기능이 구현되거나 검증된 것은 아니다.
- 범위: 자체 구현 `commit / branch / checkout`, 채팅과 위키의 시점 일치, 메시지 삭제·재생성·특정 메시지에서 fork, 기존 세이브 및 Markdown 호환, 기존 사용자 이관.
- 제외: merge, Git 실행 파일 의존, 원격 저장소·동기화 프로토콜, 모든 앱 설정의 버전 관리.

## 1. 목표와 사용자 결정

### 필수 목표

1. 위키가 바뀔 때마다 채팅 근거와 연결된 커밋을 남긴다. 사건뿐 아니라 인물·장소·장면·물건 등 정본도 같은 시점으로 복원한다.
2. 현재 위키는 기존 경로의 일반 Markdown 파일로 유지한다. 다른 편집기에서 읽고 고칠 수 있어야 한다.
3. 매 갱신마다 전체 위키나 전체 채팅을 복제하지 않는다. 변경된 내용만 저장하고 공통 이력은 공유한다.
4. 채팅 뒤쪽 삭제는 해당 시점 checkout, 특정 메시지에서 fork는 해당 시점에서 새 채팅과 브랜치를 만든다.
5. 기존 수동 세이브의 생성·덮어쓰기·목록·미리보기·불러오기를 유지한다. 이력이 없는 기존 채팅도 데이터 손실 없이 사용한다.

### 이번 논의에서 확정한 정책

| 문제 | 사용자 결정 | 구현상 의미 |
| --- | --- | --- |
| 중간 메시지만 삭제 | 뒤의 대화를 남기고 삭제 직전부터 재분석 | 단순 checkout으로 완료하지 않는다. 영향받은 가장 이른 안전 지점으로 돌아간 뒤 남은 대화를 재분석한다. 모델 비용과 시간이 발생한다. |
| 기존 채팅의 과거 이력 | 현재부터 기록하고 과거는 필요할 때 재구축 | 현재 상태를 최초 커밋으로 보존한다. 과거 재구축은 당시 파일의 정확한 복원이 아니라 재분석 결과다. |
| 삭제된 미래·채팅 이력 | 보존하고 영구 삭제 별도 제공 | 복구 참조를 유지한다. 일반 삭제가 디스크의 과거 내용을 지운다는 인상을 주지 않는다. |
| 주기적 자동 세이브 | 커밋 참조 방식으로 전환 | 주기·목록·불러오기는 유지하고 전체 복사를 없앤다. 구버전으로 옮길 때 호환 export를 사용한다. 수동·퀵 세이브와 기존 파일 불러오기는 유지한다. |

### 설계 기본값

- fork 지점은 선택한 메시지를 **포함한** 대화 접두 구간이다. 원본 채팅은 수정하지 않는다.
- 시점 복원은 그 뒤의 자동 갱신뿐 아니라 수동 위키 편집도 함께 되돌린다. 이후 수동 수정만 자동으로 다시 얹는 기능은 제공하지 않는다. 원래 미래는 복구 이력에 남는다.
- 확정 전 reroll·swipe는 위키를 쓰지 않는다. 이미 확정된 응답의 재생성은 위키 checkout과 연동된 명시적 작업으로만 허용한다.
- 이력 없는 구간 재구축 및 중간 삭제 재분석은 대상 범위와 비용 발생을 실행 전에 알린다. 실패·취소 시 원래 채팅과 위키를 그대로 유지한다.

## 2. 현재 코드에서 확인한 출발점

| 영역 | 현재 구현 | 이번 계획에서 바꿀 부분 |
| --- | --- | --- |
| 위키 파일 | [`resolveMarkdownWikiWorkspace`](../../server/node/risubard-markdown-wiki.ts), `createMarkdownNarrativeWiki` | 기존 `wiki/` 경로와 Markdown 형식 유지. 모든 쓰기를 버전 트랜잭션으로 통합한다. |
| 문서 history | 같은 파일의 `.risubard-history`, `.risubard-trash`, `.risubard-review` | 문서 단위 이전 파일은 있으나 일관된 채팅 시점 커밋은 없다. 신규 변경은 공통 이력 저장소를 사용한다. |
| 자동 확정 | [`confirmProjectedNarrativeTurn`](../../src/ts/process/index.svelte.ts), [`memoryAnalysisClient`](../../src/ts/risubard/memoryAnalysisClient.ts) | 위키 쓰기 후 메시지 내용과 확정 플래그를 검사하는 순서 대신, 발행 전에 메시지 revision과 근거를 검증한다. |
| 분석 쓰기 | [`risubard-memory-analysis.ts`](../../server/node/risubard-memory-analysis.ts) | 현재 사건과 정본을 여러 번 저장한다. 분석 작업 단위 staging과 커밋 발행을 연결한다. |
| 분석 receipt | [`CanonicalTurnReceipt`](../../src/ts/risubard/canonicalTurnReceipt.ts) | 출처·사건·정본 afterHash·경고는 있으나 전체 위키의 복원 정보는 아니다. 별도의 commit ID를 연결한다. |
| 요청 직렬화 | [`createRuntimeMemoryService`](../../server/node/risubard-memory-runtime.cjs) | 현재 character/chat별 요청 큐는 있다. 여러 HTTP 요청으로 이루어진 작업 전체, 읽기 일관성, 재시작 복구는 추가 설계가 필요하다. |
| 메시지 삭제 | [`Chat.svelte`](../../src/lib/ChatScreens/Chat.svelte)의 `rm`, `retractEventsBySourceMessages` | 사건 삭제만으로 정본은 과거 상태가 되지 않는다. 채팅 변경과 위키 checkout을 같은 작업으로 다룬다. |
| reroll·swipe | [`DefaultChatScreen.svelte`](../../src/lib/ChatScreens/DefaultChatScreen.svelte), `Chat.svelte` | 확정 여부에 따른 UI 제한뿐 아니라 실행 함수와 서버 발행 경계에서도 검증한다. |
| BARDCHAT undo | `beginBardChatUndo / finalizeBardChatUndo / restoreBardChatUndo` | 현재 프로세스 메모리의 문서 전체 사본 대신, 작업 전후 커밋 참조로 교체한다. |
| 작업공간 복사·기존 분기 | [`memoryWikiFork.ts`](../../src/ts/risubard/memoryWikiFork.ts), [`risubard-memory-fork.ts`](../../server/node/risubard-memory-fork.ts), `Chat.svelte` | 현재 메시지 분기 UI는 있지만 과거 분기는 위키 확정 상태를 초기화하고 위키를 복사하지 않는다. 서버도 historical workspace branch를 거부한다. 기존 UI를 정확한 시점별 VCS fork로 교체한다. |
| 수동 세이브 | [`risubard-memory-save.ts`](../../server/node/risubard-memory-save.ts) | `save-slot:<id>` 작업공간, `chat.bin`, `risubard-save.json` v1을 유지한다. |
| 이관·플러그인 | [`characters.ts`](../../src/ts/characters.ts), [`pluginBardWiki.ts`](../../src/ts/risubard/pluginBardWiki.ts), [`wikiTransfer.ts`](../../src/ts/risubard/wikiTransfer.ts) | 복제·import·export·플러그인 쓰기도 누락 없이 연결한다. |
| 기존 CAS·파일 트랜잭션 | [`file-kv.cjs`](../../server/node/file-kv.cjs), [`file-store.cjs`](../../server/node/file-store.cjs) | hash 객체 저장과 파일 트랜잭션 원시 기능을 재사용한다. 기존 KV의 manifest 전용 GC에 Wiki 객체를 그대로 섞지 않는다. |

현재 확정 전 후보를 위키에 기록하지 않는 계약은 [BardWiki 사용 가이드](../ko/memory-wiki.md)의 자동 분석 절과 일치한다. 이 계획은 이를 폐기하지 않고, 확정 이후의 되돌리기와 분기를 추가한다.

## 3. 저장 구조: 현재 Markdown + 공유 이력 저장소

### 3.1 저장소 범위

캐릭터별 저장소 하나와 채팅별 working tree를 사용한다. 같은 캐릭터에서 갈라진 채팅은 불변 객체를 공유하고, 서로 다른 캐릭터로 복사할 때는 필요한 객체만 대상 저장소로 가져온다. 전역 저장소는 캐릭터 삭제와 권한 경계를 복잡하게 하므로 도입하지 않는다.

아래의 `<encoded-id>`는 기존 ID 경로 인코딩을 뜻한다. 사용자 입력을 경로로 직접 사용하지 않는다.

```text
risubard/characters/<encoded-character-id>/
  wiki-vcs/
    format.json
    objects/<hash-prefix>/<hash>       # 불변 Markdown·보조 상태 blob
    commits/<commit-id>.json           # 단일 부모 + 변경 목록 + 채팅 연결
    checkpoints/<commit-id>.json       # 주기적인 경로→blob 메타데이터
    refs/branches/<branch-id>.json
    refs/saves/<save-id>.json
    refs/recovery/<recovery-id>.json
    operations/<operation-id>/         # durable journal, staging, receipt
  chats/<encoded-chat-id>/
    wiki/                              # 지금과 같은 읽기·편집 가능한 파일
      events/*.md
      characters/*.md
      ...
      current-scene.md
      index.md                         # 재생성 가능한 색인
    wiki-vcs-link.json                  # repo/branch/head/materialized revision
```

- `wiki-vcs/`를 기존 `.risubard-snapshots` 아래에 만들지 않는다. 현재 코드에는 해당 legacy 디렉터리를 지우는 정리 로직이 있다.
- working tree와 객체 저장소 사이에 수정 가능한 hard link를 만들지 않는다. 외부 편집으로 과거 blob이 변하면 안 된다. 플랫폼별 reflink는 검증된 경우에만 선택적 최적화로 사용한다.
- fork 시 이력은 참조만 늘지만, 새 채팅의 기존 Markdown 경로를 제공하려면 현재 파일의 materialization은 필요하다. 이를 매 커밋의 전체 스냅샷 저장과 구분한다.

### 3.2 객체와 커밋

**blob**은 직렬화된 파일의 정확한 바이트를 SHA-256으로 식별한다. 동일 바이트는 저장소에 한 번만 쓴다. UTF-8 개행이나 frontmatter를 checkout 시 재정규화하지 않는다.

**commit**은 다음 정보를 가진다. 아래 이름은 신규 스키마 제안이며 기존 필드라고 가정하지 않는다.

```ts
type WikiCommit = {
  schemaVersion: 1
  id: string
  parent: string | null
  operationId: string
  kind: 'baseline' | 'analysis' | 'manual' | 'admin' | 'external'
      | 'rebuild' | 'import' | 'review' | 'policy'
  changes: Array<{
    path: string
    before: string | null
    after: string | null
  }>
  chatAnchor: {
    sourceChatId: string
    boundaryMessageId: string | null
    prefixDigest: string
    evidenceDigest: string
  }
  analysisReceiptRef?: string
  provenance: 'recorded' | 'legacy-baseline' | 'reconstructed'
  createdAt: string
}
```

- `before / after`는 blob hash다. 새 파일, 수정, 삭제를 같은 형식으로 표현한다. rename은 같은 blob을 참조하는 삭제+추가로 표현한다.
- 커밋은 부모 하나만 가진다. merge commit은 없다. ID는 ID 필드 자체를 제외한 결정적 직렬화의 hash로 만든다.
- 외부 편집도 발견 후 `external` 커밋으로 편입한다. 디스크에 있는 미커밋 변경을 checkout이 조용히 덮어쓰지 않는다.
- 파일 변경이 없으면 내용 커밋을 늘리지 않는다. 대신 분석 완료 receipt와 메시지→현재 commit 연결을 영속화하여 같은 메시지를 계속 분석하지 않는다.
- 하나의 메시지는 최초 확정, 추가 분석, 재분석 등 여러 커밋과 연결될 수 있다. `messageId → commitId` 하나만 저장하는 설계는 피한다.

### 3.3 효율성

기본 구현은 **변경된 파일 전체 blob + 커밋별 경로 delta**다. 매 턴 전체 위키를 복사하지 않으며, 텍스트 patch chain이나 자체 압축 pack 포맷은 만들지 않는다.

- 커밋의 새 본문 저장량: 변경된 파일 중 기존에 없는 바이트의 합.
- 변경 없는 문서와 fork 이전 공통 이력: 추가 본문 저장량 0.
- 최신 경로 맵과 메시지 경계 인덱스는 파생 캐시로 유지한다. 매 갱신마다 모든 파일을 다시 읽고 hash하지 않는다.
- 주기적인 경로→blob 체크포인트로 긴 delta replay를 제한한다. 본문은 복제하지 않는다. 초기 기준은 누적 delta 수로 잡고 장기 채팅 측정 결과로 조정한다.
- 짧은 거리 checkout은 변경 경로만 materialize한다. 먼 거리 checkout도 경로 맵을 비교하여 실제 차이가 있는 파일만 쓴다.
- 큰 문서의 한 글자 변경도 해당 파일 blob 하나를 새로 저장한다는 비용은 남는다. 전체 위키 복사보다 단순하고 안전한 기본안이다. chunk dedup은 실제 저장량 측정으로 필요가 입증된 경우에만 별도로 설계한다.

저수준 hash·검증·임시 파일·flush·rename은 기존 `file-kv.cjs`와 `file-store.cjs`의 구현을 재사용한다. 필요한 저장 루트 인자만 공통 helper로 추출하고 별도의 유사 구현을 복제하지 않는다. Wiki 전용 객체 namespace와 ref 관리는 새로 둔다. 기존 `gcChunks()`는 KV manifest의 참조만 보므로 Wiki blob을 `kv/objects`에 직접 넣으면 과거 객체가 삭제될 수 있다.

### 3.4 무엇을 버전 관리할 것인가

- 포함: 사건·정본·현재 장면 Markdown, 문서 ID·출처·상태·context mode 등 frontmatter, review 동작에 필요한 기준 내용과 상태.
- 별도 영속 연결: 분석 receipt, 메시지별 확정 상태와 그 근거 revision, working tree의 branch/head, 작업 journal.
- 제외 후 재생성: `index.md`, 문서 캐시, 건강도, 검색·임베딩 색인. 임베딩 벡터 재사용은 content hash로 하되 현재 커밋에 존재하지 않는 문서는 조회 후보에서 제외한다.
- 기존 history/trash는 이관 시 보존한다. 신규 변경에서 동일 내용을 VCS와 history에 이중 저장하지 않도록 문서 이력·휴지통 기능의 backend를 VCS로 전환한다. 기존 데이터는 이관 검증 전 삭제하지 않는다.
- 원본 채팅의 일반 저장 형식과 캐릭터 설정 저장 방식은 유지한다. 채팅 전체를 매 커밋 복사하는 별도 시스템은 만들지 않는다.

## 4. 채팅과 커밋을 연결하는 규칙

### 4.1 안정 식별자와 변경 감지

채팅 ID, 메시지의 `chatId` 기반 안정 ID, 메시지 revision, 순서가 보존된 prefix digest를 사용한다. 배열 인덱스나 생성 시각만으로 복원 지점을 결정하지 않는다.

- ID가 없는 기존 메시지는 최초 이관에서 안정 ID를 부여하고 기존 채팅 저장 경로로 먼저 영속화한다.
- 본문, 역할, 활성 여부, 선택된 swipe, 분석 대상 정책처럼 근거를 바꾸는 변경은 digest/revision에 반영한다. 실제 분석에 사용된 정규화된 근거의 digest도 별도로 남긴다.
- 편집 시점 이후 prefix digest만 무효화한다. append 때 매번 전체 채팅을 다시 hash하지 않는다.
- 첫 메시지, 대체 greeting, OOC 제외, 사용자 메시지 분석 제외의 기존 규칙을 유지한다. 표시 메시지 수와 분석 턴 수를 혼동하지 않는다.
- swipe 후보는 동일 메시지의 서로 다른 revision으로 다룬다. 미선택 후보 자체를 위키 커밋하지 않고, 선택된 내용의 digest만 현재 근거로 사용한다.
- `disabled: true`, `disabled: 'allBefore'`, comment, `firstMessageDisabled`와 branch marker의 의미를 기존 projection대로 구분한다. 배열 마지막 요소와 마지막 활성 서사 메시지는 다를 수 있다.
- greeting의 synthetic ID에는 원래 채팅 ID가 들어갈 수 있다. fork의 공통 접두 구간에는 원래 근거 namespace를 보존하고 새 채팅의 표시·조회용 origin mapping을 둔다. ID 문자열만 일괄 치환하여 공유 커밋의 근거를 깨뜨리지 않는다.

### 4.2 답변 생성 시점과 위키 확정 시점은 다르다

다음 답변 생성 성공으로 이전 응답이 확정될 수 있다. 따라서 '현재 마지막 메시지'나 'HTTP 요청 시각'을 커밋의 서사 시점으로 사용하면 한 턴 밀린다.

1. 분석 시작 시 대상 메시지와 실제 입력 근거, 시작 head, 채팅 revision을 고정한다.
2. 자동 분석 커밋은 실제 근거가 끝나는 안전한 메시지 경계에 연결한다.
3. 수동 편집·BARDCHAT·외부 편집은 수행 당시의 채팅 경계에 연결한다. 과거 시점에서 수행된 것처럼 소급하지 않는다.
4. 과거 메시지의 추가 분석도 현재 head에서 실행했다면 미래 상태를 부모로 가질 수 있다. 대상 메시지 ID만 보고 과거 커밋으로 분류하지 않는다.
5. 커밋의 유효 경계는 부모의 의존 범위와 이번 작업의 입력 범위를 모두 포함한다. 선택한 채팅 접두 구간과 일치하는 조상 커밋만 checkout 후보가 된다.

이 규칙으로 '10턴 추가 분석 커밋'에 30턴의 상태가 들어 있는데 10턴 fork에 재사용하는 미래 정보 누출을 막는다.

### 4.3 확인 상태는 복원 가능한 데이터

현재 `risubardMemoryConfirmed`와 `risubardCanonicalReceipt`만으로 복원 정확도를 판단하지 않는다. 신규 연결에는 commit/operation ID와 근거 revision을 함께 저장한다.

- checkout 후 해당 head에 실제 반영되어 있고 근거도 일치하는 메시지만 확정 상태를 유지한다.
- 나중에 생성된 receipt를 오래된 채팅 사본에서 그대로 가져오지 않는다.
- 위키 변경 없는 성공 분석도 영속 receipt로 구분한다.
- fork에서 유지한 접두 구간의 메시지 ID는 보존하고 채팅 ID와 branch ID는 새로 만든다. 복사본에서 새로 쓰는 메시지 ID는 충돌하지 않게 생성한다.

## 5. 트랜잭션과 장애 복구

### 5.1 논리 작업 하나를 커밋 하나로 발행

자동 분석 1회에서 사건과 여러 정본이 바뀌면 전체 결과를 staging에 모아 커밋 하나로 발행한다. BARDCHAT 다중 문서 작업, rename과 역링크 변경, 찾기/바꾸기도 같은 원칙을 적용한다.

- 모델 호출은 긴 쓰기 락 밖에서 한다. 읽은 head와 문서 hash를 고정하고, staging 내부에서는 앞서 생성한 변경을 읽을 수 있게 한다.
- 발행 시 `expectedHead`, 채팅 revision, 관련 메시지 digest, 문서 hash를 다시 검사한다. 달라졌다면 결과를 현재 branch에 붙이지 않고 충돌로 종료한다.
- 현재 자동 분석의 부분 성공 계약은 보존한다. 저장 가능한 사건·정본과 실패 경고를 하나의 `partial` 결과 receipt로 원자 발행하고, 추가 분석은 뒤의 커밋으로 남긴다. UI에서 완료와 부분 성공을 구분한다.
- 디스크 오류·취소로 일부 파일만 노출되는 상태는 부분 성공으로 취급하지 않는다. 발행 전이면 전체 폐기, durable 발행 결정 이후면 복구 절차로 완료한다.

### 5.2 파일·참조·채팅의 원자성

파일 하나의 rename은 전체 위키나 채팅과의 원자성을 보장하지 않는다. 아래를 담당하는 서버 작업 coordinator를 추가한다.

1. `operationId`와 expected revision으로 작업을 시작하고 immutable blob 및 commit을 준비한다.
2. journal에 이전/다음 head, 변경 파일, 채팅 변경 payload, 진행 상태를 기록한다. 채팅 payload는 변경 메시지·필드와 필요한 삭제 구간만 포함하고 매번 전체 채팅을 보관하지 않는다.
3. 캐릭터 repository ref와 관련 chat에 정렬된 락 순서를 적용한다. 서버 재시작까지 고려한 단일 writer 소유권을 사용한다. 메모리의 Promise 큐만으로 다중 프로세스 안전성을 주장하지 않는다.
4. durable publish 결정을 기록한 뒤 working tree, refs, 채팅 파일을 완료한다. 진행 중인 앱의 위키/채팅 조회·생성은 이전 상태만 제공하거나 완료까지 대기시키며 혼합 상태를 제공하지 않는다.
5. 채팅 저장은 기존 codec·서버 저장 경로를 재사용하는 adapter로 연결한다. UI 메모리 변경이나 debounce autosave만으로 성공 처리하지 않는다. 일반 autosave도 pending operation 및 expected revision을 존중해야 한다.
6. 최종 receipt를 영속화한 뒤 성공 응답과 캐시 무효화를 보낸다. 동일 operation ID 재호출은 같은 결과를 반환한다.

복구 규칙:

- durable publish 결정 전 중단: staging 폐기, 이전 상태 유지.
- publish 결정 후 중단: journal로 끝까지 재실행. 완료 전 해당 채팅은 편집·생성을 잠근다.
- 서버 성공 후 응답 유실: 상태 조회/동일 ID 재요청으로 receipt 회수. 동일 커밋을 또 만들지 않는다.
- 채팅 저장 실패: 위키만 성공한 것으로 반환하지 않는다. durable 결정에 따른 복구가 완료될 때까지 pending/error를 표시한다.
- 디스크 부족·잘못된 blob·안전하지 않은 경로: 원래 데이터 보존, 오류 노출. 임의로 빈 위키로 초기화하지 않는다.

rename만으로 전원 차단 내구성을 보장하지 않는다. 파일과 journal flush, 지원되는 플랫폼의 directory sync 및 재시작 시 복구 검증을 구현 범위에 포함한다.

외부 편집기는 이 락을 따르지 않으므로 다중 파일 checkout을 원자적으로 관찰한다고 보장할 수 없다. 쓰기 전 dirty 검사와 직전 파일 hash 검사를 수행하고, 감지된 충돌은 보존·중단한다. 작업 중 외부 동시 편집은 지원 제한을 안내한다.

## 6. 사용자 동작별 처리

| 동작 | 채팅 | 위키 및 이력 |
| --- | --- | --- |
| 일반 자동 확정 | 기존 확정 타이밍 유지 | 작업 결과를 commit하고 메시지 근거와 연결 |
| 추가 분석·재분석 | 원문 유지 | 현재 head의 자식 commit, 과거 경계로 소급하지 않음 |
| 수동 수정·플러그인 쓰기·관리자 명령 | 현재 경계 유지 | 모든 변경 경로를 동일 트랜잭션으로 처리 |
| 확정 전 reroll·swipe | 현재 후보 교체 | 후보가 미반영임을 검증하고 head 유지 |
| 확정 후 마지막 응답 재생성 | 대상 응답을 교체 | 대상 이전의 안전한 head로 checkout 후 생성. 이전 미래 보존 |
| 뒤쪽 메시지 삭제 | 선택 범위 제거 | 남는 prefix에 맞는 head checkout, 이후 receipt 정리 |
| 중간 메시지만 삭제·근거 편집 | 후속 대화 보존 | 안전한 head부터 남은 대화 재분석 후 새 분기 발행 |
| 선택 메시지에서 fork | 선택 메시지까지 새 채팅 | 해당 prefix의 head로 새 branch, 원본 불변 |
| 채팅 전체 삭제 | 활성 목록에서 제거 | branch와 필요한 채팅 복구 자료를 recovery ref로 보존 |
| 세이브 불러오기 | 기존 저장된 채팅 복원 | 저장 head에서 새 활성 분기, 이전 미래는 recovery ref로 보존 |
| 위키 리부트 | 원문 유지 | staging branch에서 재구축 후 일괄 교체. 기존 branch 보존 |

### 6.1 뒤쪽 삭제와 확정 후 reroll

- 남은 prefix와 호환되는 가장 최신의 조상 commit을 찾는다. 메시지별 여러 분석, 수동 수정, 부분 성공이 포함된 경우도 같은 기준을 사용한다.
- 변경 대상이 아직 위키에 반영되지 않았다면 checkout은 no-op이며 채팅 변경만 수행한다.
- 되돌리기 전 head를 recovery ref로 남긴다. 단순 rollback은 활성 ref를 과거로 이동시키고, 이후 새 커밋은 그 head에서 이어진다.
- 생성에 사용하는 위키와 검색 캐시는 대상 이전 상태여야 한다. 생성 후에 늦게 되돌리는 순서는 금지한다.
- 재생성 실패·취소 시 원래 응답과 head를 복구한다. 작업 중 다른 쓰기를 막아 되돌리기가 무관한 변경을 덮지 않게 한다.
- 이력이 없는 지점으로 넘어가면 §8의 재구축 경로를 사용한다. 최신 위키를 과거 위키로 위장하여 생성하지 않는다.

### 6.2 중간 삭제·근거 편집

1. 삭제·편집된 메시지와 실제 분석 입력 의존성을 기준으로 가장 이른 영향 지점을 찾는다. 직접 사건 출처에만 없다는 이유로 영향이 없다고 판단하지 않는다.
2. 그 이전의 안전한 커밋에서 staging branch를 만든다.
3. 변경 후 남는 원문을 순서대로 재분석한다. 후속 AI 답변 자체를 다시 생성하는 것은 아니다. 원문 간 모순이 남을 수 있다는 점을 안내한다.
4. 영향 구간의 옛 확정 플래그·receipt를 무효화하고 새 결과로 연결한다. 삭제 이후 수동 편집을 자동 재적용하지 않는다.
5. 성공 시 변경 채팅과 재구축 branch를 같이 발행한다. 실패·취소 시 원본 유지, staging은 재개 또는 폐기 가능하게 한다.

### 6.3 특정 메시지에서 fork

- 기존 메시지 Branch/Split 메뉴를 `여기까지 새 채팅으로 분기` 동작으로 교체한다. 중복 메뉴를 추가하지 않는다. 과거 분기에서 확정 상태만 초기화하고 리부트를 안내하던 경로를 VCS checkout 또는 주문형 재구축으로 대체한다.
- 분기에는 선택 메시지까지의 원문, 대응하는 scriptstate·greeting·채팅별 설정을 포함한다. 이후 메시지에만 속하는 pending 분석·receipt·리부트 작업은 복사하지 않는다.
- 선택 메시지가 미확정이면 그대로 미확정으로 복사한다. fork만 했다고 새 모델 호출로 임의 확정하지 않는다.
- 새 branch ref는 공통 commit을 가리키고, destination Markdown working tree를 materialize한다. 이후 두 채팅은 독립적으로 갱신된다.
- 단순 전체 채팅 복제도 같은 VCS 경로를 사용한다. 캐릭터 간 복제는 ID와 출처 namespace를 검증하고 필요한 객체 closure만 가져온다.

### 6.4 리부트와 배치 분석

기존 1턴/2턴 리부트 배치는 실제로 두 턴을 합쳐 정본을 갱신할 수 있다. 2턴 결과에서 첫 턴만의 정확한 상태가 있었다고 기록하면 안 된다.

- 배치 경계는 실제 발행 가능한 checkpoint로 기록한다.
- 배치 내부 시점에서 fork/삭제가 필요하면 직전 checkpoint부터 선택 경계까지 재분석한다. UI는 즉시 정확 복원과 재구축 필요를 구분한다.
- 매 메시지 즉시 checkout을 반드시 제공하려면 재구축 시 1턴 단위 커밋이 필요하다. 두 턴을 함께 분석한 결과에서 가짜 중간 커밋을 만들지 않는다.
- 리부트의 기존 staging·재개·교체 계약을 VCS 작업 journal과 연결하여 서로 다른 복구 시스템이 같은 working tree를 따로 복원하지 않게 한다.

## 7. 기존 세이브·전송 호환성

### 7.1 수동·퀵 세이브 유지

현재 `risubard-save.json` parser는 v1의 키 집합을 엄격하게 검사한다. `commitId`를 기존 manifest에 무작정 추가하면 호환성이 깨진다.

- 기존 manifest v1과 `chat.bin`, 현재 Markdown payload를 그대로 유지한다.
- VCS 정보는 별도 sidecar와 repository의 `refs/saves`에 기록한다. sidecar가 없어도 정상 legacy 세이브다.
- 세이브 생성은 dirty 외부 편집 편입 및 진행 중 작업 완료 후, 같은 채팅 revision과 Wiki head를 읽어서 실행한다.
- 수동 세이브는 독립적으로 읽을 수 있는 호환 스냅샷으로 남긴다. **명시적 수동 세이브·호환 export의 materialization 비용은 허용하되 자동 커밋마다 이 경로를 호출하지 않는다.** 저장소 전체 이력까지 세이브마다 복사하지 않는다.
- 불러오기 시 참조된 객체가 로컬에 존재하면 재사용한다. sidecar만 남고 객체가 없으면 포함된 Markdown에서 legacy baseline을 생성한다. 없는 과거 이력이 복원됐다고 표시하지 않는다.
- 저장된 manifest·chat bytes·Markdown과 sidecar의 hash가 맞지 않으면 과거 commit 연결을 신뢰하지 않는다.
- 덮어쓰기 세이브는 새 자료와 ref가 모두 완성된 후 교체한다. 기존 세이브 삭제 후 새로 만드는 순서는 피한다.
- 불러오기는 기존 `applyMemorySavePromptSettings()` 계약을 유지한다. 이야기 상태는 복원하되 현재 사이드바의 persona·bot/model preset·toggle 설정을 과거 값으로 덮지 않는다. Painter scope 등 채팅 외부 참조의 재바인딩도 유지한다.

### 7.2 import/export·백업

새 history 저장소 때문에 기존 전송 포맷의 보장 범위를 확대했다고 오해하지 않도록 호환 백업과 전체 백업을 구분한다.

- 기존 채팅 export와 선택 문서용 `risubard-wiki` v1 패키지의 형식·범위를 유지한다. 선택 문서 패키지는 사건·아크 플롯을 포함하는 전체 위키 백업이 아니므로 VCS 이력 운반용으로 재해석하지 않는다. 기존 payload를 commit 참조만으로 바꾸지 않는다.
- 전체 앱 백업에는 shared repository, refs, chat links가 함께 포함되도록 백업 경로를 갱신한다. 특정 채팅의 이력 포함 export는 해당 branch가 도달하는 객체만 담는다.
- 전체 NodeOnly 백업은 `canonical-backup-inventory.cjs`의 `risubard` 수집과 `backup-restore-transaction.cjs`를 재사용한다. 이력·working tree·채팅이 같은 revision이 되도록 export 중 쓰기를 조정하거나 고정된 객체/파일 집합을 사용한다. 파일 목록을 만든 것만으로 snapshot이라고 판단하지 않는다.
- upstream/settings 백업처럼 원래 BardWiki를 포함하지 않는 모드는 그 계약을 유지하고 제외 사실을 표시한다. Wiki 없는 legacy/KV-only 백업을 복구할 때 기존 디스크의 무관한 위키가 새 채팅에 붙지 않도록 검증·분리한다.
- 이력 없는 import는 현재 상태 baseline을 만든다. 다른 장치의 branch/operation ID 충돌을 namespace로 분리하고, 같은 blob은 hash 검증 후 재사용한다.
- 현재 문서만 가져오는 위키 import·상속은 실제로 쓰인 현재 문서를 새 commit으로 남긴다. 원래 채팅 출처와 현재 채팅 출처를 혼동하지 않는다.
- 미래 버전의 알 수 없는 VCS schema는 무시하고 덮어쓰지 않는다. 현재 Markdown 열람·호환 export는 허용하되 버전 쓰기는 명시적으로 차단한다.
- 구버전 앱이 파일을 바꾼 뒤 신버전으로 돌아온 경우 head와 working tree가 달라질 수 있다. 디스크 변경을 보존하고 외부/legacy 변경으로 편입한다. 기존 commit을 고쳐 맞추지 않는다.

### 7.3 주기적 자동 세이브의 참조 기반 전환

- 기존 자동 세이브 설정의 주기, 슬롯 목록, 미리보기, 불러오기 및 슬롯 개수 정책을 유지한다. `ChatScreen.svelte`의 자동 저장에서 기존 전체 작업공간 복사 함수를 호출하는 경로를 제거한다.
- 신규 자동 세이브는 별도 버전 스키마에 `{saveId, chatStateRef, wikiCommitId, createdAt, preview}`를 저장한다. 구버전 v1 manifest로 위장하지 않는다.
- `wikiCommitId`만 있으면 원문을 복원할 수 없다. 채팅 복구 자료는 최초 기준 상태와 이후 변경된 메시지·순서·scriptstate·채팅 필드의 delta로 보존한다. 메시지 내용 blob은 hash로 중복 제거하고, 주기적 메타데이터 checkpoint로 복원 길이를 제한한다. 일반 채팅 저장 backend는 그대로 유지한다.
- 채팅 원문은 늘었지만 Wiki가 아직 확정되지 않은 자동 세이브도 유효하다. 같은 순간의 chat state와 Wiki head를 함께 pin하고 미확정 상태를 보존한다.
- 자동 세이브의 chat state와 Wiki commit은 둘 다 GC root다. 슬롯 회전 시 다른 save/branch/recovery가 필요한 자료를 지우지 않는다. 복구 참조의 영구 보존 정책과 자동 슬롯 표시 개수 정책을 구분한다.
- 불러올 때 참조를 materialize하고 기존 수동 세이브와 같은 coordinator 및 설정 유지 규칙을 사용한다. 기존 v1 자동 세이브도 계속 읽으며 새로 만드는 슬롯부터 참조 방식으로 전환한다.
- 구버전 앱으로 이동할 때 `호환 세이브로 내보내기`가 기존 `chat.bin`·v1 manifest·Markdown을 생성한다. 신규 참조형 자동 세이브 자체는 구버전 직접 읽기를 보장하지 않는다는 사용자 선택을 UI에 표시한다.
- 생성·덮어쓰기·회전·불러오기·호환 export를 모두 재시작 복구 대상으로 포함한다. 세이브 목록에서 참조만 있고 내용이 손상된 항목을 정상 세이브로 표시하지 않는다.

## 8. 기존 사용자·이력 없는 채팅 이관

### 8.1 첫 접근 시 lazy baseline

1. 진행 중인 기존 리부트·복사·세이브 작업을 먼저 완료하거나 기존 복구 규칙으로 정리한다.
2. 메시지 ID와 채팅 저장 상태를 검증한다. placeholder/부분 로드 채팅을 전체 원문으로 취급하지 않는다.
3. 현재 위키 파일과 필요한 review 상태를 한 번 읽어 blob으로 저장한다.
4. `legacy-baseline` root commit과 현재 채팅 경계, branch/link를 영속화한다. 현재 내용은 변경하지 않는다.
5. 기존 확정 플래그·receipt는 참고 자료로 보존하지만 도입 이전의 정확한 시점별 상태가 존재한다는 보증으로 사용하지 않는다.
6. 완료 marker는 파일·커밋·연결이 모두 검증된 후 기록한다. 중간 중단 뒤 재실행해도 baseline을 중복 생성하지 않는다.

기존 문서별 history 파일에는 여러 문서와 채팅 변경을 묶은 완전한 순서가 없으므로 이를 추측하여 턴별 commit으로 변환하지 않는다. 기존 수동 세이브도 검증 가능한 독립 checkpoint일 뿐, 서로의 parent 관계를 시각만으로 만들지 않는다.

### 8.2 도입 이전 시점으로 가야 할 때

- UI에 `이 시점은 기록 시작 이전입니다. 채팅으로 위키를 다시 구성합니다.`를 표시한다.
- 현재 baseline은 미래 내용을 포함할 수 있으므로 과거 재구축의 초기 위키로 사용하지 않는다.
- 검증 가능한 그 이전의 세이브/초기 source snapshot이 있으면 사용하고, 없으면 빈 위키와 확인 가능한 초기 설정에서 해당 prefix만 분석한다. 최신 정본을 seed로 끼워 넣지 않는다.
- 사용자 수동 지식·외부 위키 import 등 원문에서 복원할 수 없는 내용은 자동 복구된다고 약속하지 않는다. 현재 원본 branch와 legacy 파일을 보존하고 누락 가능성을 알린다.
- 모델·프롬프트·설정이 달라질 수 있으므로 새 커밋은 `reconstructed`로 표시한다. 정확한 과거 복원과 시각적으로 구분한다.
- 재구축은 대상 채팅에서 필요한 구간만 실행하며, 재개 위치와 고정된 작업 설정을 기록한다. 앱 시작 때 전체 사용자의 모든 채팅을 일괄 분석하지 않는다.

### 8.3 위키 없음·일부 손상·세이브만 있음

- 원래 위키가 없는 채팅은 빈 baseline에서 시작한다. 데이터가 있었는데 파일이 없어진 손상 상태와 구분한다.
- 세이브만 있으면 기존 방식으로 읽은 뒤 현재 내용 baseline을 만든다.
- hash 오류나 누락된 객체는 오류로 표시하고 현재 Markdown/정상 세이브를 복구 원본으로 제시한다. 자동으로 손상 객체를 정상 커밋으로 인정하지 않는다.

## 9. 삭제, 복구 참조, 영구 삭제

- 일반 뒤쪽 삭제·되돌리기·세이브 로드·리부트 교체 전 head를 recovery ref로 보존한다.
- 채팅 전체 삭제는 branch와 채팅 복구에 필요한 원문도 보존한다. 위키 ref만 남겨 놓고 '채팅 복구 가능'이라고 표시하지 않는다. 삭제된 구간은 변경 payload 또는 별도 복구 자료로 중복 없이 보관한다.
- 복구 이력 UI에서 원본으로 되돌리기 또는 새 채팅으로 열기를 제공한다. 활성 채팅을 덮는 경우 동일한 checkout coordinator를 사용한다.
- 일반 삭제 확인에 과거 이력이 디스크에 남는다는 설명을 넣는다.
- 영구 삭제는 삭제할 recovery ref·branch·save의 범위를 보여 주고 명시적으로 실행한다. 다른 활성 branch나 세이브가 같은 객체를 참조하면 해당 내용은 남는다고 알린다.
- GC의 roots는 활성 branches, saves, recovery refs, 미완료 operations다. mark-and-sweep 중 새 참조가 생겨도 지워지지 않도록 repository 락 또는 안전한 generation 경계를 둔다.
- recovery ref의 자동 보존 기간 만료는 도입하지 않는다. 명시적 영구 삭제 후 도달 불가능한 객체를 정리한다. 기존 자동 세이브 슬롯 회전은 §7.3의 별도 정책이며 복구 이력을 함께 만료시키지 않는다.
- 이 기능은 앱이 관리하는 데이터 삭제다. OS 백업, 이미 내보낸 파일, SSD의 물리적 secure erase까지 보장하지 않는다.

## 10. 구현 단위와 순서

각 단계는 앞 단계의 계약을 사용한다. 버전 관리 저장소만 만든 상태를 사용자 기능 완료로 보고하지 않는다.

### A. 스키마·저장소 코어

- 신규 `server/node/risubard-wiki-vcs.ts`와 공유 타입 모듈을 추가한다. blob, commit, branch/ref, checkpoint, log/status, checkout 대상 계산을 구현한다.
- 기존 `file-kv.cjs`의 객체 저장 원시 기능과 `file-store.cjs`의 atomic write/recovery를 연결한다. Wiki 전용 ref·GC와 기존 KV manifest GC의 소유 범위를 분리한다.
- path confinement, symlink 차단, hash 검증, schema 버전, 순환/누락 parent 검증을 포함한다.
- `commit`, `createBranch`, `prepareCheckout`, `publishOperation`, `getOperation`, `listHistory`를 명시적 서비스 API로 정의한다. detached head에서 암묵적으로 쓰지 않는다.
- 완료 기준: 파일 추가·수정·삭제·rename이 왕복 복원되고 두 branch가 같은 blob을 안전하게 공유한다.

### B. 공통 트랜잭션과 모든 쓰기 연결

- `risubard-markdown-wiki.ts`의 직접 파일 변경을 staging writer로 이동한다. runtime/routes에 operation context와 expected head를 연결한다.
- 자동 분석, 추가 분석, BARDCHAT, 문서 편집, review, context 정책, 휴지통, 사건 변경, replace-all, 플러그인, import/상속 경로를 모두 이관한다.
- 기존 analysis receipt와 부분 성공 경고는 유지하고 commit 연결을 추가한다. BARDCHAT undo는 커밋 기반으로 교체한다.
- 완료 기준: 지원되는 어떤 쓰기도 working tree만 바꾸고 커밋을 누락하지 않는다. 이전 직접 쓰기 우회로를 남기지 않는다.

### C. 채팅 영속화·경계 연결

- `database.svelte.ts`의 chat/message 타입, `chatStorage.ts`, 실제 저장 backend, `process/index.svelte.ts`, `memoryAnalysisClient.ts`를 연결한다.
- 안정 ID, revision/digest, 분석 receipt linkage, pending operation 복구를 구현한다. debounce 저장과 외부 파일 동기화가 pending 작업을 덮지 않게 한다.
- 완료 기준: 재시작 뒤에도 채팅 내용·확정 상태·Wiki head가 일치한다. 취소되거나 삭제된 메시지의 늦은 분석 결과는 발행되지 않는다.

### D. 삭제·reroll·메시지 fork

- `Chat.svelte`, `Chats.svelte`, `DefaultChatScreen.svelte` 및 채팅 관리의 삭제/복제 경로를 공통 coordinator로 교체한다.
- 뒤쪽 삭제 checkout, 확정 후 reroll rollback, 중간 삭제·편집 재분석, 메시지 fork UI와 scriptstate 복원을 구현한다.
- UI 숨김뿐 아니라 함수와 서버 경계에서도 head/revision을 검사한다.
- 완료 기준: 생성 프롬프트·검색 결과에 삭제된 미래 정보가 들어가지 않고, 원본/분기 채팅이 독립적으로 진행된다.

### E. 세이브·이관·전송

- `risubard-memory-save.ts`, `risubard-memory-fork.ts`, `memoryWikiFork.ts`, `memorySaveSlots.ts`, `memorySavePolicy.ts`, `ChatScreen.svelte`, `RisuBardSaveSlotsDialog.svelte`, `SideChatList.svelte`, `CharacterVaultDialog.svelte`, `characters.ts`, `wikiTransfer*`, 백업/복구 경로를 새 저장소와 연결한다.
- 수동·퀵 세이브의 v1 manifest와 `chat.bin`은 유지하고 sidecar를 사용한다. 자동 세이브는 chat state delta와 Wiki commit 참조로 전환하고 호환 export를 구현한다. legacy baseline 및 주문형 재구축도 구현한다.
- 완료 기준: 과거 세이브를 그대로 불러올 수 있고, 신규 호환 세이브의 현재 내용도 기존 reader로 읽힌다. repository가 없는 export/import도 현재 내용을 잃지 않는다.

### F. 복구·이력 UI와 보존 관리

- branch/head, 정확 복원 가능 범위, legacy baseline, 재구축 상태, pending/partial/error를 사용자에게 표시한다.
- 복구 참조 목록, 복구·새 채팅으로 열기, 영구 삭제 및 공유 객체 안내를 제공한다.
- 완료 기준: 일반 삭제는 복구 가능하고, 명시적 영구 삭제만 참조를 제거한다. 비용 있는 재분석은 몰래 시작하지 않는다.

### G. 통합 검증 및 문서 전환

- 아래 시나리오를 실제 UI와 저장 파일, 서버 재시작까지 확인한다.
- 사용 가이드의 사건만 삭제된다는 설명, 문서 history, BARDCHAT undo, 세이브 및 fork 설명을 구현된 동작으로 갱신한다.
- 새 구현이 대체한 legacy 쓰기·undo·신규 history 중복 저장을 제거한다. 기존 사용자 파일의 삭제는 별도 검증된 이관/정리 작업으로만 수행한다.

## 11. 검증 계획과 완료 기준

### 동작 회귀

1. A→B→C에서 같은 인물의 소지품·관계가 여러 번 바뀐다. C 삭제 후 사건과 정본이 B의 바이트로 복원되고 새 생성에서도 C를 조회하지 않는다.
2. B에서 fork한 채팅이 D로 진행하고 원본은 C에 남는다. 공통 blob은 하나이고 이후 문서 변경은 서로 오염시키지 않는다.
3. 미확정 응답 reroll·swipe는 commit을 만들지 않는다. 확정 응답 재생성은 이전 head를 사용하며 실패 시 기존 응답과 위키를 복구한다.
4. 중간 메시지만 삭제하면 후속 원문은 남고 영향 구간만 재분석된다. 실패·취소 시 원본이 유지되고 성공 후 옛 receipt가 남지 않는다.
5. 동일 메시지 추가 분석, 변화 없는 분석, 정본 일부 실패와 재시도를 거쳐도 checkout이 최초 커밋 하나만 보고 잘못 복원하지 않는다.
6. 과거 메시지 추가 분석·수동 편집이 있는 head를 과거 fork에 잘못 연결하지 않는다. 2턴 리부트 배치 내부 분기는 재구축 필요로 처리한다.
7. rename과 역링크 변경, 삭제, context mode, review/revert, BARDCHAT 다중 문서 작업을 모두 왕복 복원한다.
8. 메시지 편집·삭제·fork와 느린 분석 완료가 겹쳐도 오래된 결과를 새 head에 발행하지 않는다. 두 탭의 동시 쓰기도 같은 검증을 통과해야 한다.

### 내구성·이관·호환

9. blob 기록, journal 준비, durable 결정, 파일 반영, ref 변경, 채팅 저장, 응답 전송의 각 경계에서 프로세스를 종료하고 재시작한다. 이전 또는 완료된 다음 상태로 수렴하고 혼합 상태에서 생성을 허용하지 않는다.
10. 디스크 부족, 잘못된 hash, path traversal, symlink, 손상된 parent chain, 중복 operation ID와 응답 유실을 처리한다.
11. 오래된 채팅을 열어도 현재 Markdown 내용이 바뀌지 않는다. 이관 도중 종료해도 재개할 수 있고, 도입 이전 fork는 미래 내용 없는 재구축 branch를 만든다.
12. v1 세이브 생성·덮어쓰기·미리보기·불러오기, VCS sidecar 누락, repository 없는 이동, 캐릭터 간 복제, 전체 백업 왕복을 검증한다.
    - 자동 세이브의 슬롯 회전·위키 미확정 상태·채팅 delta 복원·호환 export를 별도로 검증한다. 세이브 로드가 현재 sidebar 설정을 되감지 않고, 다른 branch의 원문과 Painter 참조를 섞지 않아야 한다.
13. 외부 Markdown 편집 후 checkout은 변경을 먼저 보존한다. 구버전 앱을 거쳐 파일이 달라진 경우 오래된 head로 조용히 덮어쓰지 않는다.
14. 일반 삭제 후 채팅/위키를 복구한다. 영구 삭제 뒤에도 다른 branch·save가 참조하는 객체는 유지되며 미완료 operation의 객체를 GC가 지우지 않는다.

### 효율성·사용자 표면

- 실제 저장소에서 1,000/10,000턴, 많은 사건 파일, 긴 정본, 여러 branch를 구성하고 신규 바이트 수·커밋 지연·checkout 지연·재시작 replay량을 측정한다. 측정 전 성능 수치를 보장하지 않는다.
- 변경 없는 파일 수가 늘어나도 정상 커밋이 전체 파일 읽기/복사로 증가하지 않는지 확인한다. 최초 baseline, 외부 변경 검사, 수동 호환 세이브 비용은 따로 보고한다.
- 실제 데스크톱·모바일 UI에서 메시지 fork, 삭제 범위, 재분석 비용 안내, 취소·재개, 세이브 로드, 복구 이력과 영구 삭제를 조작한다.
- 테스트는 바이트 복원, 데이터 보존, 미래 정보 배제, 충돌 및 재시작 복구 등 관찰 가능한 계약을 검증한다. 소스 문자열이나 함수 호출 횟수만으로 기능 완료를 판정하지 않는다.

## 12. 남는 제한과 구현 전제

- 존재하지 않았던 과거 커밋을 정확히 복원할 수는 없다. 주문형 재구축은 원래 결과와 다를 수 있다.
- merge를 제공하지 않으므로 분기 뒤 수동 수정의 자동 통합은 하지 않는다.
- 일반 삭제는 프라이버시 목적의 영구 삭제가 아니다. 복구 자료가 남는다.
- 현재 Markdown의 외부 직접 편집과 앱의 다중 파일 작업 사이에는 OS 수준의 공동 트랜잭션이 없다. 감지 가능한 충돌을 보존하고 동시 편집 제한을 알린다.
- 현재 위키가 정본이라는 계약은 유지한다. working tree가 head와 다를 때 디스크를 버리고 head를 무조건 강제하지 않는다. 반대로 이력 참조가 손상됐다는 이유로 과거 기록이 정상이라고 표시하지 않는다.
- 첫 출시의 완료 조건은 저장소 코어만이 아니라 모든 쓰기 연결, 채팅 시점 복원, fork, 세이브 호환, 기존 사용자 이관, 장애 복구와 UI 검증까지다.
