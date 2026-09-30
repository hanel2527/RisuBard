# Import classification and rollback

Implement inline on the current public checkout. Preserve unrelated existing changes.

1. Test and implement a metadata-only CHARX preflight: case-insensitive `.module.charx` is a module; otherwise >= 150,000,000 bytes or >= 5,000 archive assets prompts for module/character/cancel. Read ZIP directory without expanding assets.
2. Introduce a cancellable import transaction. Track new asset keys before writing, wait for in-flight work, remove only this import's registered entities, persist removal, and ask the server to reclaim only unreferenced candidate assets. Keep a durable recovery record until rollback succeeds; never report success after a failed rollback.
3. Connect character and module import entry points and batch/decode loops. Keep existing shared assets. Expose cancel/rollback and retry recovery in the existing progress dialog. Block overlapping imports.
4. Run focused classification, transaction, importer and storage tests. Verify the dialog in an isolated browser with real clicks at desktop/mobile sizes. Append 0.9.52 patch notes.

Decisions: MB means decimal MB, so the exact threshold is 150,000,000 bytes. Classification heuristics ask rather than silently convert a large character. Cancellation waits for the current storage request before rollback. A disconnected server leaves recovery pending, with an explicit retry; browser/server interruption cannot be described as an already completed rollback.

UI: preserve the existing modal and typography. Primary content is current import progress; a clearly labelled cancel-and-rollback button is below it. During rollback disable duplicate requests. On failure show a retry action and retain recovery information across reloads.

Validation ledger:

- Completed all four steps. Added ZIP64 directory support so large archive classification does not impose a new 65,535-entry limit.
- Frontend: 88 focused tests passed across classification, transaction ordering, importer integration, batch drain, storage conflict and bulk transport tests. Server: 84 required storage/asset tests passed. Svelte check: zero errors, zero warnings. Server syntax and diff whitespace checks passed.
- Isolated real app on ports 5191/7791: `.MODULE.CHARX` became a module; a 5,000-asset archive showed type selection; cancelling while writing removed new assets and preserved shared assets. Injected a lost write response and unavailable rollback endpoint, then restarted the browser and successfully retried recovery. Cancelled after canonical character persistence: the character and new asset were removed, pre-existing unreferenced and shared assets remained, and the durable rollback marker cleared.
- Visually inspected desktop 1280 and narrow 500 pixel screenshots, including selection, active cancel, disabled rollback and recovery retry. Verified actual button clicks. Test processes stopped; the user's running server was not restarted.
- Fresh read-only review found two important issues: direct import entry points bypassing the transaction, and ordinary character-deletion GC collecting pre-existing assets during rollback. Both fixed and reviewed again. No remaining important findings.
- Ruling: write a durable server rollback marker before deleting imported owners, suppress automatic deletion GC while recovery is pending, then reclaim only journalled new asset candidates. This preserves previously orphaned assets even when cancellation follows an acknowledged canonical save. Recovery keeps the same journal UUID across browser sessions.

## Follow-up: observable large imports

- Added authenticated, import-scoped NDJSON progress from actual server preparation, staging, publication and verification. Canonical import transactions, character-asset replication and rollback reclamation run in a worker; progress I/O stays on the server event loop. Heartbeats track connectivity separately from work. UI shows phase percentages for measured totals, latest filename, elapsed time and time since work updated, with disconnected or stale status notices.
- Import workers recheck the canonical revision before publication and return the verified revision afterward. The server retains storage-queue ownership, defers other API requests during worker publication, waits for worker exit, and reloads directory/asset/KV caches before accepting the result. Cancellation still waits for the current request; workers do not abandon a partially written transaction.
- Replaced repeated filename scans with a collision allocator, retained immutable source paths instead of all asset buffers, and preserved digest verification. Completion flushes canonical data without rebuilding compatibility caches.
- Browser testing uncovered fflate recursion overflow with thousands of tiny entries. A reproducing test failed before bounding every parser input to 32 KiB and passed afterward.
- Validation: 132 server tests, 30 storage tests and 50 importer/progress tests passed before the ZIP follow-up; all 5 ZIP tests and 7 bulk transport/progress tests passed afterward. Svelte check had zero errors/warnings. An isolated browser installed a character with 5,000 linked assets and observed 465 server updates. Inspected desktop and 500 px UI, including actual 86% / 4,287 of 5,002 file staging. Cancellation after persistence removed the new character and cleared recovery markers while retaining two existing characters and 5,000 assets.
- Node 26 HTTP smoke: imported 300 characters, 9,000 messages and 600 asset keys. Received 108 intermediate staging updates before the write response completed; verified reopened canonical chats, the server's 300-character cache and asset bytes.
- HTTP rollback smoke: reclaimed the import-only orphan, retained a referenced candidate and an unrelated pre-existing orphan, and verified the server's reloaded KV view. The cleanup update arrived before rollback finished.
- Concurrent HTTP read smoke: started a database read during staging; it returned the completed 300-character snapshot, not a partial projection. That run delivered 110 intermediate staging updates before the import response finished.
- Final regression: 4,403 frontend tests and 1,025 server tests passed; four tests skipped. `svelte-check` reported zero errors and zero warnings. Node 26 runs use `NODE_OPTIONS=--no-experimental-webstorage` so the DOM test environment owns storage.
