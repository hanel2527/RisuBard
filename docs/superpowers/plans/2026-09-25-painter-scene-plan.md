# BardPainter structured scene plan

**Goal:** Implement the user's approved scene analysis and natural-language prompting changes without additional preset management or automatic visibility weights.

**Architecture:** The AI returns a version 2 scene plan: composition, indexed interactions and per-subject placement/posture/action/expression/gaze. A pure compiler validates references and projects these fields into the existing editable `PainterDraft`. Existing saved drafts, manual prompt overrides, locks, first-person exclusions and image generation parameters retain their current contracts. This is a single model call, not several analysis calls.

**Scope:** `src/ts/bardPainter/scenePlan.ts`, `prompt.ts`, their tests, the first-person parsing call in `runtime.svelte.ts` and a runtime regression, plus the latest patchnote. Existing unrelated working changes remain intact. No commits, worktrees, external requests or new dependencies.

**Review focus:** Invalid participant references, empty scenes, legacy responses, manually edited text, locking and first-person integration. The model must exclude the viewer before assigning subject indices. The compiler does not delete clothing or infer visibility.

## Task 1: Plan compilation and prompting

- [x] Add integration tests through `parsePainterDraft` and `buildPainterImageRequest`: route each interaction action to its intended participant, preserve natural-language camera/location, retain clothing, reject invalid plans, accept old drafts and preserve subsequent manual edits.
- [x] Run `node node_modules/vitest/vitest.mjs run src/ts/bardPainter/scenePlan.test.ts` and confirm missing compilation fails.
- [x] Add pure scene-plan compilation with bounded fields and validated integer indices; accept version 2 at the model-output boundary and retain unversioned legacy compatibility.
- [x] Replace the AI output instructions with the staged scene plan contract. Keep identity and outfit fields compatible with existing presets, preserve user-supplied style ownership, and avoid new catalogs or visibility weighting.
- [x] Run affected BardPainter tests, review the changes independently, and update `patchnote/0.9.47.md`.

## Validation log

Initial RED: four positive compilation cases failed because the old parser only accepted flat strings. Initial GREEN: 18 affected test files, 275 tests passed. Standalone TypeScript checking of the new compiler passed.

Independent review identified one P2: first-person viewer relations could survive as global prose or another actor's action after the old post-parse subject filter. A new regression failed before the fix. The runtime now passes its existing viewer-name set to compilation; indexed viewer relations are removed before flattening, preserving original indices for other actors. A runtime regression also covers captured persona names. Final GREEN: `node node_modules/vitest/vitest.mjs run src/ts/bardPainter src/lib/Others/BardPainter.test.ts src/lib/Others/BardPainterSubject.test.ts` passed all 18 files and 278 tests. The compiler passed standalone TypeScript checking again; tracked code diffs passed whitespace checks. Patchnote updated.

Review boundaries: arbitrary viewer mentions in free prose remain model-semantic behavior, as before; explicit indexed relations are enforced locally. Aggregate legacy field limits still reject oversized output. Actual image quality/model adherence were not tested with paid generation. Unrelated working changes remain outside this task.
