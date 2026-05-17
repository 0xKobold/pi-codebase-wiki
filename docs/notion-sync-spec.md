# Spec: Notion Sync for pi-codebase-wiki

> **Status**: Draft
> **Author**: Shalom 🐉
> **Date**: 2026-05-17

## Problem

The wiki generates rich pages — entities, concepts, ADRs, evolution traces — but they live in `.codebase-wiki/` markdown files and a SQLite DB. Non-developers (PMs, designers, stakeholders) can't access this knowledge. Notion is their habitat.

## Solution

A bidirectional bridge between pi-codebase-wiki and Notion that:

1. **Exports wiki pages → Notion** (primary direction, wiki is source of truth)
2. **Creates per-project databases** under a root page for organization
3. **Pulls Notion pages → wiki sources** (secondary direction, for team-written docs)

## Architecture

```
┌──────────────────────┐       ┌──────────────────────┐
│   .codebase-wiki/    │       │       Notion         │
│                      │       │                      │
│  entities/*.md  ─────┤──────►│  Wiki DB (per proj)  │
│  concepts/*.md  ─────┤──────►│    ├── Entities view  │
│  decisions/*.md ─────┤──────►│    ├── Decisions view │
│  evolution/*.md ─────│──────►│    └── Concepts view  │
│  comparisons/*.md    │       │                      │
│                      │       │  origen.db (global)   │
│  meta/wiki.db ───────┤──────►│    (optional target)  │
│                      │       │                      │
│  sources/ ◄──────────┤───────│  Notion pages        │
└──────────────────────┘       └──────────────────────┘
         │                              │
         │  wiki-sync.config.json       │
         │  (mapping, DB IDs, sync      │
         │   direction, schedule)        │
         └──────────────────────────────┘
```

## Per-Project Database Creation

**Yes — the tool CAN and WILL create a new Notion database per project.**

The Notion API supports `POST /v1/databases` with a `parent: { page_id }` body. Given a root page, the sync tool creates:

```
Root Page (2fb3e4ac-d0a7-8132-8ad7-dd2953b4ba08)
├── pi-codebase-wiki (database)
│   ├── Entity pages...
│   ├── Decision pages...
│   └── Concept pages...
├── federal-firehose (database)
│   └── ...
└── nimbus-agent (database)
    └── ...
```

### Flow

1. User provides `NOTION_ROOT_PAGE_ID` (or defaults to the existing root)
2. On first sync, check if a database named `<project-name> Wiki` exists under that page
3. If not, `POST /v1/databases` with:
   - `parent: { page_id: NOTION_ROOT_PAGE_ID }`
   - `title: [{ text: { content: "<project-name> Wiki" } }]`
   - `properties` schema (see mapping below)
4. Store the created `database_id` in `wiki-sync.config.json`
5. On subsequent syncs, use the stored `database_id`

### Database Schema (per-project)

| Property | Type | Description |
|----------|------|-------------|
| **Name** | `title` | Wiki page title |
| **Type** | `select` | Entity / Concept / Decision / Evolution / Comparison / Query |
| **Status** | `status` | Draft → Active → Stale → Archived |
| **Summary** | `rich_text` | First paragraph of the wiki page |
| **Source Files** | `rich_text` | Comma-separated source file paths |
| **Inbound Links** | `number` | Count of pages linking to this page |
| **Outbound Links** | `number` | Count of pages this page links to |
| **Stale** | `checkbox` | Whether the page needs re-ingestion |
| **Last Synced** | `date` | ISO timestamp of last sync |
| **Wiki Path** | `url` | Link back to the markdown file (if served via web UI) |
| **Tags** | `multi_select` | Extracted from metadata/frontmatter tags |
| **Priority** | `select` | Low / Medium / High / Critical (from metadata) |
| **Ingest Status** | `select` | Unprocessed / Ingested / Needs Review / Stale (computed from wiki data) |

### Kanban Color Configuration

Notion select/status properties support color assignment. The database creation sets meaningful colors:

```typescript
const STATUS_GROUPS = [
  { name: "Draft", color: "default" },
  { name: "Active", color: "green" },
  { name: "Stale", color: "yellow" },
  { name: "Archived", color: "gray" },
];

const PRIORITY_COLORS = [
  { name: "Critical", color: "red" },
  { name: "High", color: "orange" },
  { name: "Medium", color: "yellow" },
  { name: "Low", color: "gray" },
];

const INGEST_STATUS_COLORS = [
  { name: "Unprocessed", color: "default" },
  { name: "Ingested", color: "green" },
  { name: "Needs Review", color: "yellow" },
  { name: "Stale", color: "red" },
];
```

This makes Kanban columns color-coded in the UI without any manual configuration.

### ADR-Specific Properties (when Type = Decision)

| Property | Type | Description |
|----------|------|-------------|
| **ADR Status** | `select` | Proposed / Accepted / Deprecated / Superseded |
| **Decision** | `rich_text` | The decision made (from ADR body) |
| **Alternatives** | `rich_text` | Alternatives considered |

These are flat properties on the same database — Notion filters/views handle the per-type display.

### Kanban Board Views

Every Notion database with `status` or `select` properties automatically supports Board (Kanban) views. The schema above yields three zero-config Kanban boards:

#### 1. Page Lifecycle Board

Group by **Status** — shows every wiki page's health at a glance.

| Draft | Active | Stale | Archived |
|-------|--------|-------|----------|
| New pages from ingest | Verified, up-to-date | Source changed, needs re-ingestion | Removed from wiki |

Sort by **Priority** within each column so Critical items surface first.

**Use case:** A PM sees which pages are stale and need developer attention, without touching the CLI.

#### 2. ADR Pipeline Board

Filter `Type = Decision`, group by **ADR Status**.

| Proposed | Accepted | Deprecated | Superseded |
|----------|----------|------------|------------|
| New decisions under discussion | Finalized and active | No longer current | Replaced by newer ADR |

**Use case:** Track architectural decisions through their lifecycle. Teams vote on `Proposed` ADRs in Notion comments, then the owner promotes to `Accepted`.

#### 3. Ingestion Health Board

Group by **Ingest Status** — tracks whether the wiki's knowledge is fresh.

| Unprocessed | Ingested | Needs Review | Stale |
|-------------|----------|---------------|-------|
| Detected but not yet ingested | Page created from source | Manual verification needed | Source file changed since last ingest |

**Mapping from wiki data:**
```typescript
function mapIngestStatus(page: WikiPage): string {
  if (page.stale) return "Stale";
  if (page.inboundLinks === 0 && page.type !== "entity") return "Needs Review";
  if (page.lastIngested) return "Ingested";
  return "Unprocessed";
}
```

**Use case:** At a glance, see which areas of the codebase wiki need attention. Stale pages trigger re-ingest workflows.

## Config File: `wiki-sync.config.json`

Stored in `.codebase-wiki/meta/wiki-sync.config.json`:

```json
{
  "version": 1,
  "notion": {
    "rootPageId": "2fb3e4ac-d0a7-8132-8ad7-dd2953b4ba08",
    "databaseId": null,
    "databaseName": "pi-codebase-wiki Wiki",
    "syncDirection": "export",
    "conflictResolution": "wiki-wins"
  },
  "mapping": {
    "pageTypes": {
      "entity": { "notionIcon": "📦", "notionStatus": "Active" },
      "concept": { "notionIcon": "💡", "notionStatus": "Active" },
      "decision": { "notionIcon": "⚖️", "notionStatus": "Proposed" },
      "evolution": { "notionIcon": "📈", "notionStatus": "Active" },
      "comparison": { "notionIcon": "📊", "notionStatus": "Active" }
    },
    "fieldMapping": {
      "summary": "Summary",
      "sourceFiles": "Source Files",
      "stale": "Stale",
      "inboundLinks": "Inbound Links",
      "outboundLinks": "Outbound Links"
    }
  },
  "syncHistory": {
    "lastSyncAt": null,
    "lastSyncHash": null,
    "pagesSynced": 0,
    "pagesCreated": 0,
    "pagesUpdated": 0
  }
}
```

## Pi Tool API

### `wiki_notion_sync` — Export wiki pages to Notion

```
wiki_notion_sync
  ├── direction: "export" | "import" | "bidirectional"  (default: "export")
  ├── rootPageId?: string        (override root page)
  ├── databaseId?: string        (override target database)
  ├── createDb?: boolean          (default: true — create DB if not found)
  ├── pageTypes?: PageType[]     (filter which page types to sync)
  ├── force?: boolean             (re-sync even if unchanged)
  └── dryRun?: boolean            (preview without writing)
```

**Export flow:**
1. Load config, resolve database ID
2. If no database ID and `createDb=true`, create one under root page
3. Read all wiki pages from SQLite store
4. For each page:
   a. Search Notion DB for existing page with matching `Wiki Path`
   b. If found → update properties and block content
   c. If not found → create new page
5. Write markdown content as Notion blocks (headings, paragraphs, code, lists)
6. Update sync history in config

**Import flow (secondary, optional):**
1. Query Notion DB for pages with `Source = "Notion"` or matching tag
2. Pull content as markdown
3. Store as source in `.codebase-wiki/sources/notion/<page-id>.md`
4. Run `ingestSource()` with type `"notion"`
5. Cross-references created bi-directionally

### `wiki_notion_status` — Check sync status

Returns: last sync time, pages synced, pending changes, database ID, database URL.

## Content Mapping: Markdown → Notion Blocks

The wiki's markdown content needs to become Notion block objects:

| Markdown | Notion Block |
|----------|-------------|
| `# Heading` | `heading_1` |
| `## Heading` | `heading_2` |
| `### Heading` | `heading_3` |
| Plain paragraph | `paragraph` |
| `` `inline code` `` | `text.content` with `annotations: { code: true }` |
| ` ```lang ... ``` ` | `code` with `language` set |
| `- item` | `bulleted_list_item` |
| `1. item` | `numbered_list_item` |
| `> quote` | `quote` |
| `---` | `divider` |
| `\| table \|` | `table` with `table_row` |
| `[[wikilink]]` | `text.content` with `link: { url: relative_path }` |

Rich text has a 2000-char limit per block — long paragraphs need splitting.

## Staleness Handling

- Wiki pages marked `stale: true` → Notion `Status: Stale`
- Wiki pages with `stale: false` → Notion `Status: Active`
- ADR pages → Notion `ADR Status` mapped from frontmatter
- Deleted wiki pages → Notion pages archived (not deleted)

## Incremental Sync

Only sync pages that changed since last sync:

1. Store `lastSyncHash` for each page (SHA of content + properties)
2. On sync, compute hash for each page
3. Skip if hash matches
4. `force=true` overrides and re-syncs everything

## Error Handling

- Rate limiting: Notion API allows 3 req/s. Batch with 350ms delays.
- Property schema mismatches: If a wiki `PageType` has no matching Notion property, fall back to `rich_text` in a catch-all `Details` property
- 404 on database: Re-create if `createDb=true`, error otherwise
- 403 on root page: Clear error message about sharing the page with the integration

## Dependencies

- `@notionhq/client` — Official Notion SDK (MIT, zero runtime deps beyond `node-fetch`)
- No changes to existing wiki core — sync is a new `operations/notion-sync.ts` module

## File Structure

```
src/
├── core/
│   └── ... (unchanged)
├── operations/
│   ├── notion-sync.ts    ← NEW: sync logic
│   ├── notion-create.ts   ← NEW: database/page creation
│   ├── notion-mapping.ts  ← NEW: markdown ↔ Notion block conversion
│   └── ... (unchanged)
├── index.ts               ← register new tools/commands
└── shared.ts              ← add NotionConfig type (optional)
```

## Config in SCHEMA.md (optional extension)

```markdown
## Notion Sync

**Enabled**: true
**Root Page ID**: 2fb3e4ac-d0a7-8132-8ad7-dd2953b4ba08
**Database Name**: {{project}} Wiki
**Sync Direction**: export
**Conflict Resolution**: wiki-wins
```

This allows per-project configuration through the existing SCHEMA.md mechanism, with `ensureInitialized()` merging it into the config.

## MVP Scope

Phase 1 (what to build first):

- [x] `wiki_notion_sync` tool with `direction: "export"` only
- [x] Per-project database creation under root page
- [x] Page property mapping (Type, Status, Summary, Stale, Tags)
- [x] Markdown → Notion block conversion (headings, paragraphs, code, lists)
- [x] Incremental sync (hash-based change detection)
- [x] `wiki-sync.config.json` persistence
- [x] `dryRun` mode

Phase 2:

- [ ] Import direction (Notion → wiki sources)
- [ ] Bidirectional sync with conflict resolution
- [ ] Cross-reference sync (Notion pages link back to wiki via URLs)
- [ ] Webhook support (auto-sync on wiki changes)

Phase 3:

- [ ] Multiple Notion databases per page type
- [ ] Custom property mapping in SCHEMA.md
- [ ] Notion-to-wiki trigger (webhook when Notion pages change)
- [ ] Sync scheduling (periodic via pi hooks or cron)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync direction | Export-first | Wiki is git-controlled source of truth |
| Database strategy | Per-project under root | Clean separation, project-specific views |
| Content format | Notion blocks (not files) | Rich formatting, searchable, editable |
| Deleted pages | Archive in Notion | Prevent data loss, can be un-archived |
| Stale pages | Flag in Notion | Visibility for non-dev stakeholders |
| Config location | `.codebase-wiki/meta/` | Co-located with wiki data, git-ignored |
| ADR properties | Flat on same DB | Simpler schema, views handle per-type display |
| Kanban views | Zero-config from schema | Status/Priority/Ingest Status enable board views automatically |
| Ingest Status | Computed from wiki data | Derived staleness + link count, no manual input needed |