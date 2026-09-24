# Canonical recovery implementation plan

> Execute inline using executing-plans, test-driven-development and verification-before-completion. User has authorized implementation on the current checkout.

**Goal:** Recover unambiguous formatting errors, isolate canonical failures per document, and stop automatic repetition after bounded structural repair without weakening storage validation.

**Architecture:** Preflight canonical inputs in memory. Validate each unambiguously addressed batch entry with the existing strict parser and patch validator. Preserve valid entries and regenerate only failures. Persist exhausted recovery as a non-retryable warning in the existing turn receipt, independently from whether the UI displays a failure.

**Tech stack:** TypeScript, existing Vitest suites and Markdown storage.

**Spec:** User-approved five-stage recovery proposal in this task; existing project_wiki/markdown_narrative_wiki.md and context_pipeline_architecture.md contracts.

## Constraints

- Work on current RisuBard-public checkout. No worktree, private overlay, release or push.
- Preserve IDs, evidence, hash preconditions, atomic storage, historical protection, cancellation and reboot recovery.
- No new database, cache, model call for verification, or dependency.
- A failed ambiguous batch envelope is never partially accepted.
- Network/storage errors remain retryable. Exhausted structural errors require changed evidence/documents or explicit additional analysis.

## Review focus

- Malformed existing document beside a valid one: only the former is deferred before generation.
- Mixed valid/invalid batch: retain the valid response and repair only the invalid target.
- Provider failure with valid inline patches: preserve independently validated work without multiplying provider requests.
- Cancellation/reboot failure: propagate rather than recording a successful completion receipt.
- Deferred failure: remains visible as failure after restart, without automatically replaying the old turn.

## Tasks

- [x] Preflight: export prepareCanonicalMarkdown; repair BOM/leading blank lines and repeated sections, verify repaired section boundaries, retain raw content/hash until normal commit. Add parser regression tests.
- [x] Batch recovery: add parseCanonicalBatchIsolated with strict envelope/index validation, per-document strict parse errors, and missing-target errors. Runner validates all document types, retries failed targets only, isolates final failures and preserves normal hash-checked saves. Add writer and runner tests.
- [x] Retry lifecycle: add a bounded document-specific deferred warning and a failure selector separate from the retry selector; use the former for activity reporting and the latter for automatic retry. Add receipt tests and retain legacy warnings.
- [x] Validate affected server/client tests, type checking where practical, review final diff with a fresh reviewer, update latest patchnote.

## Validation

Run new regression tests before implementation and observe the specific missing behavior. Then run section-patch, memory-writer, memory-analysis, combined-memory, reboot, Markdown storage and receipt/activity tests. Use git diff --check. No full release build is needed.

## Decisions

- Use existing persisted receipts to terminate exhausted automatic retries instead of a hidden fingerprint cache. This survives restart and leaves explicit manual recovery available; new confirmed evidence starts a fresh bounded attempt.
- Leave storage conflicts to the existing next-turn reload-and-regenerate path; never force-save or replay a stale patch on a changed document.
- No commits requested; record verification here rather than creating implementation commits.
- Review fix: persist optional input fingerprints and deferred target hashes in existing receipts. Automatic same-input retries skip already saved or deferred targets while hashes match; changed evidence, document edits and manual additional analysis reopen work. This prevents a transient neighbor from replaying exhausted targets.
- Review fix: preserve provider noRetry/toolExecuted policy when only part of a batch fails validation.

## Verification results

- Targeted server suite: 10 files, 269 tests passed.
- Targeted client suite: 5 files, 77 tests passed across final runs. The token-budget test initially caught duplicate error notifications across split batches; deduplicated reports by error name/message and reran the client suite (60/60 for client/receipt, remaining 17 UI/automatic/audit tests passed).
- Fresh reviewer identified mixed retry replay and response replay restrictions. Both have failing-before/passing-after regressions in risubard-canonical-recovery.test.ts.
- After final error-report deduplication, runner/combined/recovery suite passed 100/100 again.
- svelte-check: 0 errors, 0 warnings. git diff --check passed.
- Existing unrelated cancellation timing and fence parsing limitations remain outside this change; safe normalization now rejects repairs that would swallow section boundaries.
