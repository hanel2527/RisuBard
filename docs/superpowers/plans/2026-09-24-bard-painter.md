# BardPainter implementation plan

**Goal:** Select a passage, prepare editable NovelAI V5 prompts, generate a compressed illustration, and insert it above or below the saved selection through BardWiki.

**Architecture:** A lazy BardWiki view uses a chat-scoped draft and configuration with bot-scoped identities and optional shared outfits. Model calls, binary image conversion, and message insertion remain independent. Existing file-backed metadata and inlay storage own persisted data.

**Tech stack:** Svelte 5, TypeScript, existing model request and NovelAI transport, native WebP encoder, Vitest, browser verification.

**Spec:** User decisions in this task: selection first; saved context and style; editable main prompt and vertically stacked subject accordions; optional AI clothing; chat outfits promotable to bot scope; WebP quality 80 with generation metadata; insertion by saved message ID/start/end without relocation; tab immediately left of OOC.

**Selection interaction update:** Highlighting captures a chat-scoped candidate directly in the panel, with no floating action and no model call. The explicit prompt button pins that scene. Deselection preserves it; changing chats clears the transient candidate. Subsequent highlights change the insertion destination only. Replacing a drafted scene is an explicit confirmed action. Appearance and outfit presets are accessible from the title toolbar even without a draft.

**Library and display-text update:** Presets use person folders with nested appearance and outfit entries, full-library name/alias/outfit search, scope filters, bounded lists, and one mounted editor. Standard user/character substitutions preserve source-token offsets. Unmappable rendered selections still permit generation and insertion at the selected message's start or end. The legacy `insertionUnavailable` marker now denotes this message-boundary fallback. No AI lookup is used for insertion.

## Constraints

- Work directly in the current public checkout; no private changes, worktree, publishing, or paid verification requests.
- Preserve source text, swipe candidate, chat ownership, and failed generation output.
- Never auto-generate an image during prompt preparation or retry image API after conversion failure.
- Use theme tokens, explicit labels, keyboard controls, visible progress, actionable errors, and preserved drafts.
- Only chosen context is sent; auxiliary context never determines a different story moment.

## Review focus

1. Selection with Markdown, duplicate words, Unicode, and paragraph boundaries maps to the original source without guessing a different occurrence.
2. Chat switch, tab switch, close, and request completion do not cross-contaminate drafts, outfits, or insertion targets.
3. Conversion or save failure leaves a recoverable generated image and never repeats a paid generation request automatically.
4. Saved selection survives deselection; insertions preserve the active swipe and reject deleted target messages. Repeated insertions shift the captured range only after a successful save, without overwriting a fresh highlight made during that save.
5. Empty keys, invalid settings, missing wiki entries, malformed model output, and deleted assets produce usable recovery paths.

## Tasks

- [x] Pure prompt contract and user-owned style presets: test JSON parsing, selected-context boundaries, paragraph assembly, character API arrays, and outfit ownership. Public defaults contain no personal prompt text.
- [x] WebP conversion: test full dimensions, Unicode EXIF, PNG text and ICC metadata, and malformed input. Browser encode quality 0.8, no Python runtime.
- [x] Selection and insertion: test source range mapping, deselection, duplicate passages, and non-current chats; write through existing persistence boundary.
- [x] Runtime: snapshot prompt and generation input, explicit cancellation, per-chat state, image save with explicit owner, retry storage without generation, and optional original download.
- [x] UI: lazy BardWiki entry, settings and context controls, subject accordions, clothing capture and promotion, result preview and insertion.
- [x] Targeted tests, Svelte check, build, browser flow, independent review, fixes, and latest patch note.

## Verification completed 2026-09-24

- Feature and integration regression run: 209 tests passed. Storage verification: 20 client and 67 server tests passed. Save-slot coverage: 16 tests passed. Final affected subsets were rerun after review fixes.
- Svelte check: zero errors and zero warnings. Production build succeeded. Existing shared-module chunk warnings remain unrelated to Painter.
- Isolated Chrome and local fixture APIs exercised text selection, prompt-only preparation, explicit image generation, native WebP encoding, persistent inlay storage, deselection followed by insertion, outfit editing and promotion, tab switching, and restoration after reload.
- Desktop 1440px and narrow 390px layouts inspected. No horizontal overflow or browser exceptions occurred in the exercised flow.
- Independent review findings fixed: ambiguous source matching, encoded character and link boundaries, abandoned recovery jobs, chat copy/import scope, and in-flight wiki loading. Save-slot restoration also rebinds Painter anchors.
- Unsupported display transformations and partial formatting selections use the selected message boundary. Insertion uses captured offsets or this deterministic boundary and never invokes an AI or searches for a new position.
- Real provider calls were not made. Browser encoding uses WebP quality 0.8; browser APIs do not expose Pillow's compression method setting.

## Personal preset boundary

Selection and preset UI follow-up: 128 targeted tests passed; Svelte check reported zero errors and warnings; production build succeeded. Synthetic component tests cover automatic highlight capture, generated footers and typography, preserved deselection, chat switching, explicit prompt submission, and pre-draft preset management. No provider calls were made for this follow-up.

Folder and substitution follow-up: 145 targeted tests passed, Svelte check reported zero errors and warnings, and production build succeeded. An isolated browser with 100 synthetic identities and 1,500 outfits verified bounded rendering, owner-preserving search, and no horizontal overflow at 900px and 390px. Personal saves were not used in these fixtures.

Artist and style presets are private user data and must never be copied into application source, fixtures, or release artifacts. The public preset is neutral and contains no artist, rendering, or negative prompt. Custom presets are read from the active user's saved settings.

Execution is authorized by the user's instruction to implement now; this plan does not introduce another approval step.

## Workspace and gallery redesign

- Blueprint: [workspace sketch](2026-09-24-bard-painter-workspace.svg). Independently reviewed before implementation and again after browser screenshots.
- Header tools open the standard ShDialog for style, character library, and generation/context settings. Main workflow is pinned scene, editable draft, prompt conversation, and explicit image generation.
- Each subject has one editable prompt. Paragraphs retain compatibility with appearance/outfit presets, while generation and refinement preserve the exact edited text. Advanced actions are collapsed.
- Conversation uses the pinned scene and current draft. Failure preserves the request and draft; the previous successful draft can be restored, with rollback on save failure.
- Painter renders one latest image. The Character Display gallery renders 24 thumbnails per page, with all/current/deleted/unassigned chat filtering, creation ordering, enlargement, and individual prompt-block copying.
- Per-image generation records live under `inlay_generation/` beside the existing inlay storage. Chat deletion preserves these records and assets. Only an explicit image deletion removes them. Existing hydrated chat records migrate without loading unrelated chats or all prompt payloads.
- Chat and gallery deletion guard active generation and pending storage recovery. Destructive actions capture their original target before asynchronous confirmation and recheck its identity before deletion.

Verification for this redesign: 204 targeted tests passed across 17 files, including insertion rollback/concurrency, raw prompt preservation, bounded gallery rendering, deleted-chat grouping, prompt copying, and pending-save deletion guards. Svelte check reported zero errors and warnings. Production build succeeded with existing shared-module bundling warnings. A synthetic browser fixture verified the three tool dialogs, Escape dismissal, pinned-scene versus new-highlight behavior, and 900px/390px layouts without horizontal overflow or browser exceptions. No paid provider request or personal save was used.

The synthetic gallery contained 300 images and rendered only 24 cards per page. Browser checks verified page changes, the combined deleted-chat group, enlarged image and per-block prompt controls, and the 390px viewer without overflow or exceptions. The CSS-first development-server restart regression also passed. A final exact-identifier privacy scan found no personal preset identifier in source, public assets, build output, or this task's documentation.

## Preset manager follow-up design

Use the existing theme, application font, and ShDialog surface. Reference dark palette: background #282a39, inset #20222f, border #454b61, text #f1f1f4, secondary text #aeb5cb, action #5983ff. Implementation uses the corresponding `--color-*` tokens, preserving light themes. Typography is 13px controls and labels, 15px editor headings, and the existing dialog title. Compact 32px desktop controls expand to 44px for coarse pointers.

```
Preset manager                              Close
Searchable ordered list | Single draft editor
Person > appearance    | Name and prompt fields
       > outfits       | Overwrite / Save as new
New / move up / down   | Confirm deletion / feedback
Resize edges and corner; size remembered per window
```

Keep selection, editing, and saved data distinct. Explicit save replaces blur persistence. Guard unsaved edits before selection changes or dismissal, retain edits after failures, and protect the built-in style. Character copies copy appearance only; outfit copies retain explicit owner and local/shared scope. Deleting a character preset removes its dependent outfit presets only after all relevant chats are available, preserving scene drafts and image history. Reordering stays within the correct owner and scope. Lists remain bounded and the editor stacks under the list in narrow windows.

The brief is a creative tool library, so the visual focus is the relationship between a person and their wardrobe, with one selected editor. No new decorative cards, typography, or palette are introduced. Implementation runs in parallel across the preset runtime, character library, and root-owned style manager/dialog; each has targeted failure and persistence checks.

Preset follow-up verification: 86 tests across seven affected suites passed; Svelte check reported zero errors and warnings; production build succeeded. The isolated browser used 36 synthetic styles and 25 identities with 500 outfits. It verified explicit copy saving, dirty-close protection, a saved copy selected beyond the first list page, keyboard and pointer resize, separate persisted window sizes, and reachable editor actions at 390px. Browser inspection found and fixed native details-content sizing that clipped the mobile editor. Final screenshots received a separate UX review with no blocking findings. No personal save or paid provider call was used.
