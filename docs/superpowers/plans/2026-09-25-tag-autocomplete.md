# Danbooru tag autocomplete implementation plan

> Execute in the current public checkout. Implementation and verification are already authorized by the user's specification; preserve existing painter changes. No commits or worktrees.

**Goal:** Local tag suggestions in BardPainterPromptInput, including aliases, configurable shortcuts and durable settings.

**Architecture:** A reusable lazy worker loads the separated SDStudio release CSV. A textarea action owns each editor's request lifetime, popup, keyboard handling and range replacement. The existing DBState settings path persists preferences. General chat inputs and macro editors are untouched.

**Tech stack:** Existing Svelte 5, TypeScript, Web Worker, native textarea editing, Vitest and browser verification.

**Spec:** User request in this task, sections 1–8.

## Constraints and review focus

- Preserve comma/newline separators, whitespace, NovelAI brackets/numeric weights and SD weighted parentheses.
- Invalidate pending searches on dismissal, selection changes, focus loss, settings changes and destruction.
- Keep IME composition and unrelated modifier combinations out of autocomplete handling.
- Keep exact-match modifiers and popup priority explicit in settings; support Enter and Tab independently.
- Keep popup inside viewport and modal interaction boundary; preserve native undo grouping.

## Tasks

- [x] Search/data: write failing normalization, ranking, alias and dataset tests; implement search.ts, worker/client and public/data/danbooru provenance; run targeted tests.
- [x] Settings: write failing defaults, persistence roundtrip and shortcut tests; implement settings.ts, actual settings UI and optional database field; run targeted tests.
- [x] Editor: write failing range/controller tests covering the requested keyboard, race, IME, focus and replacement behaviors; implement range.ts and textarea action, integrate only BardPainterPromptInput; run targeted tests.
- [x] Verify actual browser editing, native Undo/Redo, worker data, popup placement and light/dark display; run Svelte diagnostics and affected regressions. Add user-facing latest patchnote entry and review only this task's changes.

## Validation commands

`node node_modules/vitest/vitest.mjs run src/ts/tagAutocomplete src/lib/Others/BardPainterPromptInput.test.ts src/lib/Setting/Pages/TagAutocompleteSettings.test.ts`

`node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json`

Browser harness uses the production prompt component/settings and real worker CSV, with isolated test storage and no access to user data.

## Results

- 80 related tests across 11 suites passed, including the existing painter parent/subject screens. The parent test's stores mock needed the new DBState dependency; its 15 tests passed on the final rerun.
- Svelte diagnostics: 0 errors and 0 warnings. Targeted TypeScript check also passed after the final range correction.
- Chrome: real worker dataset, Korean/Japanese aliases, native one-step Undo/Redo, both replacement ranges, shortcut customization/reset, persisted minimum, dark/mobile edge layout, list scrolling, real Bits UI modal Escape/click and CDP composition passed.
- Independent review findings fixed with failing-then-passing regression tests: multi-tag weight groups, literal parentheses within groups, bare macros, post-composition Enter window, fallback undo/custom shortcut precedence.
- Physical OS Korean/Japanese IME interaction was not manually exercised; browser composition lifecycle was automated.
