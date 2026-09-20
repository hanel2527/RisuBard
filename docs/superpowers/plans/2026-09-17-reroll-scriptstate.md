# Reroll Script-State Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent assistant-output variables from accumulating across rerolls or becoming inconsistent when a swipe is selected.

**Architecture:** Store a copy of the chat script state immediately before and after each assistant response. The reroll action restores the prior state before creating a replacement, and swipe navigation restores the state saved for the selected candidate. Legacy messages without a checkpoint remain usable without modifying their state.

**Tech Stack:** TypeScript, Svelte 5, Vitest.

---

### Task 1: Script-state checkpoint helpers

**Files:**

- Create: `src/ts/chatScriptstateCheckpoint.ts`
- Test: `src/ts/chatScriptstateCheckpoint.test.ts`

- [x] **Step 1: Write failing tests for restoring a response's prior state, restoring a selected swipe's result state, and retaining state for legacy messages.**

- [x] **Step 2: Run `pnpm vitest run src/ts/chatScriptstateCheckpoint.test.ts` and confirm the tests fail because the helper does not exist.**

- [x] **Step 3: Implement only the checkpoint cloning, attachment, reroll restoration, and swipe restoration required by the tests.**

- [x] **Step 4: Run `pnpm vitest run src/ts/chatScriptstateCheckpoint.test.ts` and confirm all tests pass.**

### Task 2: Connect checkpoints to response generation and chat controls

**Files:**

- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Test: `src/ts/chatScriptstateCheckpoint.test.ts`

- [x] **Step 1: Add optional message fields for response checkpoints and per-swipe checkpoints.**

- [x] **Step 2: Capture state before `runCurrentChatFunction`, then save the final state on the committed assistant response in both streaming and non-streaming paths.**

- [x] **Step 3: Restore a prior checkpoint before rerolling and restore the corresponding after-state when moving to, or deleting, a swipe.**

- [x] **Step 4: Run the focused Vitest file and `pnpm check` to verify the typed integration.**

### Task 3: Document and verify

**Files:**

- Modify: `patchnote/0.9.37.md`

- [x] **Step 1: Add one user-facing stability note without changing existing patchnote entries.**

- [x] **Step 2: Run focused tests, `pnpm check`, `git diff --check`, and inspect the changed-file diff.**
