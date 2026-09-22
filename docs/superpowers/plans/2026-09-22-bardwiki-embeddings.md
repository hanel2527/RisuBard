# Optional BardWiki Embedding Retrieval Implementation Plan

**Goal:** Recover implicit references, paraphrased events and details inside long documents while preserving lexical-only use.

**Architecture:** Markdown remains authoritative. A paginated, authenticated catalog supplies eligible paragraph chunks to a background client index. Hypa-compatible providers embed chunks and bounded current/recent queries. Verified semantic ranges join the existing bounded inquiry and source-message recovery. Failures use ordinary inquiry.

**Tech Stack:** Existing TypeScript, Svelte, Hypa embedding transports, persistentKv, Vitest.

- [x] Provider: independent global settings, existing Hypa model choices, immutable provider configuration, transport tests.
- [x] Catalog: eligible chunks with stable content ranges, revision-aware pagination, authenticated endpoint and stale-range rejection tests.
- [x] Index: incremental model-scoped cache, background refresh, scoped snapshots, bounded query timeout, hybrid candidate tests.
- [x] Integration: current/recent context queries, semantic evidence ranges, Bard-chan merging, existing source recovery.
- [x] Validation: implicit references, paraphrases, long-document details, current-state precedence, deleted/edited documents, disabled/error/model-switch behavior.
- [x] Documentation: update approved architecture exception and newest patchnote; targeted tests and type checks.

No worktree, dependency additions, commits or external publication are required.

Validation uses deterministic vectors and mocked provider transports. It verifies routing and evidence preservation, including long original messages under a 256-token per-source budget. It does not measure real embedding models' semantic recall quality. Shared local inference is serialized and tested for replacement failure and cancellation; mandatory context remains intact when a semantic passage matches it.
