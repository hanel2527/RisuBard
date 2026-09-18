# BardWiki retrieval and single-pass writing implementation plan

> Execute inline with bounded parallel work for storage, retrieval, and transport. Preserve current branch and existing evidence validation.

**Goal:** Improve name-free recall without additional routine model calls, and reuse validated canonical patches from semantic analysis.

**Architecture:** Markdown remains canonical. Optional bounded keywords and evidence-based story time live in frontmatter. Local inquiry uses these hints and arc links. Semantic analysis may return canonical section patches only for complete supplied documents; unresolved or invalid patches use existing rewrite recovery.

**Tech Stack:** TypeScript, Svelte, existing Vitest browser and server configurations.

- [x] Verify clean tree, fast-forward development through origin/development and current main.
- [x] Add optional retrieval metadata, conservative day-zero timeline resolution, serialization and preservation tests.
- [x] Carry metadata through client/server validation and show read-only metadata in the wiki editor.
- [x] Integrate bounded keywords and arc-based recall with relevance and budget regression tests.
- [x] Supply bounded complete canonical inputs to analysis and accept validated inline section patches; keep current fallback for missing targets, reboot batches and arc checkpoints.
- [x] Verify single-pass creation/update, missing-target fallback, full-document safety, metadata transport, and legacy compatibility.
- [x] Update official contracts and latest patch notes; run targeted tests and type checking.

Validation: server storage, inquiry, writing, routes, runtime and smoke tests pass; client model-request, transport, loading and editor tests pass. `npm run check` reports zero errors and warnings. No live provider latency benchmark was run. Checkpoint arc writing and reboot canonical rewriting still use their existing separate model calls.

Time is narrative-relative, not wall-clock time. Unknown jumps and historical corrections must not silently fabricate a precise date. Existing documents are never bulk rewritten for this feature.
