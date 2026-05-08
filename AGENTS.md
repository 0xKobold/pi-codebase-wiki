# AGENTS.md — pi-codebase-wiki

> Pi extension that keeps a wiki for your code that updates itself.

## Architecture

Three-layer design:

1. **Raw sources** — git log, source files, docs, URLs (immutable)
2. **The wiki** — `.codebase-wiki/` directory of LLM-owned markdown pages
3. **Schema** — `.codebase-wiki/SCHEMA.md` — the constitution for wiki operations

Storage: **sql.js** (WASM SQLite) at `.codebase-wiki/meta/wiki.db` — works in both Bun and Node.

## Key Files

| Path | Purpose |
|------|---------|
| `src/index.ts` | Extension entry point — registers all tools, commands, hooks |
| `src/shared.ts` | Types (`WikiPage`, `WikiConfig`, `PageTypeConfig`, etc.), constants, utilities |
| `src/core/config.ts` | Config loading from SCHEMA.md, domain presets, page type templates |
| `src/core/store.ts` | `WikiStore` — SQLite CRUD for pages, cross-refs, sources, logs |
| `src/core/git.ts` | Git log parsing, commit classification, branch/hash helpers |
| `src/core/indexer.ts` | `scanFileTree` — walks source tree, creates entity pages |
| `src/core/smart-ingest.ts` | Regex/heuristic enrichment — reads source files, fills stubs, adds cross-refs |
| `src/core/llm-enrich.ts` | LLM enrichment — generates prompts for the agent to write richer pages |
| `src/core/staleness.ts` | Staleness detection and contradiction finding |
| `src/core/versioning.ts` | Git-based wiki versioning — auto-commit, hash tracking |
| `src/core/deps.ts` | Import/export extraction, dependency graph building |
| `src/core/frontmatter.ts` | YAML frontmatter parse/serialize for wiki pages |
| `src/core/templates.ts` | Page template generation per page type |
| `src/operations/ingest.ts` | `initWiki`, `ingestCommits`, `ingestFileTree`, `updateIndex` |
| `src/operations/query.ts` | `searchWiki`, `getPageContent`, `getRelatedPages` |
| `src/operations/lint.ts` | `lintWiki`, `formatLintResult` — health checks |
| `src/operations/resolve.ts` | `mergePages`, `updatePages`, `splitPage` — contradiction resolution |
| `src/operations/proposal.ts` | Guided/confirm ingestion — proposal CRUD |
| `src/operations/log.ts` | Ingest log append/parse/query |
| `src/operations/source.ts` | Arbitrary source ingestion (articles, URLs, notes) |
| `src/web/server.ts` | Web UI server for browsing the wiki |
| `src/cli.ts` | CLI entry point (kapy-based) |

## Convention & Style

- **NASA-10 rules**: Small functions, minimal scope, `console.assert` for validation
- **No native dependencies**: sql.js is WASM — no native build step
- **Pure operations**: Core operations (`src/core/`) have zero pi dependency — importable from `./core/index.ts`
- **Extension hook**: `before_agent_start` injects wiki context into the agent's prompt (relevant pages, staleness)
- **Karpathy pattern**: Good queries get filed back as wiki pages; contradictions from lint trigger follow-up messages

## Domain Presets

Four presets via SCHEMA.md `domain` field: `codebase` (default), `personal`, `research`, `book`. Each changes available page types, directories, and source types.

## Config Flow

1. `DEFAULT_WIKI_CONFIG` in `shared.ts` → baseline
2. `SCHEMA.md` in the wiki directory → overrides (domain, page types, ingestion mode)
3. `ensureInitialized()` → merges SCHEMA.md into state on first load

## Page Lifecycle

1. **Created** by ingest, entity tool, or manual file creation
2. **Enriched** by smart-ingest (regex) or llm-enrich (agent writes content)
3. **Flagged stale** when source files change (via `tool_call` hook on edit/write)
4. **Re-ingested** on next `wiki_ingest` run
5. **Linted** for contradictions, orphans, broken links

## When Working On This Codebase

- Run `bun test` before committing — all tests must pass
- The store is async (`await store.init()` before use, `store.close()` on shutdown)
- Page IDs are kebab-case slugs — use `toSlug()` to generate, `validateSlug()` to check
- All file writes go through `commitWiki()` which updates INDEX.md and auto-commits to git
- Source manifests track provenance — every ingested source gets a UUID and SHA-256 hash
- Cross-references are bidirectional — `addCrossReference(from, to, context)` stores both directions

## Web UI

`src/web/server.ts` serves a read-only HTML interface at the wiki root. `ui.html` is embedded. Not yet integrated into the extension — lives as a standalone HTTP server.

## CLI

`src/cli.ts` uses `@moikapy/kapy` for CLI framework. Exposes all wiki operations as subcommands. Build with `tsc`, outputs to `dist/`.