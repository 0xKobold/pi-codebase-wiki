# pi-codebase-wiki — Specification

> **Keeps a wiki for your code that updates itself.** Reads your git history and docs so you can ask questions about your codebase — knowledge compiled once, kept current, never re-derived.

---

## The Problem

Every project has knowledge that **decays**:

- **Commit messages** tell a story, but that story dies in `git log`. Nobody reads 500 commits to understand why an architecture changed.
- **README files** go stale. `docs/` folders rot. ADRs (Architecture Decision Records) are aspirational — everyone intends to write them, almost nobody does.
- **RAG over code** re-derives knowledge from scratch on every query. No accumulation, no cross-references, no contradiction detection.

The result: teams and solo devs repeatedly ask the same questions, re-discover the same context, and never build compounding understanding of their own codebase.

## The Insight

Karpathy's LLM Wiki pattern (April 2026) proved something:

> **Knowledge compiled once and kept current beats knowledge re-derived on every query.**

Instead of RAG — retrieve chunks, synthesize from scratch, discard — you build a **persistent, compounding wiki** that the LLM writes and maintains. The human curates; the LLM does the grunt work.

**pi-codebase-wiki applies this pattern to software projects.** Your codebase and commit history become the "raw sources." The LLM incrementally compiles them into a living documentation wiki that stays current as code changes.

---

## Three-Layer Architecture

```
┌─────────────────────────────────────────┐
│  Layer 1: Raw Sources (IMMUTABLE)      │
│  ─ git log, source files, README,      │
│    configs, ADR templates               │
│  ─ Never modified by the wiki           │
├─────────────────────────────────────────┤
│  Layer 2: The Wiki (LLM-OWNED)          │
│  ─ .codebase-wiki/                      │
│  ─ Entity pages, architecture docs,     │
│    changelogs, ADRs, concept pages      │
│  ─ Cross-referenced, indexed, dated     │
│  ─ The LLM writes it. You read it.       │
├─────────────────────────────────────────┤
│  Layer 3: Schema (CO-EVOLVING)          │
│  ─ .codebase-wiki/SCHEMA.md             │
│  ─ Tells the LLM how to structure       │
│    pages, naming, workflows              │
│  ─ You and the LLM evolve it together   │
└─────────────────────────────────────────┘
```

### Layer 1: Raw Sources

The codebase itself. Git history. Configs. The wiki reads from these but never modifies them.

| Source | Format | How Ingested |
|--------|--------|-------------|
| Git commits | `git log --format` | Periodic or on-demand ingest |
| Source files | `.ts`, `.js`, `.py`, etc. | File watcher + on-demand |
| README / docs | `.md` files | On-demand, project detection |
| Configs | `package.json`, `tsconfig.json`, etc. | On project detection |
| ADR templates | `.codebase-wiki/templates/` | When creating new ADRs |

### Layer 2: The Wiki

A directory of LLM-generated markdown files. The wiki is the **compiled artifact** — knowledge processed once and maintained incrementally.

```
.codebase-wiki/
├── SCHEMA.md                    # Layer 3: the constitution
├── INDEX.md                     # Master index with links to all pages
├── CHANGELOG.md                 # Auto-generated from commits
├── entities/                    # Code entity pages
│   ├── auth-module.md
│   ├── event-bus.md
│   ├── pi-learn.md
│   └── skill-system.md
├── concepts/                    # Concept pages (cross-cutting)
│   ├── extension-architecture.md
│   ├── risk-based-approval.md
│   ├── hot-reload-pattern.md
│   └── multi-agent-orchestration.md
├── decisions/                   # ADRs
│   ├── 001-sqlite-over-leveldb.md
│   ├── 002-event-bus-decoupling.md
│   └── 003-hot-reload-skills.md
├── evolution/                   # How things changed over time
│   ├── auth-evolution.md
│   ├── api-v1-to-v2.md
│   └── config-format-history.md
├── comparisons/                 # Side-by-side analysis
│   ├── pi-learn-vs-generative-agents.md
│   └── sqlite-vs-leveldb.md
├── templates/                   # Page templates
│   ├── entity.md
│   ├── concept.md
│   ├── decision.md
│   └── evolution.md
└── meta/
    ├── LOG.md                    # Ingest log (what was processed when)
    └── STATS.md                  # Wiki health stats
```

### Layer 3: Schema (SCHEMA.md)

The configuration file that tells the LLM how to be a disciplined wiki maintainer. Defines:
- Page naming conventions (kebab-case, `.md` suffix)
- Required sections per page type (Summary, Context, Details, Cross-references)
- Ingest/update/lint workflows
- What triggers updates (new commits, file changes, manual `/wiki-ingest`)
- Cross-referencing rules (`See also` sections, wikilinks)

---

## Core Operations

### 1. Ingest

**Trigger:** New commits, file changes, or manual `/wiki-ingest`.

The LLM reads the raw source, extracts key information, and integrates it into the wiki:

1. **Read source** — parse commit diff, read changed files
2. **Discuss** — (optional, in interactive mode) confirm understanding with user
3. **Write summary page** — create or update entity/concept pages
4. **Update INDEX.md** — add or update entries
5. **Update cross-references** — modify related pages that now need a link
6. **Append to LOG.md** — record what was ingested, when, and what changed

A single commit might touch 5-10 wiki pages (the entity itself, related entities, changelog, index, evolution pages).

#### Ingest Sources

| Source | Command | What's Extracted |
|--------|---------|-----------------|
| Git commits (recent N) | `git log --since="last ingest"` | Changed entities, intent, relationships |
| Full git log | `git log --all` | Evolution timeline, decision history |
| File tree | `find src/ -type f` | Module structure, dependencies |
| Package config | `package.json`, `tsconfig.json` | Dependencies, project type |
| Existing docs | `README.md`, `docs/**/*.md` | Architecture summaries |
| Diff analysis | `git diff HEAD~N` | Change patterns, refactoring intent |

### 2. Query

**Trigger:** User asks a question about the codebase.

The LLM searches the wiki (not the raw source), reads relevant pages, and synthesizes an answer:

- Good answers get **filed back as new wiki pages** (comparisons, analyses, discovered connections)
- Knowledge compounds: today's query becomes tomorrow's cross-reference

Example queries the wiki handles well:
- "Why did we switch from LevelDB to SQLite?"
- "How does the skill system's hot-reload work?"
- "What changed in auth between v1 and v2?"
- "Which modules depend on the event bus?"
- "Give me a summary of what happened in the last sprint"

### 3. Lint

**Trigger:** Manual `/wiki-lint` or periodic health check.

The LLM scans the entire wiki for problems:

| Check | What It Finds |
|-------|--------------|
| Contradictions | Pages that claim conflicting facts |
| Orphans | Pages with no inbound links |
| Staleness | Pages whose raw sources have changed since last update |
| Missing concepts | Things mentioned in code but without their own page |
| Broken links | Wikilinks pointing to non-existent pages |
| Duplication | Topics covered in multiple pages that should be merged |

---

## Page Templates

### Entity Page (entities/*.md)

```markdown
# {Entity Name}

> **Summary**: One-paragraph description of what this is and what it does.

## Location
- **Path**: `src/path/to/module/`
- **Type**: module | service | util | config | type

## Responsibilities
- What this entity is responsible for

## Dependencies
- [[other-entity]] — why it depends on it

## Dependents
- [[consumer-entity]] — what depends on this

## Key Files
- `file1.ts` — what it does
- `file2.ts` — what it does

## Design Decisions
- Why it works this way (from commits, ADRs, conversations)

## Evolution
- **v0.1** — Initial creation ([commit abc123])
- **v0.3** — Major refactor ([commit def456])

## See Also
- [[related-concept]]
- [[related-decision]]
```

### Decision Page (decisions/*.md)

```markdown
# ADR-{N}: {Title}

> **Status**: Proposed | Accepted | Deprecated | Superseded by [[ADR-{M}]]

## Context
What is the issue that we're seeing that is motivating this decision?

## Decision
What is the change that we're proposing/making?

## Consequences
What becomes easier or harder to do because of this change?

## Alternatives Considered
- Option A: ...
- Option B: ...

## References
- Commit: [abc123](link)
- Discussion: ...
```

### Evolution Page (evolution/*.md)

```markdown
# Evolution of {Feature}

> **Summary**: How this feature changed over time.

## Timeline

### {Date or Version} — {Event}
What changed and why. Link to commits and ADRs.

### {Date or Version} — {Event}
...

## Current State
Where things stand now.

## Lessons Learned
Patterns, anti-patterns, and takeaways from the evolution.
```

---

## pi Extension Design

### Package: `packages/pi-codebase-wiki/`

```
pi-codebase-wiki/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Extension entry point
│   ├── core/
│   │   ├── store.ts             # SQLite for wiki metadata
│   │   ├── git.ts               # Git operations (log, diff, blame)
│   │   ├── indexer.ts           # File tree indexing
│   │   ├── staleness.ts         # Staleness detection
│   │   └── config.ts            # Configuration loading
│   ├── operations/
│   │   ├── ingest.ts            # Ingest pipeline
│   │   ├── query.ts             # Query pipeline
│   │   └── lint.ts              # Lint pipeline
│   ├── templates/
│   │   ├── entity.ts            # Entity page template
│   │   ├── concept.ts           # Concept page template
│   │   ├── decision.ts          # ADR page template
│   │   └── evolution.ts         # Evolution page template
│   ├── renderers.ts             # TUI components
│   └── shared.ts                # Shared types and utils
├── skills/
│   └── codebase-wiki/
│       └── SKILL.md             # Skill definition
└── .codebase-wiki/              # Default wiki (created on init)
    ├── SCHEMA.md
    └── templates/
        ├── entity.md
        ├── concept.md
        ├── decision.md
        └── evolution.md
```

### Tools Registered

| Tool | Description | Risk |
|------|-------------|------|
| `wiki_ingest` | Ingest git commits, files, or docs into the wiki | medium |
| `wiki_query` | Search the wiki and synthesize an answer | safe |
| `wiki_lint` | Health-check the wiki for issues | safe |
| `wiki_status` | Show wiki stats, staleness, coverage | safe |
| `wiki_entity` | Create or update an entity page | medium |
| `wiki_decision` | Create or update an ADR | medium |
| `wiki_changelog` | Generate changelog from recent commits | safe |
| `wiki_evolve` | Trace how a feature changed over time | safe |

### Commands Registered

| Command | Description |
|---------|-------------|
| `/wiki` | Show wiki status and INDEX.md |
| `/wiki-ingest [source]` | Ingest a source (commits, file, docs, or "all") |
| `/wiki-query <question>` | Ask a question against the wiki |
| `/wiki-lint` | Run health checks |
| `/wiki-init` | Initialize the wiki for the current project |
| `/wiki-entity <name>` | Open/view an entity page |
| `/wiki-decision <title>` | Create an ADR |
| `/wiki-changelog [range]` | Generate changelog |
| `/wiki-evolve <feature>` | Trace feature evolution |
| `/wiki-reindex` | Rebuild the wiki index |

### Events Subscribed

| Event | Action |
|-------|--------|
| `session_start` | Detect project, check staleness, notify if wiki needs update |
| `tool_call` (write/edit) | Track file mutations for stale page detection |
| `before_agent_start` | Inject wiki context into system prompt |

### Wiki Context Injection

On `before_agent_start`, if a wiki exists for the current project, the extension injects a summary into the system prompt:

```
## Codebase Wiki

This project has an auto-maintained codebase wiki at .codebase-wiki/.
Key entities: auth-module, event-bus, skill-system, pi-learn
Recent changes: feat(auth): add OAuth (2 hours ago), fix(learn): mem leak (1 day ago)
Staleness: 3 pages need update, last lint: 2 days ago

Use wiki_query to search the wiki, or wiki_ingest to update it.
```

This gives the LLM **immediate awareness** of the project's knowledge base without consuming much context.

---

## Staleness Detection

The key insight: **wiki pages go stale when their source files change.**

```typescript
interface StalenessCheck {
  pagePath: string;           // .codebase-wiki/entities/auth-module.md
  lastUpdated: number;        // timestamp from page metadata
  sourceFiles: string[];      // files this page is derived from
  sourceMtimes: number[];    // mtimes of source files
  stale: boolean;             // any source mtime > lastUpdated
  stalenessScore: number;    // 0-1, how stale
}
```

When a file changes, we check which wiki pages reference it and flag them for re-ingest. This is the **compounding** part — the wiki knows what it knows and what it doesn't know anymore.

---

## Git Integration

### Commit Ingest Strategy

Not every commit deserves a wiki update. The extension is smart about **batching**:

```typescript
interface IngestConfig {
  // Minimum commits to batch before an ingest
  minBatchSize: number;       // default: 3
  // Maximum age of commits to consider "recent"
  recentCommitAge: string;    // default: "7 days"
  // Commit types that always trigger ingest
  importantTypes: string[];    // default: ["feat", "fix", "refactor", "breaking"]
  // Patterns to ignore
  ignorePatterns: string[];    // default: ["chore: update deps", "docs: typos"]
}
```

### Commit → Wiki Mapping

| Commit Pattern | Wiki Action |
|---------------|-------------|
| `feat(X): add Y` | Create/update entity page for X, update INDEX |
| `fix(X): fix Z` | Update entity page for X, add to evolution |
| `refactor(X):` | Update entity page, create evolution entry |
| `breaking change` | Create ADR, update all affected entity pages |
| Multiple files changed | Detect cross-cutting concern, suggest concept page |
| Merge/rebase | Skip (noise) |

### Changelog Generation

Auto-generates `CHANGELOG.md` from commits, organized by:

```markdown
# Changelog

## [Unreleased]
### Added
- OAuth login for auth module ([abc123])

### Changed
- Refactored event bus to support async handlers ([def456])

### Fixed
- Memory leak in pi-learn dream cycle ([ghi789])

## [0.5.0] - 2026-03-11
...
```

---

## SQLite Metadata Store

The wiki needs a database to track metadata (not the wiki content itself — that's markdown files):

```sql
CREATE TABLE wiki_pages (
  id TEXT PRIMARY KEY,           -- slug: "auth-module"
  path TEXT NOT NULL,             -- ".codebase-wiki/entities/auth-module.md"
  type TEXT NOT NULL,             -- "entity" | "concept" | "decision" | "evolution" | "comparison"
  title TEXT NOT NULL,
  summary TEXT,                    -- first paragraph
  source_files TEXT,              -- JSON array of source file paths
  source_commits TEXT,            -- JSON array of commit hashes
  last_ingested TEXT,             -- ISO timestamp
  last_checked TEXT,              -- ISO timestamp for staleness
  inbound_links INTEGER DEFAULT 0,
  outbound_links INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0
);

CREATE TABLE ingest_log (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,      -- "commit" | "file" | "docs" | "manual"
  source_ref TEXT NOT NULL,       -- commit hash, file path, or description
  pages_created INTEGER DEFAULT 0,
  pages_updated INTEGER DEFAULT 0,
  timestamp TEXT NOT NULL
);

CREATE TABLE cross_references (
  from_page TEXT NOT NULL,
  to_page TEXT NOT NULL,
  context TEXT,                   -- why this link exists
  PRIMARY KEY (from_page, to_page)
);

CREATE TABLE staleness_checks (
  page_id TEXT PRIMARY KEY REFERENCES wiki_pages(id),
  check_time TEXT NOT NULL,
  stale_files TEXT,               -- JSON array of files that changed since last ingest
  staleness_score REAL DEFAULT 0
);
```

---

## Configuration

### `.codebase-wiki/SCHEMA.md`

This is the constitution. The LLM reads it on every operation to understand how to maintain the wiki. Sane defaults are generated on `/wiki-init`.

Key schema directives:

```yaml
# Naming
slug_format: kebab-case           # File names must be kebab-case
link_format: "[[slug]]"          # Wikilinks use double brackets

# Page Structure
require_summary: true             # Every page starts with a summary paragraph
require_see_also: true            # Every page ends with cross-references

# Ingest
auto_ingest_on_commit: false      # Manual by default (use /wiki-ingest)
batch_size: 3                     # Minimum commits per batch
recent_window: "7d"               # What counts as "recent"

# Lint
check_staleness: true             # Flag pages whose sources changed
check_orphans: true               # Flag pages with no inbound links
check_contradictions: true        # Flag factual contradictions
check_missing: true               # Suggest pages for unmentioned concepts

# Scope
include_patterns: ["src/**", "lib/**", "packages/*/src/**"]
exclude_patterns: ["node_modules", "dist", ".git", "coverage"]
```

### Extension Config (pi settings)

```json
{
  "codebase-wiki": {
    "autoIngest": false,
    "ingestOnStart": false,
    "stalenessCheckInterval": "1h",
    "maxContextPages": 5,
    "commitBatchSize": 3,
    "importantCommitTypes": ["feat", "fix", "refactor", "breaking"],
    "excludeCommitPatterns": ["chore: update deps", "docs: typos"]
  }
}
```

---

## Comparison: pi-codebase-wiki vs Alternatives

| Feature | pi-codebase-wiki | RAG over code | Manual docs | ADR-only |
|---------|-----------------|---------------|-------------|----------|
| Knowledge compounds | ✅ Persistent wiki | ❌ Re-derived each query | ✅ But manual | ⚠️ Decisions only |
| Auto-maintained | ✅ LLM writes | ✅ Auto-indexed | ❌ Manual | ❌ Manual |
| Cross-references | ✅ Wikilinks | ❌ No cross-refs | ⚠️ Manual | ❌ Standalone |
| Staleness detection | ✅ Source mtime tracking | ❌ No concept | ❌ Hope | ❌ Hope |
| Evolution tracking | ✅ Timeline pages | ❌ No history | ⚠️ Manual changelogs | ❌ Point-in-time |
| Contradiction detection | ✅ Lint operation | ❌ No awareness | ❌ Hope | ❌ Hope |
| Commit integration | ✅ Auto-ingest | ⚠️ Can search | ❌ Manual | ⚠️ Referenced |
| Works offline | ✅ Local markdown + SQLite | ⚠️ Needs embeddings | ✅ Yes | ✅ Yes |
| Setup cost | `/wiki-init` | Vector DB + embed pipeline | High | Medium |

---

## Implementation Phases

### Phase 1: Foundation (MVP)
**Goal:** Ingest git commits and generate entity pages.

- [ ] `/wiki-init` command — create `.codebase-wiki/` with SCHEMA.md and templates
- [ ] `wiki_ingest` tool — parse git log, create entity pages
- [ ] `wiki_status` tool — show wiki stats
- [ ] `wiki_query` tool — search and read pages
- [ ] INDEX.md generator
- [ ] SQLite metadata store (pages, cross-references, ingest log)
- [ ] Basic staleness detection (file mtime > page mtime)

### Phase 2: Intelligence
**Goal:** Smart ingest, evolution tracking, ADRs.

- [ ] Smart commit batching (important types, ignore noise)
- [ ] Evolution pages (`/wiki-evolve <feature>`)
- [ ] ADR generation (`/wiki-decision <title>`)
- [ ] Cross-reference maintenance (update related pages on ingest)
- [ ] Changelog generation from commits
- [ ] `before_agent_start` wiki context injection

### Phase 3: Lint & Health
**Goal:** Self-healing wiki.

- [ ] `wiki_lint` — contradictions, orphans, stale pages, broken links
- [ ] Auto-suggest missing pages for concepts mentioned but not documented
- [ ] Staleness scoring with graduated urgency
- [ ] Periodic health checks (optional background)
- [ ] Duplicate detection and merge suggestions

### Phase 4: Integration
**Goal:** Works with the pi ecosystem.

- [ ] pi-learn bridge — feed wiki insights into memory conclusions
- [ ] pi-obsidian-bridge — open wiki as Obsidian vault for browsing
- [ ] pi-gateway — expose wiki status to multi-agent orchestration
- [ ] Git hook integration — auto-flag stale pages on commit
- [ ] Graph view API — generate graph data for visualization

---

## Naming & Identity

- **Package:** `@0xkobold/pi-codebase-wiki`
- **CLI:** `pi-codebase-wiki`
- **Directory:** `packages/pi-codebase-wiki/`
- **Wiki dir:** `.codebase-wiki/` (project-local, gitignored by default)
- **Emoji:** 📖 (for commands/notifications)

---

## Design Principles

1. **Compiled knowledge, not re-derived** — The wiki is the artifact. Ingest once, maintain incrementally.
2. **The LLM writes, you read** — You curate sources and ask questions. The LLM does bookkeeping.
3. **Markdown is the format** — No lock-in. Works with Obsidian, VS Code, `cat`, anything.
4. **Git is the source of truth** — Commits are the primary raw source. File tree is secondary.
5. **Staleness is tracked, not ignored** — Every page knows its sources and can tell you when it's out of date.
6. **Knowledge compounds** — Today's query becomes tomorrow's cross-reference. Good answers get filed as pages.
7. **Minimal config, maximum convention** — `/wiki-init` gives you sane defaults. The SCHEMA.md evolves with you.
8. **DRY / KISS / FP** — Follows 0xKobold programming philosophy. Single source of truth, simple functions, no globals.

---

## Inspirations

- **Karpathy's LLM Wiki** (April 2026) — The core pattern: persistent wiki > RAG retrieval
- **ADR (Architecture Decision Records)** — The decision page format
- **Obsidian** — Wiki-local markdown with backlinks and graph view
- **Keep-a-Changelog** — Structured changelog format
- **DeepWiki** — Auto-generated code documentation from repos
- **pi-learn** — Memory infrastructure (this project borrows its SQLite store pattern)

---

*Built on the insight that knowledge should compound, not evaporate. 📖🐉*