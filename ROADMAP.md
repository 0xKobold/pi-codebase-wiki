# pi-codebase-wiki v2 Roadmap — Remaining Stretch Goals

> All 6 core phases (0–5) plus Phase 6 core are **shipped and fully integrated** (v0.7.3).
> The items below are Phase 6 stretch goals — nice-to-haves that extend the wiki beyond its current scope.

---

## Priority: Medium

These would meaningfully improve the wiki for active users.

### Search Upgrade (BM25 + Vector Hybrid)

**Status**: Not started  
**Files**: `src/operations/query.ts`  
**Spec ref**: Phase 6 — "Search upgrade"

Current keyword search works fine for small wikis (<100 pages). For larger wikis, BM25 + vector hybrid search would improve relevance and enable semantic queries ("how does authentication work?" → finds `auth-module` even without keyword match).

**Implementation approach**:
- Add optional `searchMode: "keyword" | "bm25" | "hybrid"` to `WikiConfig`
- Keep keyword as default (zero dependencies)
- BM25: pure TS implementation (no native deps) — rank by TF-IDF
- Vector: embed pages using `pi.sendUserMessage()` to an embedding model, store in SQLite vec
- Hybrid: combine BM25 + vector scores with configurable weights

**Estimated**: 3-4 days

---

### Batch Ingestion

**Status**: Not started  
**Files**: `src/operations/source.ts`, `src/cli.ts`  
**Spec ref**: Phase 6 — "Batch ingestion"

Allow ingesting multiple sources at once with a progress indicator.

```bash
wiki ingest-sources --from-dir ./articles/  # ingest all files in a directory
wiki ingest-urls --from-file urls.txt       # fetch and ingest multiple URLs
```

**Implementation approach**:
- Add `ingestBatch(sources[])` — iterates sources, calls `ingestSource()` for each
- Progress tracking via event emitter or callback
- Error tolerance: continue on individual source failure, report at end
- CLI flags: `--from-dir`, `--from-file`, `--continue-on-error`

**Estimated**: 1-2 days

---

### Incremental Page Updates from Source Ingestion

**Status**: Partial (contradictions detected but not auto-resolved)  
**Files**: `src/operations/source.ts`, `src/operations/resolve.ts`  
**Spec ref**: Phase 6 — "Incremental page updates"

When ingesting a source that contradicts existing pages, the system should update those pages rather than just flagging the contradiction.

**Current behavior**: `wiki_ingest_source` creates new pages. `wiki_lint` detects contradictions. User must run `wiki_resolve` manually.

**Desired behavior**: After ingestion, auto-detect high-overlap pages and either:
- In `auto` mode: apply the suggested resolution (merge/update/split)
- In `confirm` mode: generate a proposal for the resolution
- In `guided` mode: present each conflict to the user

**Implementation approach**:
- After `ingestSource()`, run `findContradictionsDetailed()` on affected pages
- If mode is `auto` and overlap > threshold, apply `suggestResolution()` result
- If mode is `confirm`, create a proposal with the resolution actions
- Log to structured LOG.md either way

**Estimated**: 2-3 days

---

## Priority: Low

These extend the wiki beyond its core use case. Good contributions for the community.

### Web UI Enhancements

**Status**: Not started  
**Files**: `src/web/server.ts`, `src/web/template.ts`, `src/web/ui.html`  
**Spec ref**: Phase 6 — "Web UI timeline view", Phase 2 — "Timeline view"

The web UI currently shows a page browser, graph, and search. Missing:
- **LOG.md timeline view** — scrollable list of ingest/query/lint operations
- **Page type icons** — show emoji from `PageTypeConfig.icon` in the page list and graph
- **Proposal review UI** — approve/reject proposals from the browser
- **Wiki git history** — show recent commits with diff links

**Estimated**: 3-4 days

---

### Image/Asset Handling

**Status**: Not started (infrastructure exists — `media` SourceType, `media/` directory)  
**Files**: `src/operations/source.ts`, `src/core/config.ts`  
**Spec ref**: Phase 6 — "Image/asset handling"

Allow binary files as sources — images, diagrams, video transcripts. The LLM can't read images directly, but it can:
- Store the binary file in `sources/media/`
- Read an accompanying transcript or description
- Reference the image in wiki pages with `![[image-name.png]]`

**Implementation approach**:
- Accept `filePath` in `ingestSource` pointing to a binary file
- Copy to `sources/media/` with manifest
- If the file is an image, extract any EXIF metadata
- Accept an optional `description` parameter for the image
- Generate wiki pages referencing the media

**Estimated**: 1-2 days

---

### Wiki Export (HTML/PDF)

**Status**: Not started  
**Files**: New `src/operations/export.ts`  
**Spec ref**: Phase 6 — "Wiki export"

Export the entire wiki as a static HTML site or PDF for sharing.

```bash
wiki export --format=html --output=./wiki-site/
wiki export --format=pdf --output=wiki.pdf
```

**Implementation approach**:
- HTML: iterate all pages, render markdown to HTML, generate index with links
- PDF: use a markdown-to-PDF library (e.g., `md-to-pdf`) or an HTML-to-PDF approach
- Include frontmatter metadata in the output
- Cross-references become clickable links in HTML

**Estimated**: 2-3 days

---

### Marp Slide Deck Generation

**Status**: Not started  
**Files**: New `src/operations/slides.ts`  
**Spec ref**: Phase 6 — "Output format flexibility"

Generate presentation slides from wiki content using Marp format.

```bash
wiki slides --from=concept/oauth-flow --output=slides.md
wiki slides --from=all-decisions --output=decisions.md
```

**Implementation approach**:
- Select pages by type or query
- Extract key sections (Summary, Key Ideas, Conclusions)
- Wrap in Marp frontmatter with `---` slide separators
- Optional: generate a table of contents slide

**Estimated**: 1-2 days

---

## Won't Implement (Deferred Indefinitely)

These appeared in the spec but don't justify the maintenance cost.

### Dataview-specific Query Support

**Status**: ✅ Done via frontmatter — all pages now have YAML frontmatter  
**Note**: No Dataview-specific plugin code needed. Frontmatter is queryable by any Dataview installation.

---

## Contributing

Any of these items are great first contributions. Check the [SPEC-v2.md](./SPEC-v2.md) for architectural context and the [PLAN.md](./PLAN.md) for implementation patterns.

The core principle: **every feature must work for codebase wikis first**. If a feature only helps non-code domains, it goes lower priority.

---

*Last updated: 2026-05-04 (v0.7.3)*