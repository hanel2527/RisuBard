# Optional external file monitoring implementation plan

**Goal:** Disable automatic external file monitoring by default on Termux and provide a persistent server-wide switch in Developer settings.

**Architecture:** A disabled monitor owns no watcher and performs no reconciliation, reset, or acceptance scans. The server gates automatic adoption and sync endpoints while retaining write-time conflict validation and interrupted adoption recovery. Browser clients cache the small monitoring status and skip file-sync requests while disabled.

**Constraints:** Current public checkout only. Preserve existing edits, normal imports, saving, journal recovery and writer authentication. Do not change canonical storage authority. User request in this task is the specification.

- [x] Test and implement monitor lifecycle, platform default and persisted override.
- [x] Wire authenticated server setting and gate automatic sync/adoption; preserve recovery and save validation.
- [x] Add accessible Developer setting and client request suppression tests using existing UI patterns.
- [x] Verify disabled mode, enabled external edits, ordinary writes, persistence and failures; review diff and update latest patch notes.

Validation: final monitoring/server regression run passed 51 tests; final client run passed 35 tests. Required adjacent server storage suites passed. Svelte check reported zero errors and warnings. Review findings were addressed with journal recovery and a flush-or-reject boundary before re-enabling. Termux timing has not been measured on the reported device.

## Follow-up: event-driven browser synchronization

User requested change notifications instead of the 750ms request loop. Use an authenticated SSE stream, debounce watcher signals, announce setting changes and reconnect state, and retain a 60-second missed-event verification only while monitoring is enabled. Notifications contain only status and reason. Reuse the existing serialized reconciliation and save-conflict boundaries.

- [x] Add watcher notifications and bounded SSE broadcasting with cleanup and no file reads.
- [x] Verify authenticated real-server notification delivery and disabled monitoring silence.
- [x] Replace the client poll with coalesced signals, visibility catch-up and slow disconnected fallback.
- [x] Review and run targeted client/server checks, then update release notes.

Follow-up validation: server event, watcher, stability and real HTTP tests passed (55 tests). Client event, transport, UI and storage tests passed; the existing runtime preflight fixture was updated for its current dependencies and its failure/selection checks passed. Svelte check reported zero errors and warnings. Review identified and fixed a notification loop: internal failed-validation invalidation is silent, while actual filesystem events emit notifications.
