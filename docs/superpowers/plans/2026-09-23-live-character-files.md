# Live character files implementation plan

> Execution: implement in the existing public checkout. Server and client changes are bounded independently, then integrated and reviewed together.

**Goal:** Saving character descriptions, lore, or files in a character's assets directory updates the running app and the next test request without an editing mode or page reload.

**Architecture:** The existing canonical repository validates external JSON and adopts it through its journal. A file watcher invalidates a lightweight live-sync service; authenticated client polling and a pre-send check consume metadata snapshots. Client three-way merging preserves hydrated chats and unrelated unsaved edits. Asset replacements receive immutable KV keys, preserving compatibility exports and invalidating existing image URLs.

**Tech stack:** Existing Node filesystem, CommonJS repository, Svelte state, TypeScript and Vitest. No new dependencies.

**Spec:** User request in this task: no editing mode, no reload, directly edit and test descriptions, lore and assets.

## Constraints

- Preserve unrelated working-tree edits and actual user data. Tests use temporary roots.
- Keep stable IDs, journal recovery, compatibility KV and single-writer authorization.
- Do not accept arbitrary unchecked settings, credentials, package identity or chat files.
- External character metadata retains its ID and field types. Incomplete JSON retains last good application state and reports an actionable error.
- Scope: character metadata and embedded lore, global lorebook JSON, direct files in each character assets folder. Folder/character deletion is not inferred from a transient missing metadata file.

## Review focus

- Partial writes and atomic editor renames: debounce, validation and retry without overwriting input.
- Simultaneous chat streaming: preserve chat and message object identities.
- Concurrent app metadata changes: merge disjoint fields; retain a recovery snapshot for conflicts.
- Asset delete and replace: change only this character's references, keep shared original KV bytes.
- Restart and backup: persisted asset manifest and canonical checksums survive reopening.

## Tasks

- [x] Repository: plain metadata edits, embedded lore removal, global lore deletion, invalid data rejection and restart. Explicit external-edit reconciliation validates all sources before publishing accepted metadata and sidebar in one transaction.
- [x] Asset service: file addition, same-size replacement, deletion, identical-content file isolation, original KV preservation and retry tests. Persist filename-to-immutable-KV mappings with metadata; retire modified A1 routes. Paths remain inside the data root and symbolic links are rejected.
- [x] Server: watch relevant paths, debounce changes, serialize sync with existing storage operations. Authenticated `POST /api/live-files/sync` accepts `{revision}` and returns `{revision,etag,snapshot?,error?}`. Snapshot is `{characters: metadata[], loreBook: []}`; revision changes on external adoption only. Passive polling does not advance the writer lock.
- [x] Client: three-way metadata merge and save/poll serialization tests. Poll every 750ms, refresh before sending, retain active chats, reset acknowledged patch baseline and automatically retry supported conflicts.
- [x] Integrate: actual isolated server HTTP test includes failed deferred-save recovery. Independent review findings reproduced and fixed. Latest patchnote and user editing guide updated.

Validation: client suite 3,554 passed, 3 existing skips; server suite 805 passed. Subsequent A1 original-preservation fix passed 37 targeted server tests including the real HTTP scenario. Svelte check: 0 errors, 0 warnings.

Commands: `node node_modules/vitest/vitest.mjs run`; `node node_modules/vitest/vitest.mjs run --config vitest.config.server.ts`; `node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json`.
