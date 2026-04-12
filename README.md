# 📖 pi-codebase-wiki

> **Karpathy Wiki for codebases.** Auto-maintained knowledge base from git commits and code documentation.

[![npm version](https://img.shields.io/npm/v/@0xkobold/pi-codebase-wiki)](https://www.npmjs.com/package/@0xkobold/pi-codebase-wiki)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Idea

Andrej Karpathy's LLM Wiki pattern proved that **compiled knowledge > re-derived knowledge**. Instead of RAG retrieval that starts fresh on every query, you build a **persistent, compounding wiki** that the LLM writes and maintains.

**pi-codebase-wiki applies this to software projects.** Your codebase and commit history become the raw sources. The extension incrementally compiles them into a living documentation wiki that stays current as code changes.

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
# Install
pi install @0xkobold/pi-codebase-wiki

# Initialize wiki for your project
/wiki-init

# Ingest recent commits and file tree
/wiki-ingest all

# Search the wiki
/wiki-query "Why did we switch from LevelDB to SQLite?"

# Health check
/wiki-lint
```

## Tools

| Tool | What It Does |
|------|-------------|
| `wiki_ingest` | Ingest commits, files, or docs into the wiki |
| `wiki_query` | Search the wiki and synthesize answers |
| `wiki_lint` | Health check: orphans, stale pages, broken links |
| `wiki_status` | Show wiki stats, staleness, coverage |
| `wiki_entity` | Create or update an entity page |
| `wiki_decision` | Create an Architecture Decision Record (ADR) |
| `wiki_changelog` | Generate changelog from recent commits |
| `wiki_evolve` | Trace how a feature changed over time |

## Commands

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

## License

MIT