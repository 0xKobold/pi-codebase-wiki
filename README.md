# 📖 pi-codebase-wiki

> **Keeps a wiki for your code that updates itself** — reads your git history and docs so you can ask questions about your codebase.

[![npm version](https://img.shields.io/npm/v/@0xkobold/pi-codebase-wiki)](https://www.npmjs.com/package/@0xkobold/pi-codebase-wiki)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Idea

Instead of RAG retrieval that starts fresh on every query, you build a **persistent, compounding wiki** from your git history and code. Knowledge compiled once and kept current beats knowledge re-derived on every question.

**pi-codebase-wiki** reads your commits and docs, incrementally builds a structured wiki, and keeps it current as code changes. Works as a [pi](https://github.com/mariozechner/pi-coding-agent) extension, a standalone CLI, or a programmatic library.

## Three Ways to Use

### 1. As a pi Extension

For agents running inside pi — automatic context injection, tool calls, and commands.

```bash
pi install @0xkobold/pi-codebase-wiki
```

Then use tools like `wiki_ingest`, `wiki_query`, `wiki_lint` and commands like `/wiki`, `/wiki-init`, `/wiki-ingest all`.

### 2. As a CLI 🐹

Powered by [kapy](https://moikapy.dev/kapy) — agent-first, works in any terminal. No pi required.

> **Note:** For string flags, use `--flag=value` syntax (e.g. `--summary="My summary"`) to avoid parsing ambiguity with kapy's global arg scanner.

```bash
# Install globally
bun install -g @0xkobold/pi-codebase-wiki

# Initialize wiki in current project
wiki wiki-init

# Ingest sources
wiki ingest all

# Search the wiki
wiki query "Why did we switch from LevelDB to SQLite?"

# Health check
wiki lint

# Show stats
wiki status

# Create an entity page
wiki entity auth-module --summary="Handles user authentication" --type=module

# Create an ADR
wiki decision "Use SQLite over LevelDB" --context="Need reliable persistence" --choice="SQLite for durability"

# Generate changelog
wiki changelog --since="2 weeks ago"

# Trace feature evolution
wiki evolve auth

# Launch local web UI with graph visualization
wiki serve --port=3000 --open

# All commands support --json for machine-readable output
wiki status --json
wiki query "how does hot-reload work?" --json
```

Every command supports `--json` (structured output) and `--no-input` (non-interactive) — designed for agents and automation.

### 3. As a Library

Import the pure operations directly — no pi, no CLI, just functions.

```typescript
import {
  initWiki,
  ingestCommits,
  ingestFileTree,
  searchWiki,
  lintWiki,
  WikiStore,
  getRecentCommits,
} from "@0xkobold/pi-codebase-wiki/core";

// Initialize
const store = new WikiStore(".codebase-wiki/meta/wiki.db");
await store.init();

// Ingest
const result = await ingestCommits(process.cwd(), config, store, "1 week ago");

// Query
const matches = searchWiki("how does auth work", wikiPath, store, 10);

// Lint
const issues = lintWiki(wikiPath, store);
```

## Three-Layer Architecture

```
┌─────────────────────────────────────┐
│  Layer 1: Raw Sources (IMMUTABLE)  │  git log, source files, configs
├─────────────────────────────────────┤
│  Layer 2: The Wiki (LLM-OWNED)      │  .codebase-wiki/ — markdown pages
├─────────────────────────────────────┤
│  Layer 3: Schema (CO-EVOLVING)      │  .codebase-wiki/SCHEMA.md
└─────────────────────────────────────┘
```

## Quick Start

```bash
# As a pi extension
pi install @0xkobold/pi-codebase-wiki
/wiki-init
/wiki-ingest all

# As a standalone CLI
bun install -g @0xkobold/pi-codebase-wiki
wiki wiki-init
wiki ingest all
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `wiki wiki-init` | Initialize `.codebase-wiki/` for current project |
| `wiki ingest [source]` | Ingest commits, tree, smart, llm, or all |
| `wiki query <question>` | Search the wiki |
| `wiki lint` | Health check: orphans, stale pages, broken links |
| `wiki status` | Show page counts, staleness, last ingest |
| `wiki entity <name>` | Create or update an entity page |
| `wiki decision <title>` | Create an Architecture Decision Record |
| `wiki concept <name>` | Create or update a concept page |
| `wiki changelog` | Generate changelog from recent commits |
| `wiki evolve <feature>` | Trace feature evolution over time |
| `wiki reindex` | Rebuild the wiki index |
| `wiki serve` | Start local web UI with graph visualization |

## pi Tools

| Tool | What It Does |
|------|-------------|
| `wiki_ingest` | Ingest commits, files, or docs into the wiki |
| `wiki_query` | Search the wiki and synthesize answers |
| `wiki_lint` | Health check: orphans, stale pages, broken links |
| `wiki_status` | Show wiki stats, staleness, coverage |
| `wiki_entity` | Create or update an entity page |
| `wiki_decision` | Create an Architecture Decision Record (ADR) |
| `wiki_concept` | Create or update a concept page |
| `wiki_changelog` | Generate changelog from recent commits |
| `wiki_evolve` | Trace how a feature changed over time |

## pi Commands

| Command | Description |
|---------|-------------|
| `/wiki` | Show wiki status and INDEX.md |
| `/wiki-init` | Initialize the wiki for the current project |
| `/wiki-ingest [source]` | Ingest commits, tree, docs, or all |
| `/wiki-query <question>` | Ask a question against the wiki |
| `/wiki-lint` | Run health checks |
| `/wiki-reindex` | Rebuild the wiki index |

## Wiki Structure

```
.codebase-wiki/
├── SCHEMA.md            # The constitution (how the LLM maintains the wiki)
├── INDEX.md             # Master index with links to all pages
├── CHANGELOG.md         # Auto-generated from commits
├── entities/            # Code entity pages
│   ├── auth-module.md
│   └── event-bus.md
├── concepts/            # Cross-cutting concept pages
│   └── hot-reload-pattern.md
├── decisions/           # Architecture Decision Records
│   └── 001-sqlite-over-leveldb.md
├── evolution/           # How things changed over time
│   └── auth-evolution.md
├── comparisons/         # Side-by-side analysis
│   └── pi-learn-vs-generative-agents.md
├── templates/           # Page templates
│   ├── entity.md
│   ├── concept.md
│   ├── decision.md
│   └── evolution.md
└── meta/
    ├── LOG.md           # Ingest log
    ├── STATS.md         # Wiki health stats
    └── wiki.db          # SQLite metadata (sql.js)
```

## How It Works

1. **Ingest**: You add a source (commits, file tree, docs). The LLM reads it, extracts key information, and integrates it into the wiki — creating pages, updating cross-references, appending to the log. A single commit might touch 5-10 wiki pages.

2. **Query**: You ask a question. The LLM searches the wiki (not the raw source), reads relevant pages, and synthesizes an answer. Good answers get filed back as new pages. Knowledge compounds.

3. **Lint**: Periodic health checks find contradictions, orphans, stale pages, broken links, and missing concepts. Think of it as `eslint` for knowledge.

## Key Principle

> **The LLM writes. You read.** You curate sources and ask questions. The LLM does the bookkeeping.

## Web UI

`wiki serve` launches a local web interface with:

- **Page browser** — sidebar with all pages, type-coded dots (entity, concept, decision, etc.)
- **Content viewer** — rendered markdown with clickable `[[wikilinks]]` and metadata
- **Full-text search** — search across all pages with relevance scoring
- **Interactive graph** — force-directed node graph showing how pages connect, drag nodes, zoom, double-click to navigate
- **Dark mode** — because we live in terminals

```bash
wiki serve              # Start on port 3000
wiki serve --port=8080 # Custom port
wiki serve --open      # Auto-open browser
```

All data comes from the API (`/api/pages`, `/api/graph`, `/api/search`). The UI is a single HTML page — no build tools, no external deps.

## License

MIT