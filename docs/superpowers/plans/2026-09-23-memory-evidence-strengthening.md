# Memory evidence strengthening

**Goal:** Improve delivered memory evidence without new model calls or larger configured context budgets.
**Architecture:** Keep Markdown authority and bounded inquiry. Preserve qualifications during excerpting, keep current character facts alongside semantic evidence for ongoing scenes, and make the optional rerank operation use one coherent ordering.
**Validation:** Vitest regressions and counterexamples through the existing inquiry, excerpt and rerank entry points. No real-model superiority claim.

## Critique and decisions

- Reject unconditional recency boosts: an explicit historical query needs old evidence.
- Reject a new database, extra critic calls and an always-injected promise list: no demonstrated need, risks stale facts and increased work.
- Accept enclosing heading preservation: removing a heading such as Disproven rumors changes the meaning of otherwise verbatim evidence. Test both lexical and semantic paths, nested history, and tight budgets.
- Accept current character context beside a semantic passage for ordinary continuation: retain the relevant passage too, and leave explicit historical intent unchanged. Share the existing per-source cap.
- Accept rerank correction: cosine scores and rank fractions are not comparable. Returned candidates precede unranked fallback candidates, retaining verified ranges. Only IDs actually shown to the reranker are valid.
- Allow a short recent-context field for reranking deictic queries, reusing the same OOC/user-exclusion-filtered context as embeddings. No additional call; bounded 1024 characters.

## Execution

- [x] Add and run failing regression tests in excerpt, inquiry, embedding merge and Bard-chan tests.
- [x] Implement minimal changes in those modules and the chat caller.
- [x] Run targeted tests, adversarial review, and fix substantiated findings.
- [x] Record validation and update the latest patch notes.

Existing unrelated edits remain intact. Do not change user-message exclusion, writer finalization timing, stored records, or official wiki decisions.

## Review refinements and validation

- Six new regressions failed before implementation and passed afterward.
- Independent adversarial review found heading-only claims losing their parent qualification at small budgets. Reproduced at 65 and 75 characters, then fixed by omitting a qualified heading as a unit when it cannot fit.
- Review also found Korean past-tense scene narration and present-tense why dialogue incorrectly skipped current-state supplementation. Reproduced both, then limited this new exclusion to explicit past/chronology intent. Existing event-lane intent behavior is unchanged.
- A second review found an explicit `Why did ...?` question losing the end of its evidence under the initial half-budget split. Reproduced two failing queries. Rather than extending language heuristics, changed allocation to preserve the whole selected semantic excerpt first and supplement state only from spare per-source capacity (at most half). Exact combined token count is checked. If the evidence fills the cap, it stays unchanged.
- Final targeted validation: 75 server tests across excerpt, inquiry, embedding integration and narrative inquiry; 73 client tests across reranker, embedding index, source recall connections and analysis client. All pass. Scoped git diff --check passes. Syntax transpilation found no errors in the five changed implementation files; this is not a full project type check.
- User asked about removing Bard-chan. Keep its optional, default-off behavior; marginal quality versus embeddings alone has not been measured. Evidence-preservation changes also work without it.
- No additional model calls or increased memory budgets. Optional reranking can include up to 1024 recent-context characters and a short interpretation instruction. Runtime latency and real-model response accuracy were not benchmarked, and superiority over Archive Center is not established.
- Latest 0.9.41 patch notes updated. Changes remain uncommitted; unrelated work is preserved.
