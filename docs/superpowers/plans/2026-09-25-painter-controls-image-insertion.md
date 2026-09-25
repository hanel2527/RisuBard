# Painter controls and image insertion implementation plan

**Goal:** Implement the four user requests: workspace reset, primary toolbar buttons, raw prompt copy, and external image placement from the chat menu.

**Architecture:** Keep the existing painter session and gallery ownership contracts. Reuse the placement request and paragraph selection UI for external images; save the asset only after a position is confirmed. Preserve all pre-existing changes in the current checkout.

**Stack:** Svelte 5, TypeScript, Vitest, existing inlay storage.

**Spec:** User request in this task dated 2026-09-25.

## Constraints and review focus

- Reset clears current working content while retaining settings, presets, gallery assets and inserted images.
- No state changes while generation or an image save is pending; failed persistence restores working content.
- Clipboard text contains composed prompts only, preserving edited subject blocks and separating negative text at the end.
- File selection cancellation, placement cancellation and chat switches do not insert into another chat.
- Invalid images, streaming messages, changed source text and storage failures must report errors and permit recovery without duplicate insertion.
- Existing gallery filters receive explicit character and chat ownership.

## Task 1: Painter controls

- [x] Add failing reset, clipboard and toolbar tests in existing painter suites.
- [x] Add transactional session reset and plain prompt serialization; wire reset confirmation and copy feedback.
- [x] Apply existing primary button style to toolbar controls and run affected tests.

## Task 2: External image placement

- [x] Add failing tests for image preparation, scoped placement, storage rollback and right-click cancellation.
- [x] Add an image-only file picker action below file upload in DefaultChatScreen.
- [x] Decode the image before placement, defer inlay storage until insertion, and explicitly set gallery ownership.
- [x] Reuse existing paragraph placement, add context-menu cancellation and retain Escape/left-click behavior.
- [x] Validate affected insertion, placement, gallery and component suites.

## Task 3: Delivery verification

- [x] Review integrated changes independently, resolve material findings and run affected checks.
- [x] Update latest SemVer patchnote and report verification limits. Do not commit or publish.
