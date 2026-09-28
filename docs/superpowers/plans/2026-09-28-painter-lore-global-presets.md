# BardPainter lore and global presets implementation plan

> Execute the user-approved design in this session. Independent storage/card and UI tasks run alongside primary-agent runtime integration.

**Goal:** Link characters to lore, share outfit templates, and copy presets between bot and global libraries while preserving ordinary character cards.
**Architecture:** Keep legacy owned outfits. Add optional identity outfitIds/defaultOutfitId; empty outfit subjectId denotes an independent template. Store global presets in bardPainterLibrary. Copies get new IDs and no attachment consent. Lore IDs live in namespaced extensions.
**Spec:** User-approved design in this task, 2026-09-28. No vibe transfer or image reference transmission.
**Constraints:** Current public checkout only; preserve pending changes; no commits or push. Use canonical persistence and transactional rollback. Do not change lore content or activation keys.

## Review focus
- Legacy owned outfits remain intact until explicitly changed.
- Shared outfits survive deleting a linked character; deleting outfits removes stale defaults and links.
- Save failures roll back every affected library and lore entry.
- Copies remap all references and never share mutable objects or attachment consent.
- Unknown extensions do not break lore; card import never edits global presets.

## Tasks
- [x] Test and implement library helpers, optional types, normalization and card export/import filtering. Verify old and new card round trips and unrelated extension preservation.
- [x] Test and implement runtime global transfers, outfit links/defaults, lore link/unlink and deletion, rollback, and use of matched lore links in scene preparation.
- [x] Preserve the existing editor layout; add bot/global scope, copy/import actions, independent outfits, outfit/default associations and a searchable floating lore picker. Protect dirty drafts and show save/error states.
- [x] Run targeted tests, canonical persistence restart and type checks. Verify real desktop/mobile UI actions and screenshots. Update the newest patchnote and review changes.

## Verification
- 376 tests in 25 related files passed, including card boundaries and canonical storage restart.
- Svelte check: no errors or warnings.
- Chrome at 1200x1000 and 390x844: checked screenshots and clicked shared/default outfits, lore search/link/replacement/unlink, global copy/edit/import, common outfit creation and page reload. Browser fixture used real runtime/UI with an isolated localStorage save adapter; canonical file persistence was tested separately.
- Independent review found attachment scope expansion and name collision during legacy outfit conversion; both fixed with a regression test.
- The desktop app itself and live paid image generation were not run. Vibe transfer and image-reference transmission remain outside scope.
