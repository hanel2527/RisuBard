# 파일 정본 사용자 데이터

리스바드의 사용자 데이터 정본은 일반 JSON·JSONL·Markdown과 content-addressed 파일입니다. SQLite와 `database.bin`은 정본이 아닙니다. 기존 클라이언트와 RisuAI 내보내기에 필요한 `database.bin`은 파일 정본에서 다시 만들 수 있습니다.

서버 실행 전에 절대 데이터 루트를 지정할 수 있습니다.

```bash
RISUBARD_DATA_ROOT=/private/path/risubard-data node server/node/server.cjs
```

데이터 루트에는 분리된 설정·credential, 안정 ID 엔터티 파일, 캐릭터/채팅 디렉터리, append 가능한 메시지 JSONL, 요청·시스템 JSONL 로그, 작업별 state/event, 에셋과 BardWiki가 있습니다. 시작 시 작은 manifest만 읽고 본문은 실제 접근 때 로드합니다.

저장은 같은 파일시스템의 temp 작성, fsync, checksum/schema 검증, 원자 rename, 부모 디렉터리 fsync, `.bak` revision과 복구 가능한 다중 파일 journal을 사용합니다. 삭제는 `trash/`로 이동합니다. 사용자 메시지는 모델 요청 전에 fsync하며 assistant 스트리밍 초안을 복구할 수 있습니다.

기존 `.bin`과 save-folder 가져오기는 명시적인 병합 또는 교체 의미를 제공합니다. 옛 `risuai.db`는 `migration-backups/`에 복사한 뒤 한 번만 가져오며 정상 런타임은 SQLite에 의존하지 않습니다. 전체 백업은 파일 정본 트리, 에셋, BardWiki와 호환 내보내기 데이터를 포함합니다.

채팅별 이력 모드는 저장/불러오기 화면에서 명시적으로 시작합니다. `risubard/characters/` 아래의 `story-history/`는 백업·분기·위키 commit·메시지 bind를 보관하고, 기존 `save-store/`의 SHA-256 blob을 재사용합니다. 채팅은 메시지별 blob과 순서·채팅 상태 snapshot으로 저장하여 편집되지 않은 메시지를 복사하지 않습니다. 과거를 불러온 뒤 변경하면 새 분기를 만들며 원래 미래를 보존합니다.

이관·구형 슬롯 복귀의 원본과 매핑은 `risubard/history-transitions/`에 남습니다. 복귀는 모든 이력 백업을 고유 수동 슬롯으로 내보내며, 분기 archive와 참조 blob을 지우지 않습니다. 전체 백업에는 이 데이터도 포함됩니다. 이력에서 참조하는 에셋·인레이는 정리 대상에서 제외되고 같은 ID로 덮어쓰거나 삭제할 수 없으므로 변경본은 새 ID로 저장하세요. 이력은 자동 순환 삭제하지 않으며, 복귀 시 전체 채팅을 슬롯마다 복원할 공간이 추가로 필요합니다.


Termux에서는 `$HOME/.local/share/risubard` 같은 앱 내부 저장소를 사용하세요. 공유 `/sdcard`와 `/storage/emulated`는 신뢰할 수 있는 fsync·원자 rename을 보장하지 않아 정본 루트로 거부됩니다. 공유 저장소에는 완성된 백업 파일만 복사하세요.
