# External Canonical Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use systematic-debugging, test-driven-development, and verification-before-completion. Execute on the current checkout without commits or worktrees.

**Goal:** Adopt valid external canonical-file edits as one consistent projection update without requiring manual `index/sidebar.json` edits.

**Architecture:** Add one repository reconciliation boundary that inventories canonical entity files independently of the derived sidebar, validates a stable snapshot, derives sidebar summaries, and writes the sidebar only when its meaning changed. Route startup recovery and external adoption through that boundary before rebuilding `database.bin`, updating its ETag, and notifying the client.

**Tech Stack:** Node.js CommonJS storage server, TypeScript Vitest tests, atomic file-store transactions.

---

### Task 1: Reproduce stale and damaged sidebar behavior

**Files:**
- Modify: `server/node/user-data-repository.test.ts`
- Modify: `server/node/canonical-projection-sync.test.ts`

- [x] Add fixture helpers that externally replace canonical bytes and matching SHA-256 sidecars inside temporary data roots.
- [x] Add failing tests for character name, `modification_date`, chat summaries, body-only `globalLore`, collection edits, missing sidebar, stale sidebar, sidebar checksum mismatch, unchanged reruns, and an entity/checksum partial state.
- [x] Run the targeted repository and projection-sync tests and confirm failures are caused by missing reconciliation behavior.

### Task 2: Add the canonical inventory and derived-sidebar boundary

**Files:**
- Modify: `server/node/user-data-repository.cjs`
- Test: `server/node/user-data-repository.test.ts`

- [x] Inventory settings, secrets, supported collection JSON files, character metadata, chat metadata, and message JSONL independently of `sidebar.json`.
- [x] Validate canonical file checksums and compare the revision before and after inventory so a moving or partial snapshot is rejected.
- [x] Derive collection membership and character/chat summaries. Use a valid character `modification_date` converted from epoch seconds to milliseconds; otherwise use the metadata file mtime as the stable fallback.
- [x] Preserve valid prior ordering and compatibility-only `legacyMessagePresent` where possible, append newly discovered stable IDs deterministically, and write `index/sidebar.json` through `commitTransaction` only when derived meaning differs.
- [x] Export the reconciled legacy database from the same accepted inventory and expose `reconcileCanonicalProjection()` as the repository entry point.
- [x] Run the targeted repository tests until green.

### Task 3: Make external adoption and startup recovery atomic in ordering

**Files:**
- Modify: `server/node/canonical-projection-sync.cjs`
- Modify: `server/node/db.cjs`
- Modify: `server/node/server.cjs`
- Test: `server/node/canonical-projection-sync.test.ts`
- Test: `server/node/external-edit-session.test.ts`

- [x] Make external change loading call the repository reconciliation entry point and return the post-reconciliation revision and database snapshot.
- [x] Reconcile derived state when the repository is created so missing, stale, or checksum-invalid sidebar state is repaired before compatibility DB fallback or normal startup loading.
- [x] During adoption, publish the reconciled sidebar first, then compatibility `database.bin`, chat/cache state, ETag, accepted revision, and only then return the client conflict/reload signal.
- [x] Keep the existing external-edit finish endpoint as the official explicit reconciliation call for tools and retain stale-client rejection through the changed ETag.
- [x] Run targeted sync, session, repository, file-store, writer, and projection-shadow tests until green.

### Task 4: Record and verify the user-visible behavior

**Files:**
- Modify: `patchnote/0.9.37.md`

- [x] Add one user-facing stability note covering automatic adoption and sidebar recovery.
- [x] Run `git diff --check`.
- [x] Run the targeted server test set and the affected client persistence conflict tests.
- [x] Run the project type check, then inspect `git status --short` and preserve every unrelated pre-existing change.
