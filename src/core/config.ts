/**
 * Configuration Module
 *
 * Loads and validates wiki configuration from .codebase-wiki/SCHEMA.md
 * and pi settings. Follows NASA-10: validation, no globals, pure functions.
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiConfig, IngestConfig, PageTypeConfig } from "../shared.js";
import { DEFAULT_WIKI_DIR, DEFAULT_WIKI_CONFIG, DEFAULT_INGEST_CONFIG, DEFAULT_PAGE_TYPES, getDirectoryForPageType } from "../shared.js";

// ============================================================================
// CONFIG LOADING
// ============================================================================

/**
 * Load wiki configuration from pi settings or defaults
 */
export function loadConfig(overrides?: Partial<WikiConfig>): WikiConfig {
  console.assert(overrides === undefined || overrides !== null, "overrides must be object or undefined");

  return {
    ...DEFAULT_WIKI_CONFIG,
    ...overrides,
  };
}

/**
 * Load ingest configuration with overrides
 */
export function loadIngestConfig(overrides?: Partial<IngestConfig>): IngestConfig {
  console.assert(overrides === undefined || overrides !== null, "overrides must be object or undefined");

  return {
    ...DEFAULT_INGEST_CONFIG,
    ...overrides,
  };
}

// ============================================================================
// WIKI DIRECTORY MANAGEMENT
// ============================================================================

/**
 * Check if a wiki exists at the given root
 */
export function wikiExists(rootDir: string, wikiDir: string = DEFAULT_WIKI_DIR): boolean {
  const wikiPath = path.join(rootDir, wikiDir);
  return fs.existsSync(path.join(wikiPath, "SCHEMA.md"));
}

/**
 * Get the wiki directory path
 */
export function getWikiPath(rootDir: string, wikiDir: string = DEFAULT_WIKI_DIR): string {
  return path.join(rootDir, wikiDir);
}

/**
 * Ensure wiki directory structure exists
 */
export function ensureWikiDirs(rootDir: string, wikiDir: string = DEFAULT_WIKI_DIR, pageTypes?: PageTypeConfig[]): string {
  const wikiPath = getWikiPath(rootDir, wikiDir);
  const types = pageTypes ?? DEFAULT_PAGE_TYPES;

  const dirs = [
    wikiPath,
    path.join(wikiPath, "meta"),
    path.join(wikiPath, "templates"),
  ];

  // Add directories for each page type (skip empty directories for index/schema/changelog)
  for (const pt of types) {
    if (pt.directory) {
      dirs.push(path.join(wikiPath, pt.directory));
    }
  }

  // Add sources directory structure
  dirs.push(
    path.join(wikiPath, "sources", "git-commits"),
    path.join(wikiPath, "sources", "articles"),
    path.join(wikiPath, "sources", "notes"),
    path.join(wikiPath, "sources", "conversations"),
    path.join(wikiPath, "sources", "documents"),
    path.join(wikiPath, "sources", "urls"),
    path.join(wikiPath, "sources", "media"),
    path.join(wikiPath, "sources", "manual"),
  );

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return wikiPath;
}

// ============================================================================
// SCHEMA GENERATION
// ============================================================================

/**
 * Generate default SCHEMA.md content
 */
export function generateSchemaMD(projectName: string): string {
  return `# Codebase Wiki Schema

> This file defines how the LLM maintains the codebase wiki for **${projectName}**.
> It is the "constitution" — the LLM reads it on every operation to understand constraints.

## Page Naming

- All filenames use **kebab-case**: \`auth-module.md\`, not \`AuthModule.md\`
- All wikilinks use **double brackets**: \`[[auth-module]]\`
- Page slugs must start with a letter: \`a-z\`, followed by \`a-z0-9\` or \`-\`

## Page Structure

Every page **must** have:

1. **H1 title** — the page title
2. **Summary paragraph** — one paragraph describing what this is
3. **See Also** section — cross-references to related pages

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| Entity | \`entities/\` | Code modules, services, components |
| Concept | \`concepts/\` | Cross-cutting ideas, patterns, paradigms |
| Decision | \`decisions/\` | Architecture Decision Records (ADRs) |
| Evolution | \`evolution/\` | How something changed over time |
| Comparison | \`comparisons/\` | Side-by-side analysis |

## Operations

### Ingest

When ingesting a new commit or file change:

1. Read the source (diff, file content)
2. Identify affected entities
3. Create or update entity pages in \`entities/\`
4. Update \`INDEX.md\` with new/changed entries
5. Update cross-references in related pages
6. Append entry to \`meta/LOG.md\`
7. If the change is architectural, create/update a Decision page

**Important**: A single ingest may touch 5-10 wiki pages.

### Query

When answering a question:

1. Search \`INDEX.md\` for relevant page IDs
2. Read the relevant pages
3. Synthesize an answer with citations
4. If the answer is valuable, offer to file it as a new page

### Lint

Periodically check for:

- **Contradictions**: Pages claiming conflicting facts
- **Orphans**: Pages with no inbound links
- **Stale pages**: Source files changed since last ingest
- **Missing concepts**: Terms mentioned 3+ times without their own page
- **Broken links**: Wikilinks pointing to non-existent pages
- **Empty sections**: Headers with no content

## Forbidden Actions

- Do **not** modify files outside \`.codebase-wiki/\`
- Do **not** modify raw source files
- Do **not** create self-referencing links
- Do **not** duplicate information — use cross-references instead

## Scope

### Include

\`\`\`
src/**
lib/**
packages/*/src/**
\`\`\`

### Exclude

\`\`\`
node_modules
dist
.git
coverage
.codebase-wiki
\`\`\`

---

*This schema was auto-generated by \`/wiki-init\`. Edit it to customize your wiki.*
`;
}

/**
 * Generate default INDEX.md content
 */
export function generateIndexMD(projectName: string): string {
  return `# ${projectName} — Codebase Wiki Index

> Auto-maintained knowledge base for the **${projectName}** codebase.
> Use \`/wiki-query <question>\` to search, or browse pages below.

## Entities

<!-- Entity pages will be listed here automatically -->

## Concepts

<!-- Concept pages will be listed here automatically -->

## Decisions (ADRs)

<!-- ADR pages will be listed here automatically -->

## Evolution

<!-- Evolution pages will be listed here automatically -->

## Comparisons

<!-- Comparison pages will be listed here automatically -->

---

*Last updated: ${new Date().toISOString().split("T")[0]}*
`;
}

/**
 * Generate default meta/LOG.md content
 */
export function generateLogMD(): string {
  return `# Ingest Log

| Timestamp | Source | Ref | Pages Created | Pages Updated |
|-----------|--------|-----|---------------|----------------|
| - | - | - | - | - |

---

*This log is auto-maintained by the codebase wiki.*
`;
}

/**
 * Generate entity page template
 */
export function generateEntityTemplate(): string {
  return `# {Entity Name}

> **Summary**: One-paragraph description of what this is and what it does.

## Location
- **Path**: \`src/path/to/module/\`
- **Type**: module | service | util | config | type

## Responsibilities
- What this entity is responsible for

## Dependencies
- [[other-entity]] — why it depends on it

## Dependents
- [[consumer-entity]] — what depends on this

## Key Files
- \`file1.ts\` — what it does
- \`file2.ts\` — what it does

## Design Decisions
- Why it works this way (from commits, ADRs, conversations)

## Evolution
- **v0.1** — Initial creation ([commit abc123])

## See Also
- [[related-concept]]
- [[related-decision]]
`;
}

/**
 * Generate ADR template
 */
export function generateDecisionTemplate(): string {
  return `# ADR-{N}: {Title}

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
`;
}

/**
 * Generate evolution template
 */
export function generateEvolutionTemplate(): string {
  return `# Evolution of {Feature}

> **Summary**: How this feature changed over time.

## Timeline

### {Date or Version} — {Event}
What changed and why. Link to commits and ADRs.

## Current State
Where things stand now.

## Lessons Learned
Patterns, anti-patterns, and takeaways from the evolution.

## See Also
- [[related-entity]]
- [[related-decision]]
`;
}

/**
 * Generate concept template
 */
export function generateConceptTemplate(): string {
  return `# {Concept Name}

> **Summary**: One-paragraph explanation of this concept.

## Definition
Formal or working definition.

## How It Works
Detailed explanation with examples from the codebase.

## Where It Appears
- [[entity-1]] — how this concept manifests
- [[entity-2]] — how this concept manifests

## Trade-offs
- Pro: ...
- Con: ...

## See Also
- [[related-concept]]
- [[related-decision]]
`;
}

/**
 * Generate comparison template
 */
export function generateComparisonTemplate(): string {
  return `# {A} vs {B}

> **Summary**: Key differences and when to use each.

## {A}
- What it is
- When to use it

## {B}
- What it is
- When to use it

## Comparison

| Aspect | {A} | {B} |
|--------|-----|-----|
| ... | ... | ... |

## Recommendation
When to choose which.

## See Also
- [[related-entity]]
`;
}