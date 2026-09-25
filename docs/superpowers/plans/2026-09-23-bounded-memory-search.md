# Bounded memory search implementation plan

> Execute inline with executing-plans and test-driven-development; request one independent review after implementation.

**Goal:** Improve useful embedding evidence and reduce local search work without additional model calls, larger query inputs, or larger context budgets.

**Architecture:** Keep Markdown authoritative and retain lexical fallback, source verification, scoring weights, thresholds, and candidate limits. Exclude standalone Markdown headings from embedding candidates while retaining headings as body context. Rank the best passage per document before sorting rather than sorting every passage.

**Tech stack:** TypeScript, existing Vitest suites, local Node benchmark.

**Spec:** User instructions in this task; `../project_wiki/bardwiki_optional_embeddings.md` and `../project_wiki/inquiry_context_compiler.md` (relative to repository root).

## Constraints

- Existing pending work was committed as c00e6dd and pushed to origin/development before these changes.
- Work in the current public checkout. No worktree or private edition changes.
- No added AI requests, query instructions, higher token caps, timeout increases, or waiting for background indexing.
- Do not change persona injection, user-message exclusion, or generation/confirmation order.
- Fixed 55/45 scoring, threshold, document limit, source offsets, and cache reuse remain compatible.
- Measure local before/after work. Do not claim real-model accuracy or network latency from deterministic tests.

## Review focus

- Body on the line after a heading without an empty separator must survive.
- CRLF and Korean text must retain exact UTF-16 source offsets.
- Changed chunk generation must not re-embed unchanged ordinary body chunks.
- Equal scores must preserve stable document and source-offset ordering.
- Repeated passages must not displace other qualifying documents or change the global threshold.

## Task 1: Evidence-bearing chunks

Files: `src/ts/risubard/wikiEmbeddingChunks.ts`, its test, and `server/node/risubard-wiki-embedding-integration.test.ts`.

- [x] Add failing tests: headings-only documents produce no chunks; heading followed by body without blank lines retains that body; Korean CRLF offsets resolve to original text; existing body embedding keys remain unchanged.
- [x] Run the chunk suite and verify failures originate from heading-only candidates.
- [x] In the existing passage loop, record a heading as context; skip only an empty heading body. For body sharing the same passage, retain its existing text and offsets to avoid cache churn.
- [x] Verify a high-similarity bare title cannot become the semantic evidence returned to the reader. Keep provider calls and query strings unchanged.

Example expected evidence:

```ts
const content = '## 츠구\r\n\r\n### 약속\r\n\r\n역에 가겠다는 약속은 하지 않았다.'
expect(chunks.map(c => content.slice(c.start, c.end)))
  .toEqual(['역에 가겠다는 약속은 하지 않았다.'])
```

## Task 2: Equivalent cheaper selection

Files: `src/ts/risubard/wikiEmbeddingIndex.ts`, its test.

- [x] Add a reference-equivalence test exercising scaled vectors, contextual queries, duplicate document chunks, pagination, score ties, weak matches, and the 12-document cap.
- [x] Replace sort-all-then-deduplicate with one best-passage map per document followed by sorting the retained candidates. Keep the cosine calculation and tie rules unchanged; discard scores below 0.4 before sorting.
- [x] Compare complete results against the prior algorithm; compare local timing on a repeated-passage corpus with no network calls. Reject this optimization if representative measurements show regression.
- [x] Run affected client and server retrieval suites. Update the latest patch note with only the delivered behavior.

## Validation and delivery

- [x] Record failing and passing tests, chunk/token reduction, and before/after timings.
- [x] Request a bounded independent code review while checking the diff and verification results.
- [x] Keep new search changes separate from the already-pushed checkpoint and report their local status.

## Progress

- Baseline: existing pending changes verified with 88 server and 141 client tests, then pushed to development as c00e6dd (rpaddict).
- Ruling: do not alter hybrid weights, thresholds, or model-specific query instructions without real retrieval-quality evidence; they could increase false recalls, tokens, or latency.
- Ruling: no added norm computation during rebuild; optimize selection only so background indexing does not gain a new vector pass.
- Chunk RED: the heading-only unit test and evidence-selection integration test failed on the original code, then passed after the fix.
- Final targeted verification: 66 client retrieval tests and 147 server retrieval tests passed (213 total). Existing body cache keys, mixed heading/body paragraphs, CRLF offsets, cutoffs, pagination and ties are covered.
- Independent review identified collating-equal Unicode IDs. A failing test reproduced it; final sorting preserves source offset and winning passage input order. The test passes.
- Local snapshot: four active wiki documents decreased from 20 embedding chunks to 8. All retained chunks are byte-identical to old candidates. cl100k estimates decreased from 1,738 to 1,289 tokens; these are not Qwen billing-token measurements.
- Final local benchmark: 30 measured rounds after warm-up, alternating implementations, no network; identical full results and query requests. Median milliseconds: 32 passages/4096 dimensions 0.281 -> 0.272; 2,000 passages/4096 dimensions 14.591 -> 14.184; 10,000 passages/128 dimensions 5.857 -> 2.908.
- Small-corpus p95 varied from 0.423 to 0.460 ms; larger-corpus p95 decreased. Microbenchmarks do not prove end-to-end generation latency or real-model answer accuracy. No query payloads, model calls, timeouts, or final context caps were increased. Actual selected prompt text can change when a real body replaces a title-only excerpt.
- Ruling: retain callback-based iteration; an initial for-of variant regressed high-dimensional search time and was replaced before delivery.
- Search changes remain uncommitted in the current public checkout, separate from the already-pushed c00e6dd checkpoint.
