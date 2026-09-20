# P1 deferred compatibility projection

Goal: avoid full database encoding and KV object writes for ordinary cached W2 chat saves. R1 remains separate because changing cold-start reads at the same time enlarges the recovery boundary.

The canonical transaction remains journaled and synchronous. Invalidate the regenerable database.bin KV reference before publishing canonical changes; do not remove its object bytes. Existing missing-cache reconstruction provides current legacy bytes when needed. No new file format or migration marker. Keep the old full-persist lane for uncached saves, structural/mixed changes, uninitialized canonical data and legacy SQLite roots. Reads, exports, explicit flush and clean shutdown materialize the compatibility cache. Tests must prove interrupted invalidation and partial transaction recovery, backup sizing, sequential direct writes, external-edit handling and previous-reader compatibility.

- [x] Add and run failing facade, interruption and integration tests.
- [x] Implement invalidation and materialization using the existing KV and repository contracts; gate activation during verification.
- [x] Wire only the cached chat-direct boundary; preserve integrity checks, writer serialization and full fallback.
- [x] Verify cold process recovery, read/export/backup round trips and legacy reader behavior.
- [x] Benchmark isolated representative data, activate only after gates pass, update observation boundaries and patch notes.

Eligibility additionally requires an existing projection-shadow comparison to succeed in this process. Mismatch, read failure, persist failure and cache invalidation revoke eligibility. Default enabled after 633 server and 69 compatibility tests passed (5 existing skips). `RISUBARD_DEFER_DATABASE=0` disables deferral. Type checking passed with zero errors and warnings.

Previous-reader coverage uses the frozen missing-cache reconstruction algorithm, not every older server route. Clean shutdown materializes before downgrade. After an unclean stop, use this runtime to materialize before older backup-first tools: their size lookup does not rebuild a missing cache. R1 remains pending, and real-use P1 acceptance remains unmeasured.

The W2 real-use snapshot stays frozen. P1 materialization cost is logged separately from deferred save cost so performance is not overstated. No release or commit is requested here.
