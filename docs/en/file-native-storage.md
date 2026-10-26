# File-native user data

RisuBard stores canonical user data as ordinary JSON, JSONL, Markdown, and content-addressed files. SQLite and `database.bin` are not user-data authorities. A compatibility `database.bin` can be rebuilt for existing clients and RisuAI exports.

Set an absolute data root before starting the server:

```bash
RISUBARD_DATA_ROOT=/path/to/private/risubard-data node server/node/server.cjs
```

The root contains separate settings and credentials, stable-ID entity files, character/chat directories, appendable message JSONL, request/system JSONL logs, per-job state/events, assets, and BardWiki. Startup reads only small manifests; bodies load on demand.

Writes use a same-filesystem temporary file, fsync, checksum/schema validation, atomic rename, parent-directory fsync, `.bak` revisions, and a recoverable multi-file journal. Deletes move to `trash/`. User messages are fsynced before model requests, and streaming assistant drafts can be recovered.

Legacy `.bin` and save-folder imports support explicit merge or replace behavior. An old `risuai.db` is copied to `migration-backups/` before a one-time import; normal runtime has no SQLite dependency. Full backups include the canonical tree, assets, BardWiki, and compatibility export data.

Per-chat story history is enabled explicitly from Save/Load. Under `risubard/characters/`, `story-history/` retains backups, branches, wiki commits, and message bindings, reusing SHA-256 blobs in the existing `save-store/`. Chat snapshots contain per-message blob references, message order, and chat state; unchanged messages are not copied. Editing after loading an earlier backup creates a branch without deleting the original future.

Migration and rollback originals and mappings remain in `risubard/history-transitions/`. Rollback exports every history backup to a unique manual legacy slot and retains the branch archive and referenced blobs. Full backups include this data. Assets and inlays referenced by history are excluded from cleanup and cannot be overwritten or deleted under the same ID; save replacements with new IDs. History is not automatically rotated away, and rollback needs additional space to materialize a complete chat for each slot.


On Termux, keep the data root in app-internal storage such as `$HOME/.local/share/risubard`. Shared `/sdcard` or `/storage/emulated` paths are rejected as canonical roots because they do not provide reliable fsync and atomic-rename semantics. Copy completed backup files there instead.
