# Safe session handoff implementation plan

> Execute inline with executing-plans. Use test-driven-development and verification-before-completion. Review the completed change with requesting-code-review.

**Goal:** Prevent session handoffs from silently losing unsaved chats.

**Architecture:** Keep the server's single-writer protection. Route BroadcastChannel, HTTP 423, inactive live sync and focus checks through one client recovery controller. Pause saves, offer a local recovery download, and require explicit confirmation before reload. Keep user intent for the page lifetime so slow requests do not become passive writes.

**Scope:** Current public checkout only. Preserve unrelated work. No release, commit, push, worktree, server lock weakening or automatic overwrite.

## Tasks

- [x] Add failing transport and recovery tests: delayed user input, inactive sync, cancel/download, concurrent notifications, hidden tabs, generation and pending saves, failed download, stale runtime and manual unload.
- [x] Implement `src/ts/storage/sessionHandoff.ts`, wire `globalApi.svelte.ts` and `nodeStorage.ts`, and add Korean/English messages using existing dialogs.
- [x] Verify real save-controller behavior after a session pause and normal network retry behavior.
- [x] Run targeted frontend and server lock tests, required storage checks, and type checking. Review the diff and add the latest patch note.

## Verification ledger

- Before implementation: inactive-sync notification and delayed-gesture tests failed; all three existing reload paths discarded local state in the integration reproduction.
- Review caught a delayed sync response applying after deactivation. Reproduced failure, then added a post-await runtime/session guard. No remaining blocking findings in the follow-up review.
- Frontend: 43 tests passed across session handoff, transport, save retry, runtime ownership, live-file sync and canonical conflicts.
- Server: 80 tests passed across session locking and the required character-assets, live-character-files, live-files-http, live-files-stability and new-character-packages suites.
- Final svelte-check: 6,460 files, zero errors and zero warnings. Scoped git diff whitespace check passed.
- Patch note: 0.9.42. No commit, push or deployment. Physical PC/phone tunnel testing remains outside this automated verification.

## Review focus

No reload on detection or cancellation. No reload during generation or save. No background dialog spam. No silent preflight rejection. A stale runtime cannot reload a new one. A transport failure must remain an ordinary retry. Existing writer ownership and stale-write rejection remain intact.
