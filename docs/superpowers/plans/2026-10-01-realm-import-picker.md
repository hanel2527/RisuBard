# Realm persistent details and module picker

**Goal:** Keep Realm details open after character/module imports and let users select a module from a Proton shared folder before releasing.
**Architecture:** Reuse the app-level Realm detail store so chat navigation cannot unmount it. Extend the existing Proton public-link adapter with folder listings and explicit node selection; retain verified-download and import transactions.
**Constraints:** Current public checkout, existing dependencies and theme, no private edits. Preserve pending changes. Release remains authorized after this fix.

- [x] Test persistent details and folder selection, nested navigation, unsupported/empty folders, cancellation and retry before implementation.
- [x] Extend `protonModule.ts` with folder results and selected-node reads using the installed SDK. Only `.risum` files are importable; list other files without downloading them.
- [x] Use `showRealmInfoStore` in `RealmMain.svelte`, keep the popup mounted, and add busy protection and an inline accessible folder picker to `RealmPopUp.svelte`. Keep progress/recovery dialogs above details.
- [x] Run focused tests, Svelte checks and browser clicks at desktop/mobile widths, including sequential character and module import and recovery paths. Update 0.9.55 notes.
- [ ] Resume the repository's release workflow after required validation.

Review focus: navigating away during character import; double clicks; nested-folder back/retry; unreadable or unsupported entries; cancelled or failed imports never reported as completed.

Validation: 116 frontend tests and 173 server tests passed for the combined release changes; Svelte check reported zero errors/warnings. A separate read-only review found no important issues. Browser tests exercised the real app and import persistence with a simulated Proton SDK transport, including 1280px/390px screenshots, character import navigation, selected-file retry, another available file, empty folder and parent navigation. Canonical files contain the imported data. Development-server reload timing is kept separate from functional assertions.
