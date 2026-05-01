# Implementation Plan — pi-codebase-wiki v2

> **Philosophy**: Codebase wiki is the primary use case. But every improvement that makes it general-purpose also makes the codebase wiki better. So we build for code first, but architect for any domain.

---

## Prioritization Logic

Things that improve the codebase wiki **and** enable other domains ship first. Things that only matter for other domains ship later.

**Ship if**: improves codebase wiki OR is needed to stop hardcoding code-specific assumptions
**Defer if**: only relevant for non-code domains with no codebase benefit

---

## Phase 0: Foundation Refactor (1-2 days)

> **Goal**: Remove hardcoded assumptions without breaking anything. Pure refactor — no new features.

The current code hardcodes `PageType` as a union type, page directories as constants, and assumes git is the only source. Phase 0 makes these configurable at the type level so later phases can plug in new values.

### Tasks

- [ ] **0.1**: Change `PageType` from a union type to `string`
  - File: `src/shared.ts`
  - Change: `type PageType = "entity" | "concept" | ...` → `type PageType = string`
  - Add: `DEFAULT_PAGE_TYPES: PageTypeConfig[]` constant with the current 6 types
  - Add: `PageTypeConfig` interface `{ id, name, directory, template, requiredSections }`
  - Backward compat: existing code uses `PageType` — all string values still work

- [ ] **0.2**: Replace `PAGE_TYPE_DIR` lookup with config-driven mapping
  - File: `src/shared.ts`, `src/operations/ingest.ts`, `src/operations/query.ts`, `src/core/config.ts`
  - Change: `PageTypeConfig.directory` replaces hardcoded `PAGE_TYPE_DIR`
  - `getDirectoryForType(type: string): string` — looks up from loaded config
  - Default config produces the same directories as current code

- [ ] **0.3**: Add YAML frontmatter parsing utilities
  - File: `src/core/frontmatter.ts` (NEW)
  - `parseFrontmatter(content: string): { metadata: Record<string, any>; body: string }`
  - `serializeFrontmatter(metadata: Record<string, any>, body: string): string`
  - `stripFrontmatter(content: string): string`
  - These are pure functions with no side effects — easy to test

- [ ] **0.4**: Add frontmatter to newly created pages (backward compatible)
  - Files: `src/operations/ingest.ts`, `src/index.ts` (entity/decision/concept tools)
  - When writing a new page, prepend YAML frontmatter
  - When reading a page, parse frontmatter if present (don't require it)
  - Old pages without frontmatter still work — detected at read, frontmatter added on next write

- [ ] **0.5**: Update `WikiConfig` to include `domain` and `pageTypes`
  - File: `src/shared.ts`, `src/core/config.ts`
  - Add: `domain: string` (default: `"codebase"`)
  - Add: `pageTypes: PageTypeConfig[]` (default: `DEFAULT_PAGE_TYPES`)
  - `DEFAULT_WIKI_CONFIG` picks these up
  - SCHEMA.md parsing reads domain + page types

### Acceptance Criteria

- All existing tests pass without modification
- New pages get YAML frontmatter; old pages without it still parse correctly
- `PageType` accepts any string value
- Page directories derived from config, not hardcoded
- No behavior changes from the user's perspective

---

## Phase 1: Source Management (2-3 days)

> **Goal**: Any content can be a source — not just git diffs. Sources are tracked, immutable, and queryable.

This is the biggest gap between current and LLM Wiki. Right now, "ingest" means "run git log and scan files." v2 means "take any content, file it, and update the wiki from it."

### Tasks

- [ ] **1.1**: Add `SourceManifest` type and SQLite table
  - File: `src/shared.ts`, `src/core/store.ts`
  - New table: `source_manifests` with columns: `id, type, title, path, hash, ingested_at, pages_created, metadata`
  - New method: `store.addSource(manifest)`, `store.getSources(type?)`, `store.getSource(id)`
  - Migration: `CREATE TABLE IF NOT EXISTS source_manifests (...)` in `runMigrations()`

- [ ] **1.2**: Create `.codebase-wiki/sources/` directory structure
  - File: `src/core/config.ts`
  - `ensureSourceDirs(rootDir, wikiDir)` — creates `sources/{git-commits,articles,notes,conversations,documents,urls}/`
  - Called during `initWiki()`

- [ ] **1.3**: Implement `wiki_ingest_source` tool
  - File: `src/operations/source.ts` (NEW), `src/index.ts`
  - Parameters: `type, title, content, url?, filePath?, metadata?, pageType?, updateExisting?`
  - Workflow:
    1. Generate UUID for the source
    2. Write content to `.codebase-wiki/sources/{type}/{uuid}.{ext}`
    3. Compute SHA-256 hash
    4. Create `SourceManifest` record in SQLite
    5. Send enrichment prompt to agent via `pi.sendUserMessage()` (like current `llm` ingest)
    6. Return manifest ID and path

- [ ] **1.4**: Implement `wiki_ingest_url` tool
  - File: `src/operations/source.ts`
  - Parameters: `url, title?`
  - Workflow:
    1. Fetch URL content (use `pi_web_fetch` or raw fetch)
    2. Extract readable text (strip HTML, keep markdown)
    3. Call `wiki_ingest_source` with `type: "url"`
    4. Store original URL in source manifest metadata

- [ ] **1.5**: Create git source manifests on existing ingest
  - File: `src/operations/ingest.ts`
  - When `ingestCommits` runs, create a source manifest for the batch
  - Type: `git-commits`, path references the commit range
  - Pages created/updated tracked in the manifest

- [ ] **1.6**: Add `wiki sources` command to CLI
  - File: `src/cli.ts`
  - `wiki sources` — list all sources with type, title, date
  - `wiki sources --type=article` — filter by type
  - Supports `--json` for machine-readable output

- [ ] **1.7**: Update `wiki_status` to show source counts
  - File: `src/index.ts`, `src/cli.ts`
  - Add source count by type to the status output

### Acceptance Criteria

- `wiki ingest-source --type=note --title="Meeting Notes" --content="..."` creates a source file, manifest entry, and triggers page creation
- `wiki ingest-url https://example.com/article` fetches, stores, and processes the article
- Git commit ingests create source manifests (backward compatible)
- `wiki sources` lists all ingested sources
- All existing tests still pass

---

## Phase 2: Structured LOG.md & Answer Filing (1 day)

> **Goal**: LOG.md becomes a parseable timeline. Query answers become first-class wiki pages with citations.

The current LOG.md is a markdown table that's hard to parse. The current query filing creates stub pages with match links. Both need to be richer.

### Tasks

- [ ] **2.1**: Refactor LOG.md to structured format
  - File: `src/operations/log.ts` (NEW, extracted from `ingest.ts`)
  - Format: `## [ISO-timestamp] type | title` — machine-parseable with `grep ^## \[`
  - Each entry includes: source reference, pages created/updated, contradictions detected
  - `appendToLog(wikiPath, entry: LogEntry)` replaces inline log writing
  - `parseLog(wikiPath): LogEntry[]` — read structured entries
  - `getRecentLog(wikiPath, count: number): LogEntry[]` — for status display

- [ ] **2.2**: Update all ingest operations to use structured log
  - Files: `src/operations/ingest.ts`, `src/index.ts`
  - `ingestCommits` → append structured log entry
  - `ingestFileTree` → append structured log entry
  - `ingestSource` → append structured log entry
  - `wiki_entity`, `wiki_decision`, `wiki_concept` tools → append log entries

- [ ] **2.3**: Enhance query answer filing
  - File: `src/operations/query.ts`, `src/index.ts`
  - Instead of a stub with match links, the filed page includes:
    - YAML frontmatter with source IDs
    - Synthesized answer (if agent provides one)
    - "Matched Pages" section with `[[wikilinks]]`
    - "Open Questions" section
    - Source attribution (`Sources: src-xxx, src-yyy`)
  - `wiki_query` tool gets `--file-answer` flag (default true)

- [ ] **2.4**: Make LOG.md parseable with unix tools
  - Ensure every entry starts with `## [` prefix
  - Add `wiki log` CLI command to query the log
  - `wiki log --last 5` — show last 5 entries
  - `wiki log --type ingest` — filter by type
  - `wiki log --since "2026-04-01"` — date filter

### Acceptance Criteria

- LOG.md entries follow `## [timestamp] type | title` format
- `grep "^## \[" .codebase-wiki/meta/LOG.md | tail -5` shows last 5 entries
- Query answers include frontmatter, citations, and open questions
- `wiki log --last 5` works from CLI
- Existing wikis with old LOG.md format still parse (fallback path)

---

## Phase 3: Domain Presets & Configurable Page Types (1-2 days)

> **Goal**: Initialize different wiki types. Page types come from config, not code.

This is where it becomes general-purpose. A `wiki init --domain=personal` creates a different wiki than `wiki init --domain=codebase`. But the codebase default stays unchanged.

### Tasks

- [ ] **3.1**: Define domain presets
  - File: `src/core/presets.ts` (NEW)
  - `DOMAIN_PRESETS: Record<string DomainPreset>` with:
    - `codebase` — current page types (entity, concept, decision, evolution, comparison, query)
    - `personal` — person, topic, insight, media, habit
    - `research` — paper, concept, finding, method, comparison
    - `book` — character, theme, chapter, location, quote
  - Each preset defines: page types, source types, SCHEMA.md template, templates

- [ ] **3.2**: Template generators per page type
  - File: `src/core/templates/` (NEW directory)
  - For each domain preset, create template functions:
    - `codebase/` — reuse existing `generateEntityTemplate()` etc.
    - `personal/` — person.md, topic.md, insight.md, media.md, habit.md
    - `research/` — paper.md, concept.md, finding.md, method.md
    - `book/` — character.md, theme.md, chapter.md, location.md, quote.md
  - Each template is a pure function `(name: string, meta: Record<string, any>) => string`

- [ ] **3.3**: Update `wiki init` with `--domain` flag
  - File: `src/core/config.ts`, `src/cli.ts`, `src/index.ts`
  - `wiki init --domain=codebase` (default) — current behavior
  - `wiki init --domain=personal` — creates personal knowledge wiki
  - Each preset generates appropriate: SCHEMA.md, templates, INDEX.md, directory structure
  - Store domain in SCHEMA.md header

- [ ] **3.4**: Parse page type config from SCHEMA.md
  - File: `src/core/config.ts`
  - `loadPageTypes(schemaPath: string): PageTypeConfig[]`
  - Reads `## Page Types` section from SCHEMA.md
  - Falls back to `DEFAULT_PAGE_TYPES` if section missing (backward compat)
  - `loadDomain(schemaPath: string): string` — reads domain from SCHEMA.md

- [ ] **3.5**: Wire page types through the system
  - Files: `src/operations/ingest.ts`, `src/operations/query.ts`, `src/operations/lint.ts`, `src/web/server.ts`
  - `WikiConfig.pageTypes` replaces all hardcoded type checks
  - `createEntityPage()` → `createPage(type, config, ...)` — generic page creation
  - Web UI reads page type config for display (icons, labels, sidebar sections)
  - Lint uses `requiredSections` from page type config

- [ ] **3.6**: Update pi extension for domain awareness
  - File: `src/index.ts`
  - `wiki_entity`, `wiki_concept`, `wiki_decision` tools → single `wiki_create_page` tool with `type` parameter
  - Keep old tools as aliases (backward compat)
  - Add `wiki_ingest_source` as a new first-class tool
  - Schema validation: reject unknown page types not in config

### Acceptance Criteria

- `wiki init --domain=codebase` produces identical output to current `wiki init`
- `wiki init --domain=personal` creates a wiki with person/topic/insight/habit directories and templates
- `wiki init --domain=book` creates a wiki with character/theme/chapter directories
- Existing codebase wikis work without any changes
- SCHEMA.md contains domain and page types
- Lint checks required sections per page type config

---

## Phase 4: Contradiction Resolution (1-2 days)

> **Goal**: Don't just detect contradictions — help fix them.

Current lint detects pages with >60% content overlap. v2 adds resolution strategies and a `wiki_resolve` tool.

### Tasks

- [ ] **4.1**: Enhance contradiction detection
  - File: `src/core/staleness.ts`
  - Current: Jaccard similarity on keyword sets
  - Add: overlap scoring that considers page types (same type → merge candidate, different type → cross-ref candidate)
  - Add: `suggestResolution(contradiction: ContradictionIssue): ResolutionStrategy`
  - Return structured `ContradictionIssue` with `pages`, `similarity`, `suggestion` ("merge" | "update" | "split")

- [ ] **4.2**: Implement `wiki_resolve` tool
  - File: `src/operations/resolve.ts` (NEW), `src/index.ts`
  - Parameters: `strategy, pageA, pageB, targetPage?`
  - Strategies:
    - `merge` — combine two pages into one, redirect the other
    - `update` — keep both, add explicit cross-reference and note the overlap
    - `split` — separate a merged page into two focused pages
  - For `merge`: concatenate content, deduplicate sections, update all cross-references
  - For `update`: add `> **Note**: This topic overlaps with [[other-page]]. See that page for details.`
  - For `split`: create two pages, distribute sections, add cross-references

- [ ] **4.3**: Add resolution to lint output
  - File: `src/operations/lint.ts`
  - `formatLintResult()` now includes suggestion for each contradiction
  - Contradiction section shows: pages, similarity %, suggested action
  - Web UI shows resolve button next to contradictions

- [ ] **4.4**: Add `wiki_resolve` CLI command
  - File: `src/cli.ts`
  - `wiki resolve merge auth-module oauth-flow --target auth-module`
  - `wiki resolve update event-bus pub-sub-pattern`
  - `wiki resolve split monolithic-page --into topic-a,topic-b`

### Acceptance Criteria

- `wiki_lint` reports contradictions with merge/update/split suggestions
- `wiki_resolve merge page-a page-b` merges two pages and redirects references
- `wiki_resolve update page-a page-b` adds cross-reference notes to both pages
- `wiki_resolve split page-a --into topic-a,topic-b` creates two pages from one
- Merged/split pages update cross-references in other pages that referenced them

---

## Phase 5: Human-in-the-Loop Ingestion (1-2 days)

> **Goal**: Users can review what the wiki will do before it does it. The "guided" mode from Karpathy's LLM Wiki pattern.

Current behavior: ingest creates pages immediately. v2 adds a confirmation step.

### Tasks

- [ ] **5.1**: Add ingestion mode config to SCHEMA.md
  - File: `src/core/config.ts`
  - Parse `ingestion.mode` from SCHEMA.md: `"auto"` (default), `"confirm"`, `"guided"`
  - Parse `ingestion.confirm_thresholds` (which actions need confirmation)
  - `loadIngestionConfig(schemaPath: string): IngestionWorkflow`

- [ ] **5.2**: Implement ingest proposal generation
  - File: `src/operations/proposal.ts` (NEW)
  - `generateIngestProposal(source: SourceManifest, store: WikiStore, config: WikiConfig): Proposal`
  - Proposal lists:
    - Pages to create (with suggested type and title)
    - Pages to update (with what will change)
    - Cross-references to add
    - Potential contradictions detected
  - Store proposal at `.codebase-wiki/meta/proposals/{id}.json`

- [ ] **5.3**: Implement confirm/guided mode in pi extension
  - File: `src/index.ts`
  - `auto` mode: current behavior — no changes
  - `confirm` mode: send proposal to agent, wait for approval
  - `guided` mode: discuss source with user before processing
  - The extension sends a message like:
    ```
    📖 Ingest Proposal for "Understanding OAuth 2.0"

    New pages to create:
    - [[oauth-flow]] (concept) — OAuth 2.0 auth flow
    - [[oauth-security]] (concept) — Security considerations

    Pages to update:
    - [[auth-module]] — Add OAuth section
    - [[security-concepts]] — Add reference

    Cross-references to add:
    - [[oauth-flow]] → [[auth-module]]

    Proceed? (yes / no / edit)
    ```

- [ ] **5.4**: Apply/reject proposals
  - File: `src/operations/proposal.ts`
  - `applyIngestProposal(proposalId: string): IngestResult`
  - `rejectIngestProposal(proposalId: string): void`
  - `modifyIngestProposal(proposalId: string, changes: Partial<Proposal>): Proposal`

### Acceptance Criteria

- `ingestion.mode: auto` — current behavior, no changes
- `ingestion.mode: confirm` — generates proposal, sends to agent for approval
- Ingest proposals show pages to create, update, and cross-references before writing
- Proposals stored in `.codebase-wiki/meta/proposals/`
- Proposals can be applied, modified, or rejected

---

## Phase 6: Polish & Stretch (ongoing)

> **Goal**: Quality of life improvements. Ship these as time permits.

These are valuable but not critical path. Each is independent.

### Tasks

- [ ] **6.1**: Incremental page updates
  - When a source contradicts an existing page, update the page (not just flag it stale)
  - Requires LLM integration — send the diff to the agent for reconciliation

- [ ] **6.2**: Source deduplication
  - Before ingesting, check SHA-256 hash against existing source manifests
  - Skip or update instead of creating duplicates

- [ ] **6.3**: Batch ingestion
  - `wiki ingest-source --batch sources.json` — multiple sources at once
  - Progress tracking, parallel page creation

- [ ] **6.4**: Web UI enhancements
  - Timeline view for LOG.md entries
  - Source browser (list, filter by type, view source content)
  - Proposal review UI (approve/reject pending proposals)
  - Page type icons from config

- [ ] **6.5**: Obsidian compatibility improvements
  - Bidirectional wikilinks (backlinks section auto-generated)
  - Dataview-compatible frontmatter queries
  - Graph view improvements (type-coded nodes)

- [ ] **6.6**: Search upgrade (optional)
  - Replace keyword search with BM25 + vector hybrid
  - Use qmd or similar local search engine
  - Keep keyword search as fallback

- [ ] **6.7**: Git-based versioning
  - Initialize wiki directory as a git repo
  - Auto-commit on ingest, lint, resolve
  - Branch for proposals (confirm mode)
  - Full history of every wiki change

---

## Timeline

| Phase | Duration | Dependencies | Ships |
|-------|----------|-------------|-------|
| **0: Foundation** | 1-2 days | None | Configurable types, frontmatter |
| **1: Sources** | 2-3 days | Phase 0 | Arbitrary source ingestion |
| **2: Log & Answers** | 1 day | Phase 0 | Structured log, rich answers |
| **3: Domains** | 1-2 days | Phase 0, 1 | Personal/research/book wikis |
| **4: Contradictions** | 1-2 days | Phase 0 | Resolve, not just detect |
| **5: Ingestion UX** | 1-2 days | Phase 1, 2 | Confirm/guided mode |
| **6: Polish** | Ongoing | Any | Quality of life |

**Total estimated: 7-12 days** for Phases 0-5.

---

## Testing Strategy

Each phase adds tests incrementally:

- **Phase 0**: Update existing unit tests for new types. Test frontmatter parse/serialize. Test config loading.
- **Phase 1**: Integration test for source ingestion. Test manifest creation, source file storage, hash verification.
- **Phase 2**: Test structured log format. Test `parseLog()` and `getRecentLog()`. Test query filing with frontmatter.
- **Phase 3**: Test domain presets generate correct directories and templates. Test that codebase default matches current behavior exactly.
- **Phase 4**: Test merge/update/split resolution. Test cross-reference updates after resolution.
- **Phase 5**: Test proposal generation, approval, rejection. Test that auto mode is unchanged.

Every phase ends with: **all existing tests pass + new tests for new features.**

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Frontmatter breaks existing wikis | Parse pages with and without frontmatter. Add frontmatter on next write, not on read. |
| Domain presets feel incomplete | Start with codebase (fully-featured) and personal (simplest). Others are community-contributed. |
| Source ingestion depends on LLM quality | Source filing (writing to `sources/`) is pure code. LLM enrichment is a separate step that can fail gracefully. |
| Human-in-the-loop slows down power users | Auto mode is default and unchanged. Confirm/guided are opt-in. |
| SQLite migration breaks existing DBs | Use `CREATE TABLE IF NOT EXISTS` for new tables. Never ALTER existing columns. |

---

## What This Enables (Beyond Codebases)

Once phases 0-3 ship:

- **Personal knowledge wiki**: `wiki init --domain=personal` → track goals, health, reading, insights
- **Research wiki**: `wiki init --domain=research` → accumulate papers, build thesis
- **Book wiki**: `wiki init --domain=book` → characters, themes, chapters, connections
- **Team wiki**: Custom domain with Slack/meeting transcript ingestion
- **Any domain**: Define your own page types in SCHEMA.md

The codebase wiki stays the default, stays first-class, and gets better (source tracking, structured logs, frontmatter, contradiction resolution) because these improvements benefit any wiki regardless of domain.