---
name: codebase-wiki
description: Auto-maintained codebase knowledge base (Karpathy Wiki for code). Use when the user asks about codebase documentation, architectural decisions, commit history, changelog generation, or maintaining a wiki for their project.
---

# Codebase Wiki Skill

## Overview

pi-codebase-wiki implements the Karpathy Wiki pattern for software projects. Instead of RAG retrieval over raw code, it incrementally builds and maintains a structured markdown wiki from git commits and code documentation.

## When to Use

- "Initialize a wiki for this project"
- "Ingest recent commits into the wiki"
- "Why was this decision made?"
- "How has auth evolved over time?"
- "Generate a changelog"
- "What needs updating in the wiki?"
- "Create an ADR for this change"
- "Which modules depend on X?"

## Tools

| Tool | Description | Risk |
|------|-------------|------|
| `wiki_ingest` | Ingest commits, files, or docs into the wiki | medium |
| `wiki_query` | Search the wiki and synthesize an answer | safe |
| `wiki_lint` | Health-check the wiki for issues | safe |
| `wiki_status` | Show wiki stats, staleness, coverage | safe |
| `wiki_entity` | Create or update an entity page | medium |
| `wiki_decision` | Create or update an ADR | medium |
| `wiki_changelog` | Generate changelog from recent commits | safe |
| `wiki_evolve` | Trace how a feature changed over time | safe |

## Commands

| Command | Description |
|---------|-------------|
| `/wiki` | Show wiki status and INDEX.md |
| `/wiki-ingest [source]` | Ingest a source into the wiki |
| `/wiki-query <question>` | Ask a question against the wiki |
| `/wiki-lint` | Run health checks |
| `/wiki-init` | Initialize the wiki for the current project |
| `/wiki-entity <name>` | Open/view an entity page |
| `/wiki-decision <title>` | Create an ADR |
| `/wiki-changelog [range]` | Generate changelog |
| `/wiki-evolve <feature>` | Trace feature evolution |
| `/wiki-reindex` | Rebuild the wiki index |

## Architecture

Three layers:
1. **Raw sources** — git log, source files, configs (immutable)
2. **The wiki** — `.codebase-wiki/` directory of LLM-owned markdown pages
3. **Schema** — `.codebase-wiki/SCHEMA.md` — the constitution for LLM operations

Operations:
- **Ingest** — read raw sources, create/update wiki pages
- **Query** — search wiki pages, synthesize answers, file good answers back
- **Lint** — check for contradictions, orphans, staleness, broken links

## Examples

```
User: "Initialize the wiki"
→ /wiki-init
→ Creates .codebase-wiki/ with SCHEMA.md, templates, INDEX.md

User: "Ingest the last week of commits"
→ wiki_ingest({ source: "commits", range: "7d" })
→ Creates entity pages, updates INDEX, appends to LOG.md

User: "Why did we switch from LevelDB to SQLite?"
→ wiki_query({ question: "Why did we switch from LevelDB to SQLite?" })
→ Reads pi-learn entity page, ADR-002, evolution page
→ Returns synthesized answer with cross-references

User: "Check if the wiki is up to date"
→ wiki_lint({})
→ Reports 3 stale pages, 1 orphan, 2 missing concepts
```