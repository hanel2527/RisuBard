# W2 chat projection

**Goal:** Reduce routine chat save stalls without changing compatibility database durability, transport, startup or backup formats.

**Architecture:** Extend the existing debounce tracker to retain stable chat and character IDs. Select `chatState` only for known chat updates, non-identity character metadata and root settings. Structural edits, other collections, ambiguous IDs and failed saves use the existing full synchronization. The repository commits selected chat JSONL, metadata and sidebar through the existing journal transaction. Full `database.bin` remains written before canonical files. P1 deferred projection is excluded.

**Tech stack:** Node CommonJS, existing file-store transactions, Vitest and isolated server compatibility tests.

- [x] Add failing tests in `server/node/direct-write-tracker.test.ts`, `canonical-projection-writer.test.ts` and `user-data-repository.test.ts` for coalesced chat writes, stable identities, structural fallback, restart equality and direct-write failure fallback.
- [x] Implement `observeChat(key, characterId, chatId)` and snapshot-aware `observe(key, operations, database)` in the existing tracker. `take(key)` returns `{ kind: 'chatState', chats, characterIds, includeRootSettings }` or the existing W1 strings/null.
- [x] Implement `syncLegacyChatState(database, scope)` with topology validation before committing. Wire chat, patch and flush paths through the same tracker, and invalidate direct eligibility after a failed persist.
- [x] Run `npx vitest run --config vitest.config.server.ts` and affected compatibility tests. Confirm stored chat data, root settings and presets survive restart and export.
- [x] Compare full and W2 persistence on isolated data with identical edits. Record median durations and output equality without disclosing user content. Preserve the W1 baseline, document limits in the wiki and update `patchnote/0.9.38.md`.

Validation: 616 server tests, 66 compatibility tests and 9 client storage contracts passed; 5 existing compatibility cases skipped. Timer and external flush persistence now share the existing writer queue. Partial direct journals are recovered before full fallback. Isolated 60.1MB replay reduced median save processing from 1,903ms to 739ms for chat-only changes and from 1,874ms to 1,079ms with settings. Real-use acceptance remains pending.

Acceptance: no loss on mixed writes, fallback or restart; unchanged chats are not planned for publication; measured reduction reported separately from real-user observations. No release or production-data mutation is part of this work.
