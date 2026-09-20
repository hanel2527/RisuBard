# Storage checkpoint and next measurement boundary

W2 chat writes and P1/P1.1 deferred compatibility generation are the current checkpoint. They preserve journaled canonical writes, lazy compatibility reconstruction and the full-write fallback. This is a functional checkpoint with improvements in selected write paths, not a claim that end-to-end tail latency is solved.

## Next: measure remaining save cost before R1

R1 changes startup reads. It remains a separate milestone, but ordinary save latency is now the next priority.

1. Measure external revision scanning, direct/full transaction planning, unchanged-file comparison, journal publication and accepted-revision writes separately. Distinguish topology and identity rejection reasons without logging paths, IDs or content. Keep metrics best effort.
2. Replay identical edit sequences against one immutable database snapshot: preset text edits, root settings, chat messages, mixed edits, create/reorder/delete, and explicit read/backup. Hold the number of flushes and materializations constant. Include shadow and materialization totals plus server responsiveness, not just the save timer.
3. Optimize only the largest demonstrated component. Candidate investigations include repeated revision scans and avoidable full synchronization. Do not remove fsync, conflict detection or recovery validation to meet a latency target. Retain conservative handling of unknown or mixed scopes.
4. Require semantic equality, crash/restart and backup round trips. For the chosen workload, target at least 20% reduction in median total processing cost with p90 no worse than 5%, reproduced across interleaved runs. These are acceptance targets, not measured improvements. Report other workload regressions separately.
5. Implement R1 only after this save-cost decision, or if startup becomes the explicitly prioritized problem. Keep asset conversion independent.

Mixed real-use percentiles reflect workload and data-size changes. A slower aggregate median does not prove every file write became slower, and the presence of full syncs does not establish the sole cause. Sampled shadow checks must be reported as skipped, not as matches.

## O1.4 implementation: small accepted-revision record

Profiling identified a whole KV manifest rewrite for each accepted projection revision. Removing a redundant JSON parse reduced that component but did not reproducibly meet the total latency target. The next bounded change stores the existing accepted revision in `cache/canonical-projection-revision.json`, using the existing atomic JSON writer, checksum, fsync and backup protocol. It does not introduce a new revision algorithm or data authority.

- Read the old KV revision only when the new record is absent. Never rewrite or delete the old key just to accept a save.
- Require a valid schema and checksum for the new record. Unreadable or interrupted metadata returns no accepted revision, causing the existing canonical reconciliation path to run.
- Publish acceptance only after the canonical transaction. Invalidation of `database.bin` remains durable before deferred canonical publication.
- Old runtimes see their stale KV revision and reconcile the canonical files. Old-version writes are detected against the new record when upgrading again. Downgrade may therefore pay for one extra reconciliation and compatibility rebuild.
- The record is disposable derived metadata and is excluded from portable backup. Restore already accepts the restored canonical revision; missing metadata otherwise uses the same reconciliation path.
- Keep full revision scans and shadow verification unchanged. Benchmark the same canonical transactions and materialization frequency before and after, including full semantic comparison cost. Do not mix clone benchmarks with real-use graph points.

Validate new-process reopen, downgrade/re-upgrade, external edits, missing/corrupt metadata, failed acceptance, interrupted canonical journal recovery and compatibility reconstruction. The old cache invalidation and backup recovery contracts remain required checks.
