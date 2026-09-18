# BardWiki Transfer Implementation Plan

**Goal:** Continue in an empty chat with the complete wiki, transfer selected non-event documents, and consolidate wiki tools using existing UI components.

**Architecture:** Keep Markdown authoritative. Reuse workspace staging and fork completion for atomic publication under runtime workspace locks. Carry document identity and arc checkpoints into a new chat, namespace inherited source references, and reset chat-only progress. Portable JSON contains selected document content and metadata, never local paths or live message references. Reject conflicting identities before publishing imports.

**Tech Stack:** Svelte 5, existing ShDialog and ShDropdownMenu, TypeScript, Node filesystem, Vitest.

- [x] Add package validation tests for selection, reserved events/arcs, aliases, malformed inputs and identity conflicts; implement shared package format.
- [x] Add filesystem tests for import atomicity and full wiki inheritance; implement staging, publication and inherited source separation using existing fork lifecycle.
- [x] Add client tests for empty-chat settings and failure cleanup; implement authenticated import and new-chat orchestration.
- [x] Move reboot into the four-item tools flyout; add drag-selection export dialog and picker/drop import.
- [x] Move find/replace into the main composer ribbon using a standalone dialog and existing magnifier icon.
- [x] Verify affected tests, type checking and rendered interactions; update latest patchnote and official wiki contract.

Validation: 110 frontend tests and 118 server tests passed. Svelte diagnostics reported zero errors and warnings. Rendered component tests cover dropdown activation, drag selection and drop import; live-browser visual verification was not performed.

Execution is authorized in the current public checkout. Preserve pre-existing edits. UI work is delegated independently; primary agent owns data transfer and integration review. No commit or release is requested.
