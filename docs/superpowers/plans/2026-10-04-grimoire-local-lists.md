# Grimoire local list preparation

**Goal:** Prepare large NPC, faction and item lists without model calls, while preventing accidental expensive AI analysis.

**Design approved in chat:** Large composite entries start unchecked in new AI analysis sessions, remain visible with a reason and an individual opt-in, and offer local splitting with a source preview. This affects AI selection only. Local application preserves legacy lore, creates Grimoire-only entries, and changes the original to index-only after a reviewed, complete split. Existing saved AI runs retain their targets.

**Architecture:** A deterministic list parser owns source spans, minimal metadata and output-risk assessment. A small review component displays original slices and applies through the existing fingerprint-checked derived-entry pipeline. The existing analysis workbench owns selection and persistence callbacks.

**Constraints:** Work in the current public checkout. No model calls, new dependencies, user-data writes, private changes, commits or pushes. Preserve unrelated edits, custom metadata and the original content. Do not guess ambiguous boundaries or silently drop shared prose. New local entries use name/body retrieval; AI enrichment remains optional.

## Tasks

- [x] Add failing core tests for bilingual names, multiline properties, one-line NPCs, faction/item lists, CRLF, unsupported prose, stale source, repeated application, legacy round trip and selective retrieval.
- [x] Implement local split previews and conservative application with exact source slices. Estimate expanded output from entity boundaries, not property bullets; identify bulk risks at 8,192 estimated output tokens or the lower configured allowance. This is default selection guidance, not a hidden request limit.
- [x] Add failing workbench tests for default exclusion, all-bulk empty selection, individual override, select-all safety and local application without requests. Retain saved-run behavior and its existing tests.
- [x] Integrate a compact exclusion explanation and inline local preview into the existing workbench, with translated copy, blocked/empty states and source-conflict feedback.
- [x] Run targeted tests and type checks; execute and inspect desktop/mobile browser flows with synthetic data and a read-only Hogwarts source fixture. Check reopen persistence and retrieval.
- [x] Update help and the latest SemVer patch notes; review the diff and report verification limits.

## Review focus

- Property rows must stay with their owning NPC, including an indented final description.
- Shared prose and unrecognized lines must block replacement instead of becoming lost context.
- Existing derived entries and manual edits must not be overwritten or duplicated by re-splitting.
- Unchecking a model target must not disable runtime retrieval.
- Closing a review, changing source, and continuing saved AI work must preserve data and deliberate user choices.

## Progress

- Initial checkout contains unrelated updater, language and wiki prompt changes. Preserve them.
- Existing list detection misses English `npc list`; its fallback estimator also counts property bullets as entities.
- User authorized implementation and then refined the UI behavior; continue inline without another approval gate.
- Final validation: 7 focused suites, 136 tests passed; svelte-check found 0 errors and 0 warnings.
- Independent review identified unknown property splitting, lost heading context and erased qualified names. Regression tests now cover all three. Explicit entity anchors retain properties, ambiguous formats block, and exact scoped headings become supporting entries.
- Browser: actual workbench and production persistence conversions mounted in an isolated Vite harness. Hogwarts produced 42 character entries and 4 supporting headings. Harry Potter retrieval excluded Ron, original content survived, reload retained results and repeated splitting was blocked. No browser errors.
- Inspected desktop 1440x1000 and mobile 390x844 screenshots. Fixed mobile grid clipping and verified no horizontal overflow.
- Harness persistence used localStorage with production materialize/apply functions. Native desktop file saving was not exercised; serialization, materialization, legacy and portable compatibility were tested. Live user data was not changed.
- Impeccable detector reported only the existing splitter height transition. No unrelated animation changes. Help and v0.9.63 notes updated, unrelated edits preserved, verification server stopped.
