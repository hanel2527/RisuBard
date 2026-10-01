# Wiki context modes implementation plan

**Goal:** Show saved context policies in the wiki tree and preserve always-included documents independently of optional retrieval.

**Architecture:** Keep Markdown context metadata. Add required/automatic selection to the existing authenticated inquiry boundary. Required selection returns whole documents within the existing overall token and document caps. Load it before optional context preparation, reserve its tokens, and inject a separate non-removable message after prompt assembly. A required lookup failure stops generation; an optional lookup failure leaves required content intact.

**Constraints:** Current public checkout only, existing dependencies, no user data edits, no commits or publishing. Existing untracked patchnote content must be preserved.

- [x] Add regression coverage for full required documents, unrelated/empty queries, excluded documents, budget failure, mode transport and separate injection.
- [x] Implement server selection, frontend reservation and mandatory prompt injection.
- [x] Add tree icons and labels, checked menu selection, saved state and failure feedback in the existing editor.
- [x] Run targeted tests and type checks; exercise the real editor component in desktop and mobile browser fixtures, including saving and reopening.
- [x] Review the final diff and update the latest patchnote.

**Review focus:** Required context must survive optional failure and omitted prompt preset blocks, never be silently truncated, never duplicate optional content, and never silently exceed model limits. Excluded documents remain editable. Long Korean titles and saving errors must not misrepresent the saved policy.

**Verification:** 184 server tests and 71 frontend tests passed. Browser fixture: 17 checks passed at 1360x900 and 390x844, including persisted fixture state after remount and failed saves. Real component/CSS with stubbed storage; no live provider or user database calls. Review caught and resolved required-document link traversal, response-guide preservation, and output-token reservation regressions.

Final Svelte/TypeScript check: 0 errors and 0 warnings. Latest patchnote: 0.9.55.
