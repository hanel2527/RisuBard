<p align="center">
  <strong>English</strong> · <a href="README.md">한국어</a>
</p>

<h1 align="center">
  <img src="assets/readme/risubard-hero.png" alt="RisuBard — Next-Gen LLM Storytelling Frontend" width="900">
</h1>

<p align="center">
  A self-hosted AI roleplay frontend with bounded-context narrative memory.
</p>

<p align="center">
  <a href="https://github.com/rpaddict/RisuBard/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/rpaddict/RisuBard?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0-only" src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg"></a>
</p>

<p align="center">
  <strong><a href="https://github.com/rpaddict/RisuBard/releases">Download</a></strong> ·
  <a href="docs/en/install.md">Installation</a> ·
  <a href="docs/en/migration.md">Migrate from RisuAI</a> ·
  <a href="https://github.com/rpaddict/RisuBard/issues">Issues</a>
</p>

> **Project lineage:** RisuBard is developed as a fork of [PocketRisu](https://github.com/PocketRisu/PocketRisu).

RisuBard is built for character conversations that outgrow a model's context window. It preserves the original chat as evidence, maintains reusable narrative state in Obsidian-compatible Markdown, and compiles only the relevant memory into each bounded model request.

You keep the existing RisuAI ecosystem—characters, CHARX cards, lorebooks, modules, prompt presets, provider adapters, and plugin integration paths—while gaining a file-native storage architecture and a long-term memory system designed for persistent stories.

> RisuBard does not include or host an AI model. Connect a local model or a remote provider that you control.

## Contents

- [Why RisuBard?](#why-risubard)
- [How it works](#how-it-works)
- [Features](#features)
- [Quick start](#quick-start)
- [Compatibility and migration](#compatibility-and-migration)
- [Data and privacy](#data-and-privacy)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Lineage and license](#lineage-and-license)

## Why RisuBard?

<p align="center">
  <img src="assets/readme/why-risubard-01-en.png" alt="An AI hits memory and cost limits after rereading a growing story every turn" width="900">
</p>

<p align="center">
  <img src="assets/readme/why-risubard-02-en.png" alt="The AI compares the workload to memorizing four books again for every new page" width="900">
</p>

<p align="center">
  <img src="assets/readme/why-risubard-03-en.png" alt="RisuBard explains keeping notes on major facts and looking up details only when needed" width="900">
</p>

<p align="center">
  <img src="assets/readme/why-risubard-04-en.png" alt="RisuBard records and updates story events and characters in a wiki" width="900">
</p>

Long-running character chats eventually collide with a simple constraint: a model request cannot keep growing forever. Re-sending the entire conversation becomes expensive and ultimately exceeds the model's context window. Replacing the past with a single rolling summary can fit the limit, but important state, causality, and character knowledge may disappear.

RisuBard separates three responsibilities:

- **Original chat** is preserved as evidence and history.
- **BardWiki** stores durable narrative state as readable Markdown.
- **Model context** is compiled for each request under explicit token limits.

The result is a conversation whose stored history can continue growing without making the prompt budget grow with it.

## How it works

```text
Confirmed conversation
  ├─ original messages remain available as evidence
  └─ durable events and state update the Markdown BardWiki

Next model request
  ├─ character and world foundation
  ├─ current scene
  ├─ relevant BardWiki documents
  ├─ a bounded window of recent messages
  └─ the current user input
             │
             ▼
      fixed-budget compiler
             │
             ▼
      your configured model
```

Required context is never silently discarded. Optional memories are selected by relevance and priority, and the budget does not automatically expand with chat length or wiki size. A request manifest records what was included, excluded, or truncated without storing API keys or hidden reasoning.

## Features

- **Wiki-driven long-story memory:** RisuBard minimizes replay of old chat history, records durable events and character state in BardWiki, and retrieves relevant notes for each request—keeping context bounded as stories grow.
- **Visual-novel-style save/load:** Create named checkpoints for each chat, preview the recent conversation, and restore an earlier point without treating the whole chat as one irreversible timeline.
- **Plain-file data ownership:** Characters, chats, settings, indexes, and narrative memory live as ordinary files instead of being trapped in one opaque database. Atomic writes, journals, revisions, and trash-based deletion limit the blast radius of corruption and make recovery practical.
- **Per-chat personas with an AI builder:** Assign a different persona to each chat and create or refine personas with AI assistance.
- **Character Vault:** Browse, search, group, move, duplicate, import, export, and clean up large character collections from one workspace.
- **Lorebook workspace:** Search and organize entries, edit keys and activation rules, and manage folders in a full-featured editor.
- **Rebuilt interface:** Chat, settings, memory, character, persona, save, and lorebook workflows have been redesigned for clearer everyday use.

| BardWiki memory workspace | Chat save/load |
| --- | --- |
| ![BardWiki beside an active character chat](assets/readme/bardwiki-workspace.png) | ![Named save points with conversation previews](assets/readme/chat-save-slots.png) |
| **Character Vault** | **Lorebook editor** |
| ![Searchable character collection organized into folders](assets/readme/character-vault.png) | ![Lorebook workspace with folders, keys, and activation settings](assets/readme/lorebook-editor.png) |

## Quick start

The portable package is the simplest way to run RisuBard. It does not require Node.js or Docker.

1. Open [GitHub Releases](https://github.com/rpaddict/RisuBard/releases).
2. Download and extract the package for your platform.
3. Start RisuBard and open `http://localhost:7777`.

| Platform | Package | Start |
| --- | --- | --- |
| Windows x64 | `RisuBard-vX.Y.Z-win-x64.zip` | Double-click `RisuBard.exe` |
| Linux x64 | `RisuBard-vX.Y.Z-linux-x64.tar.gz` | Run `./start.sh` |
| Linux ARM64 | `RisuBard-vX.Y.Z-linux-arm64.tar.gz` | Run `./start.sh` |
| macOS Apple Silicon | `RisuBard-vX.Y.Z-macos-arm64.tar.gz` | Open `RisuBard.app` |

For Docker, source builds, remote access, updates, and platform-specific requirements, read the [complete installation guide](docs/en/install.md).

## Compatibility and migration

RisuBard is designed to extend an existing collection rather than strand it. The migration tools accept a normal RisuAI `.bin` backup, a zipped Node save folder, or a direct save-folder copy for large installations.

Back up the source installation before migrating, then follow the [RisuAI migration guide](docs/en/migration.md). Imports are validated before they replace active data, and the original `risuai.db` is copied to migration backups before an optional one-time extraction.

Compatibility is a release gate: automated suites cover backup round-trips, cold storage, remote blocks, settings-only exports, legacy presets, CHARX-related application paths, modules, and plugins.

## Data and privacy

RisuBard runs on infrastructure you control and stores canonical user data as ordinary files under its data root. You can set a separate absolute path with `RISUBARD_DATA_ROOT`; application code and user data do not need to share a directory.

Model traffic follows the provider you configure. Requests sent to a remote model provider are subject to that provider's data policy; requests to a local model remain within the environment you operate. RisuBard's request logs omit request and response bodies, authentication headers, URLs, API keys, and hidden reasoning.

Read [File-native user data](docs/en/file-native-storage.md) for the storage tree, crash-safety guarantees, backup behavior, and Termux restrictions.

## Documentation

| Topic | English | 한국어 |
| --- | --- | --- |
| Installation and updates | [Installation](docs/en/install.md) | [설치](docs/ko/install.md) |
| Migrating from RisuAI | [Migration](docs/en/migration.md) | [데이터 이전](docs/ko/migration.md) |
| BardWiki memory | — | [메모리 사용 안내](docs/ko/memory-wiki.md) |
| File-native storage | [Storage](docs/en/file-native-storage.md) | [파일 정본 저장](docs/ko/file-native-storage.md) |
| Remote access | [Remote access](docs/en/remote.md) | [원격 접속](docs/ko/remote.md) |
| Android | [Termux](docs/en/termux.md) | [Termux](docs/ko/termux.md) |
| Architecture | [Code boundaries](docs/architecture/code-boundaries.md) | [Code boundaries](docs/architecture/code-boundaries.md) |

Additional translated installation and migration guides are available in `docs/de`, `docs/cn`, `docs/es`, `docs/vi`, and `docs/zh-Hant`.

## Project status

RisuBard is under active development. Keep a current backup before migrating important data, and check the [release notes](https://github.com/rpaddict/RisuBard/releases) for changes that affect storage or compatibility.

The repository validates releases with Svelte and TypeScript checks, browser and server unit tests, compatibility round-trips, and a production build.

## Contributing

Issues, design discussions, documentation improvements, tests, and pull requests are welcome. For a substantial behavioral or architectural change, open an issue first so that compatibility and migration requirements can be agreed on before implementation.

Before submitting code, run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:compat
pnpm build
```

Changes must preserve existing CHARX, module, plugin, preset, and import/export compatibility unless an explicit migration path is included.

## Lineage and license

RisuBard is built on inherited GPLv3 RisuAI code and retains that project's license obligations and attribution. Independently authored RisuBard components are kept behind documented code boundaries so that provenance remains inspectable as the architecture evolves.

This repository is licensed under **GNU General Public License v3.0 only**. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and the [code-boundary architecture](docs/architecture/code-boundaries.md).
