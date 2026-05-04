# pi-codebase-wiki v2 — General-Purpose LLM Wiki Specification

> **Bridges the gap** between the current codebase-only wiki and the general-purpose "LLM Wiki" pattern described by Karpathy. Turns a code-focused tool into a domain-agnostic knowledge compounding engine.

---

## The Gap

The current `pi-codebase-wiki` is **tightly coupled to code**: its only raw sources are `git log` and file trees, and its page types (entity, concept, decision, evolution) map 1:1 to code modules. The LLM Wiki pattern is broader — it works for **any domain** (personal journals, research papers, books, business docs) where raw sources are articles, PDFs, notes, and conversations, not just git diffs.

This spec describes the changes needed to make pi-codebase-wiki serve **both** codebases and general knowledge, while keeping the codebase use case a first-class citizen.

### What We Have (v0.6)

| Capability | Status |
|---|---|
| Git commit ingestion | ✅ Full |
| File tree ingestion | ✅ Full |
| Smart ingest (regex/heuristic enrichment from source) | ✅ Full |
| LLM enrich (prompts agent to write richer pages) | ✅ Full |
| Entity/concept/decision/evolution pages | ✅ Full |
| SQLite metadata store | ✅ Full |
| Wikilink cross-references | ✅ Full |
| Keyword search (BM25-like) | ✅ Full |
| Staleness detection (file mtime) | ✅ Full |
| Lint (orphans, broken links, contradictions, missing concepts) | ✅ Full |
| Web UI (page browser, graph, search) | ✅ Full |
| CLI (kapy-based, all commands) | ✅ Full |
| pi extension (tools, commands, session hooks) | ✅ Full |
| Query filing (queries saved as wiki pages) | ✅ Full |
| Changelog generation | ✅ Full |
| Dependency extraction (imports/exports) | ✅ Full |

### What We Need (v2)

| Capability | Gap |
|---|---|
| **Arbitrary raw source ingestion** (articles, PDFs, notes, conversations, URLs) | ❌ Only git + file tree |
| **Source type awareness** (articles ≠ commits) | ❌ All sources treated same |
| **Incremental update of existing pages** (contradiction resolution) | ❌ Update just appends timestamps |
| **LOG.md as structured, parseable diary** | ❌ LOG.md exists but minimal |
| **Human-in-the-loop ingestion workflow** | ❌ Fully automatic, no confirmation |
| **Configurable page types** (not hardcoded to code entities) | ❌ Hard-coded entity/concept/decision |
| **Document source management** (immutable source layer) | ❌ Sources live in git, not in the wiki |
| **Image/asset handling** | ❌ Text only |
| **Output format flexibility** (Marp slides, charts) | ❌ Markdown only |
| **Domain-agnostic SCHEMA.md** | ❌ SCHEMA.md is code-focused |
| **Answer filing** (query → new page, with back-references) | ⚠️ Partial (query pages exist but basic) |
| **Contradiction detection that updates pages** | ⚠️ Detects but doesn't resolve |
| **Obsidian compatibility** (backlinks, frontmatter) | ❌ No frontmatter, basic wikilinks |

---

## Architecture Changes

### Three Layers (Generalized)

```
┌──────────────────────────────────────────────────────┐
│  Layer 1: Raw Sources (IMMUTABLE)                   │
│  ─ .codebase-wiki/sources/                           │
│  ─ git log, articles, PDFs, notes, conversations    │
│  ─ Each source gets a UUID manifest entry            │
│  ─ Never modified after ingestion                    │
├──────────────────────────────────────────────────────┤
│  Layer 2: The Wiki (LLM-OWNED)                      │
│  ─ .codebase-wiki/entities/  (or custom type dirs)  │
│  ─ .codebase-wiki/queries/    (filed answers)        │
│  ─ .codebase-wiki/concepts/  (cross-cutting)        │
│  ─ .codebase-wiki/comparisons/                      │
│  ─ .codebase-wiki/decisions/  (ADRs)                │
│  ─ .codebase-wiki/evolution/  (timelines)            │
│  ─ .codebase-wiki/journals/   (personal entries)      │
│  ─ Markdown + YAML frontmatter                       │
│  ─ The LLM writes it. You read it.                    │
├──────────────────────────────────────────────────────┤
│  Layer 3: Schema (CO-EVOLVING)                       │
│  ─ .codebase-wiki/SCHEMA.md                          │
│  ─ Now includes: source types, page type config,      │
│    ingestion workflow, domain-specific conventions     │
└──────────────────────────────────────────────────────┘
```

### Key Architectural Shifts

1. **Sources live inside the wiki** at `.codebase-wiki/sources/` — not just referenced by path. The LLM Wiki pattern requires that raw sources are accessible, immutable, and co-located.

2. **Source manifests** track every ingested source with UUID, type, hash, and date. The current system only tracks git hashes; we need to track any source type.

3. **Page types become configurable** — codebase wikis get `entity`, `concept`, `decision`, `evolution`; personal wikis might get `person`, `topic`, `insight`, `media`; book wikis get `character`, `theme`, `chapter`, `location`.

4. **Contradiction resolution** — when lint detects contradictions between pages, it should suggest merges or updates, and the LLM should be able to resolve them.

5. **LOG.md becomes the primary timeline** — parseable with unix tools, consistent prefixes, structured enough for the LLM to understand what happened and when.

---

## Data Model Changes

### Source Manifest

```typescript
interface SourceManifest {
  id: string;                    // UUID
  type: SourceType;
  title: string;
  path: string;                  // Relative to .codebase-wiki/sources/
  hash: string;                  // SHA-256 of file contents (immutability check)
  ingestedAt: string;            // ISO timestamp
  pagesCreated: string[];        // Page IDs that were created/updated from this source
  metadata: Record<string, any>; // Type-specific metadata
}

type SourceType =
  | "git-commits"               // Batch of git commits (existing)
  | "article"                   // Web article, PDF, blog post
  | "note"                      // Personal note, journal entry
  | "conversation"              // Chat transcript, meeting notes
  | "document"                  // README, spec, design doc
  | "media"                     // Image, diagram, video transcript
  | "url"                       // Fetched web resource
  | "manual";                   // Manual entry by user
```

The source manifest is stored in `.codebase-wiki/sources/manifest.json` and managed by the WikiStore.

### Configurable Page Types

```typescript
interface PageTypeConfig {
  id: string;                    // kebab-case type ID
  name: string;                  // Display name
  directory: string;              // Subdirectory (e.g., "entities", "people")
  template: string;               // Template name (references templates/*.md)
  requiredSections: string[];    // Sections that must exist
  sourceTypes?: SourceType[];    // Which source types can create this page type
  icon?: string;                 // Emoji for UI display
}

// Default for codebase wikis (backward compatible)
const CODEBASE_PAGE_TYPES: PageTypeConfig[] = [
  { id: "entity",    name: "Entity",    directory: "entities",    template: "entity.md",    requiredSections: ["Summary", "See Also"], sourceTypes: ["git-commits", "document"] },
  { id: "concept",   name: "Concept",   directory: "concepts",    template: "concept.md",    requiredSections: ["Summary", "See Also"], sourceTypes: ["article", "note", "conversation"] },
  { id: "decision",  name: "Decision",  directory: "decisions",  template: "decision.md",   requiredSections: ["Context", "Decision", "Consequences"], sourceTypes: ["git-commits", "conversation", "manual"] },
  { id: "evolution", name: "Evolution", directory: "evolution",   template: "evolution.md",  requiredSections: ["Timeline", "Current State"], sourceTypes: ["git-commits"] },
  { id: "comparison",name: "Comparison",directory: "comparisons", template: "comparison.md", requiredSections: ["Comparison", "Recommendation"], sourceTypes: ["article", "note"] },
  { id: "query",    name: "Query",     directory: "queries",     template: "query.md",      requiredSections: ["Matched Pages"], sourceTypes: ["manual"] },
];

// Example: Personal knowledge wiki
const PERSONAL_PAGE_TYPES: PageTypeConfig[] = [
  { id: "person",   name: "Person",   directory: "people",     template: "person.md",    requiredSections: ["Summary", "See Also"] },
  { id: "topic",    name: "Topic",    directory: "topics",      template: "topic.md",     requiredSections: ["Summary", "Key Ideas"] },
  { id: "insight",  name: "Insight",  directory: "insights",    template: "insight.md",   requiredSections: ["Summary", "Connections"] },
  { id: "media",    name: "Media",    directory: "media",       template: "media.md",    requiredSections: ["Summary", "Takeaways"] },
  { id: "habit",    name: "Habit",    directory: "habits",       template: "habit.md",     requiredSections: ["Summary", "Tracking"] },
];

// Example: Book reading wiki
const BOOK_PAGE_TYPES: PageTypeConfig[] = [
  { id: "character", name: "Character", directory: "characters", template: "character.md", requiredSections: ["Summary", "Arc"] },
  { id: "theme",     name: "Theme",     directory: "themes",     template: "theme.md",      requiredSections: ["Summary", "Examples"] },
  { id: "location",  name: "Location",  directory: "locations", template: "location.md",   requiredSections: ["Summary", "Significance"] },
  { id: "chapter",   name: "Chapter",  directory: "chapters",  template: "chapter.md",    requiredSections: ["Summary", "Key Events"] },
];
```

Page type configs are defined in `SCHEMA.md` and parsed at init time. The current hardcoded `PageType` union becomes dynamic.

### YAML Frontmatter

Every wiki page gets YAML frontmatter for machine-readable metadata:

```markdown
---
id: auth-module
type: entity
title: Auth Module
sources:
  - src-git-commits-2026-04
  - src-article-oauth-guide
created: 2026-03-15
updated: 2026-04-28
stale: false
stale_files: []
links:
  - event-bus
  - oauth-flow
linked_from:
  - index
  - api-gateway
---

# Auth Module

> **Summary**: Handles user authentication...

```

**Why frontmatter?**
- Obsidian, Dataview, and other tools can query it
- Lint can check required sections by reading frontmatter + content
- Staleness tracking is transparent (not hidden in SQLite)
- Cross-references are bidirectional and visible
- Works without the SQLite store (markdown-native)

### WikiPage (Updated)

```typescript
interface WikiPage {
  id: string;                     // kebab-case slug (unchanged)
  path: string;                   // Relative path from wiki root
  type: string;                   // Dynamic — matches PageTypeConfig.id (not union)
  title: string;
  summary: string;
  sourceFiles: string[];
  sourceCommits: string[];
  sourceIds: string[];            // NEW: references to SourceManifest IDs
  lastIngested: string;
  lastChecked: string;
  inboundLinks: number;
  outboundLinks: number;
  stale: boolean;
  metadata: Record<string, any>; // NEW: extensible metadata from frontmatter
}
```

---

## New Operations

### 1. Source Ingestion (Generalized)

The current `wiki_ingest` handles git commits and file trees. v2 adds arbitrary source ingestion.

```typescript
// New tool: wiki_ingest_source
interface IngestSourceParams {
  type: "article" | "note" | "conversation" | "document" | "url" | "media" | "manual";
  title: string;
  content: string;               // Raw text content
  url?: string;                   // For articles fetched from the web
  filePath?: string;              // For local files to copy into sources/
  metadata?: Record<string, any>; // Type-specific metadata
  pageType?: string;              // Which page type to create (auto-detected if omitted)
  updateExisting?: string[];      // Page IDs to update (cross-reference)
}
```

**Workflow:**

1. Copy or write the source to `.codebase-wiki/sources/{type}/{uuid}.{ext}`
2. Compute SHA-256 hash, record in manifest
3. Parse content, extract key information
4. Create or update wiki pages based on extracted info
5. Update INDEX.md and LOG.md
6. Return summary of what was ingested and which pages were touched

**Implementation:** The extension sends the source content to the LLM agent via `pi.sendUserMessage()`, asking it to:
- Read the source
- Create/update relevant wiki pages
- Update cross-references
- Append to LOG.md

The extension handles bookkeeping (manifest, INDEX, frontmatter updates).

### 2. Structured LOG.md

The current LOG.md is a simple markdown table. v2 makes it parseable with consistent prefixes:

```markdown
# Ingest Log

## [2026-04-28T14:30:00] ingest | git-commits | auth-module updated

- **Source**: `.codebase-wiki/sources/git-commits/2026-04-28.json`
- **Pages created**: [[oauth-flow]]
- **Pages updated**: [[auth-module]], [[index]]
- **Pages flagged stale**: [[api-gateway]] (3 source files changed)

## [2026-04-28T15:00:00] ingest | article | "Understanding OAuth 2.0"

- **Source**: `.codebase-wiki/sources/article/oauth-guide.md`
- **Pages created**: [[oauth-flow]], [[oauth-security]]
- **Pages updated**: [[auth-module]], [[security-concepts]]
- **Contradictions detected**: [[auth-module]] line 15 conflicts with new source

## [2026-04-29T09:00:00] query | "Why did we switch from LevelDB?"

- **Filed as**: [[query-why-leveldb-to-sqlite]]
- **Matched pages**: [[auth-module]], [[adr-002-sqlite]]
- **Answer filed**: Yes
```

**Parse with:** `grep "^## \[" LOG.md | tail -5`

### 3. Answer Filing

The current `wiki_query` already files queries as pages, but they're basic. v2 enriches them:

```markdown
---
id: query-why-leveldb-to-sqlite
type: query
sources:
  - src-git-commits-2026-03
created: 2026-04-29
updated: 2026-04-29
links:
  - auth-module
  - adr-002-sqlite-over-leveldb
  - pi-learn
---

# Why did we switch from LevelDB to SQLite?

> **Query**: Why did we switch from LevelDB to SQLite?
> **Filed**: 2026-04-29
> **Sources**: 3 wiki pages

## Answer

We switched because...

## Related Pages

- [[adr-002-sqlite-over-leveldb]] — The ADR documenting this decision
- [[auth-module]] — Uses SQLite for session storage
- [[pi-learn]] — Dream cycle originally used LevelDB, migrated in v0.5

## Open Questions

- What about IndexedDB for browser contexts?
- Is SQLite viable for high-concurrency writes?
```

### 4. Human-in-the-Loop Ingestion

New configuration in SCHEMA.md:

```yaml
# Ingestion Workflow
ingestion:
  mode: "confirm"           # "auto" | "confirm" | "guided"
  # auto: create pages without asking (current behavior)
  # confirm: ask before creating new pages
  # guided: discuss each source before processing
  
  confirm_thresholds:
    new_page_creation: true     # Ask before creating a new page
    page_deletion: true          # Ask before deleting/merging pages
    contradiction_resolution: true  # Ask before resolving contradictions
    cross_reference_update: false    # Don't ask for cross-ref updates
```

In `confirm` mode, the extension sends a message to the agent with proposed changes before writing them:

```
📖 **Ingest Proposal**

Processing: "Understanding OAuth 2.0" (article)

**New pages to create:**
- [[oauth-flow]] — OAuth 2.0 authorization flow pattern
- [[oauth-security]] — Security considerations for OAuth

**Pages to update:**
- [[auth-module]] — Add OAuth section, update summary
- [[security-concepts]] — Add OAuth reference

**Cross-references to add:**
- [[oauth-flow]] → [[auth-module]] (implemented by)
- [[auth-module]] → [[oauth-flow]] (uses)

Should I proceed? Or would you like to adjust any of these?
```

### 5. Contradiction Resolution

When `wiki_lint` detects contradictions (high content overlap between pages), v2 adds a resolution workflow:

```typescript
// Enhanced lint result
interface ContradictionIssue extends LintIssue {
  type: "contradiction";
  pages: [WikiPage, WikiPage];       // The two conflicting pages
  similarity: number;                  // Jaccard similarity
  suggestion: "merge" | "update" | "split";
  mergeTarget?: string;               // Suggested target if merging
}
```

When contradictions are found, the extension sends a message asking the agent to resolve them:

```
⚠️ Lint found 2 contradictions:

1. [[auth-module]] and [[oauth-flow]] have 68% content overlap
   → Suggestion: Merge OAuth flow details into [[oauth-flow]], keep [[auth-module]] as overview

2. [[event-bus]] and [[pub-sub-pattern]] have 72% overlap
   → Suggestion: [[pub-sub-pattern]] should reference [[event-bus]] as implementation

Use `wiki_ingest source=llm` to resolve these, or edit manually.
```

### 6. SCHEMA.md v2

The SCHEMA.md becomes a proper configuration document with domain selection:

```markdown
# Wiki Schema — {project-name}

## Domain

codebase    # or "personal", "research", "book", "business", "custom"

## Source Types

# Which raw source types this wiki accepts
- git-commits: true
- articles: true
- notes: true
- conversations: false
- urls: true
- media: false

## Page Types

# Codebase entities (default)
- entity: { directory: entities, icon: 📦 }
- concept: { directory: concepts, icon: 💡 }
- decision: { directory: decisions, icon: ⚖️ }
- evolution: { directory: evolution, icon: 📈 }
- comparison: { directory: comparisons, icon: ⚖️ }
- query: { directory: queries, icon: 🔍 }

## Ingestion Workflow

mode: confirm
confirm_thresholds:
  new_page_creation: true
  page_deletion: true
  contradiction_resolution: true

## Naming

slug_format: kebab-case
link_format: "[[slug]]"

## Page Structure

require_frontmatter: true
require_summary: true
require_see_also: true

## Scope

include:
  - src/**
  - lib/**
  - packages/*/src/**

exclude:
  - node_modules
  - dist
  - .git
  - .codebase-wiki

## Contradiction Policy

similarity_threshold: 0.6
same_type_suggestion: merge
cross_type_suggestion: cross-reference
```

### 7. Initialize with Domain

New `wiki_init` gains a `--domain` flag:

```bash
wiki init --domain=codebase    # Current behavior (default)
wiki init --domain=personal    # Personal knowledge wiki
wiki init --domain=research    # Research paper wiki
wiki init --domain=book        # Book reading wiki
wiki init --domain=business    # Internal team wiki
```

Each domain preset configures:
- Default page types
- Default source types
- Default templates
- Default SCHEMA.md content

---

## New CLI Commands

| Command | Description |
|---------|-------------|
| `wiki ingest-source --type=article --title="..." --content="..."` | Ingest an arbitrary source |
| `wiki ingest-url <url>` | Fetch and ingest a web article |
| `wiki init --domain=codebase\|personal\|research\|book` | Initialize with domain presets |
| `wiki sources` | List all ingested sources |
| `wiki sources --type=article` | Filter sources by type |
| `wiki serve --port=3000` | Start web UI (existing) |

---

## New pi Tools

| Tool | Description | Risk |
|------|-------------|------|
| `wiki_ingest` | Ingest sources (updated: supports `source` type) | medium |
| `wiki_ingest_source` | Ingest an arbitrary source (article, note, conversation, etc.) | medium |
| `wiki_ingest_url` | Fetch and ingest a web article | medium |
| `wiki_query` | Search and synthesize (existing, enhanced answer filing) | safe |
| `wiki_lint` | Health check (existing, enhanced with contradiction resolution) | safe |
| `wiki_status` | Show stats (existing, enhanced with source manifest info) | safe |
| `wiki_entity` | Create/update entity (existing) | medium |
| `wiki_decision` | Create ADR (existing) | medium |
| `wiki_concept` | Create/update concept (existing) | medium |
| `wiki_changelog` | Generate changelog (existing) | safe |
| `wiki_evolve` | Trace feature evolution (existing) | safe |
| `wiki_resolve` | Resolve a contradiction between two pages | medium |

---

## Implementation Phases

### Phase 1: Source Management (Foundation)

The critical gap — making sources a first-class concept.

**Goal:** Any type of source can be ingested, not just git commits.

- [x] Add `SourceManifest` type and storage in WikiStore
- [x] Create `.codebase-wiki/sources/` directory structure: `{type}/{uuid}.{ext}`
- [x] Implement `wiki_ingest_source` tool/command for arbitrary content
- [x] Implement `wiki_ingest_url` tool/command for web articles
- [x] Update `wiki_ingest` to create source manifests for commit ingests
- [x] Add YAML frontmatter to all wiki pages (backward-compatible: detect and add)
- [x] Update `updateIndex()` to include source references
- [x] Add `wiki sources` command to list ingested sources
- [x] Update SCHEMA.md template to include source types section

**Files changed:**
- `src/shared.ts` — Add `SourceManifest`, `SourceType`, `PageTypeConfig` types
- `src/core/store.ts` — Add `sources` and `source_manifests` tables
- `src/core/config.ts` — Parse page type configs from SCHEMA.md, domain presets
- `src/operations/ingest.ts` — Refactor to handle arbitrary sources
- `src/operations/source.ts` — NEW: Source ingestion pipeline
- `src/index.ts` — Register new tools/commands
- `src/cli.ts` — Add `ingest-source`, `ingest-url`, `sources` commands

### Phase 2: Domain Presets & Configurable Page Types

**Goal:** Initialize different wiki types for different use cases.

- [x] Define domain presets (codebase, personal, research, book, business)
- [x] Each preset configures page types, templates, SCHEMA.md, and default queries
- [x] Create template sets for each domain (e.g., `person.md`, `topic.md`, `chapter.md`)
- [x] Make `PageType` dynamic — read from SCHEMA.md config, not hardcoded union
- [x] Update `PAGE_TYPE_DIR` to be derived from config
- [x] Update `wiki_init` to accept `--domain` flag
- [ ] Update web UI to show page type icons from config

**Files changed:**
- `src/core/config.ts` — Domain presets, page type config parsing
- `src/shared.ts` — `PageType` becomes `string`, add `PageTypeConfig`
- `src/operations/ingest.ts` — Dynamic page type directory creation
- `src/web/server.ts` — Use page type config for display

### Phase 3: Human-in-the-Loop Ingestion

**Goal:** Let users review and approve changes before they're written.

- [x] Add `ingestion.mode` config (auto/confirm/guided)
- [x] Add `confirm_thresholds` config
- [x] Implement confirm mode: generate proposal, send to agent, wait for approval
- [x] Update `wiki_ingest` to respect mode
- [x] Update `wiki_ingest_source` to respect mode
- [x] Add proposal generation (list pages to create, update, cross-ref changes)
- [x] Store proposals in `.codebase-wiki/meta/proposals/` for review

**Files changed:**
- `src/core/config.ts` — Parse ingestion config from SCHEMA.md
- `src/operations/ingest.ts` — Proposal generation
- `src/operations/proposal.ts` — NEW: Proposal management
- `src/index.ts` — Confirm/reject flow for pi extension

### Phase 4: Contradiction Resolution

**Goal:** Don't just detect contradictions — resolve them.

- [x] Enhance `findContradictions` with merge/update/split suggestions
- [x] Add `wiki_resolve` tool for resolving contradictions
- [x] Implement merge logic: combine two pages, redirect old to new
- [x] Implement update logic: keep both pages but add explicit cross-references
- [x] Implement split logic: one page → two pages
- [x] Add contradiction resolution to LOG.md
- [x] Update lint to suggest resolution strategies

**Files changed:**
- `src/core/staleness.ts` — Enhanced contradiction detection
- `src/operations/lint.ts` — Enhanced lint with suggestions
- `src/operations/resolve.ts` — NEW: Resolution logic
- `src/index.ts` — Register `wiki_resolve` tool

### Phase 5: Enhanced Answer Filing & Structured Log

**Goal:** Queries compound into the wiki. LOG.md becomes a first-class timeline.

- [x] Enhance `wiki_query` to file richer answer pages
- [x] Generate structured LOG.md with `## [timestamp] type | title` prefixes
- [x] Add LOG.md querying capabilities
- [x] Add source attribution to every claim in wiki pages
- [ ] Update web UI to show LOG.md timeline view
- [x] Make LOG.md grep-friendly (consistent prefixes)

**Files changed:**
- `src/operations/query.ts` — Enhanced answer page generation
- `src/operations/ingest.ts` — Structured LOG.md appending
- `src/core/config.ts` — LOG.md format config
- `src/web/server.ts` — Timeline view

### Phase 6: Advanced Features

These are stretch goals that make the wiki truly general-purpose.

- [ ] **Image/asset handling** — Download and reference images in sources, allow LLM to view referenced images
- [ ] **Output format flexibility** — Generate Marp slide decks from wiki content
- [ ] **Dataview compatibility** — YAML frontmatter that Obsidian Dataview can query
- [ ] **Incremental page updates** — When ingesting a source that contradicts existing pages, update those pages (not just flag them)
- [x] **Source deduplication** — Detect when the same article has been ingested twice
- [ ] **Batch ingestion** — Ingest multiple sources at once with progress tracking
- [ ] **Wiki export** — Export entire wiki as static HTML site or PDF
- [ ] **Search upgrade** — Replace keyword search with BM25 + vector hybrid (optional, for large wikis)
- [x] **Git-based versioning** — Initialize wiki as a git repo for full history and branching

---

## Backward Compatibility

**v2 is backward compatible with v0.6.** All existing wikis continue to work:

1. **SCHEMA.md** — If no domain/source-types config, defaults to current codebase behavior
2. **Page types** — If no `PageTypeConfig` in schema, uses existing hardcoded types
3. **Source manifests** — Git ingests create source manifests automatically; old wikis without them work fine
4. **YAML frontmatter** — Written on new pages; old pages without frontmatter work fine (detected at read)
5. **LOG.md** — New structured format is additive; old format still renders
6. **SQLite** — New tables added via migration; existing data preserved
7. **CLI** — All existing commands work unchanged; new commands are additive

---

## Design Principles (Unchanged)

1. **Compiled knowledge, not re-derived** — The wiki is the artifact. Ingest once, maintain incrementally.
2. **The LLM writes, you read** — You curate sources and ask questions. The LLM does bookkeeping.
3. **Markdown is the format** — No lock-in. Works with Obsidian, VS Code, `cat`, anything.
4. **Immutable sources** — Raw sources are never modified. The wiki reads from them.
5. **Staleness is tracked, not ignored** — Every page knows its sources.
6. **Knowledge compounds** — Today's query becomes tomorrow's cross-reference.
7. **Minimal config, maximum convention** — `/wiki-init` gives you sane defaults.
8. **DRY / KISS / FP** — Small functions, validation, no globals, fixed allocations.

---

## New Design Principles (v2)

9. **Any source, any domain** — The wiki pattern works for code, research, books, personal knowledge, teams. Don't hardcode assumptions.
10. **Sources are first-class** — They live inside the wiki directory, are tracked with manifests, and are never modified.
11. **Contradictions get resolved, not just flagged** — Lint detects them, but the system also helps fix them.
12. **Confirm before create** — In guided mode, the user reviews proposed changes before they're written.
13. **LOG.md is the timeline** — A parseable, structured record of everything that happened and when.
14. **Frontmatter is metadata** — YAML frontmatter makes pages self-describing and queryable by external tools.

---

## Inspirations (Updated)

- **Karpathy's LLM Wiki** (April 2026) — The core pattern: persistent wiki > RAG retrieval
- **Obsidian** — Wiki-local markdown with backlinks, graph view, Dataview, frontmatter
- **Keep-a-Changelog** — Structured changelog format
- **pi-learn** — Memory infrastructure (SQLite store pattern, session hooks)
- **qmd** — Local search engine for markdown files (BM25 + vector + LLM reranking)
- **Zettelkasten** — The note-taking method: atomic notes, cross-references, no duplicates

---

*The wiki is just a git repo of markdown files. You get version history, branching, and collaboration for free. The LLM writes it. You read it. Knowledge compounds.* 📖🐉