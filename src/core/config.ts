/**
 * Configuration Module
 *
 * Loads and validates wiki configuration from .codebase-wiki/SCHEMA.md
 * and pi settings. Follows NASA-10: validation, no globals, pure functions.
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiConfig, IngestConfig, PageTypeConfig, SourceType, IngestionMode, IngestionThresholds } from "../shared.js";
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
// SCHEMA PAGE TYPE PARSING
// ============================================================================

/**
 * Parse page types from the SCHEMA.md ## Page Types section.
 * Falls back to DEFAULT_PAGE_TYPES if section not found.
 */
export function loadPageTypes(schemaPath: string): PageTypeConfig[] {
  console.assert(typeof schemaPath === "string", "schemaPath must be string");

  try {
    const content = fs.readFileSync(schemaPath, "utf-8");
    const sectionMatch = content.match(/## Page Types Config\n+([\s\S]*?)(?=\n##|\n---|$)/);
    if (!sectionMatch || !sectionMatch[1]) {
      return DEFAULT_PAGE_TYPES;
    }

    const yaml = sectionMatch[1].trim();
    // Parse YAML list of page type configs
    const entries: PageTypeConfig[] = [];
    const lines = yaml.split("\n");
    let current: Partial<PageTypeConfig> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- id:")) {
        if (current) entries.push(current as PageTypeConfig);
        current = { id: trimmed.replace(/^-\s*id:\s*/, "").trim() };
      } else if (current && trimmed.startsWith("name:")) {
        current.name = trimmed.replace(/^name:\s*/, "").trim();
      } else if (current && trimmed.startsWith("directory:")) {
        current.directory = trimmed.replace(/^directory:\s*/, "").trim();
      } else if (current && trimmed.startsWith("template:")) {
        current.template = trimmed.replace(/^template:\s*/, "").trim();
      } else if (current && trimmed.startsWith("sourceTypes:")) {
        const val = trimmed.replace(/^sourceTypes:\s*/, "").trim();
        current.sourceTypes = val.replace(/[\[\]"]/g, "").split(",").map(s => s.trim()).filter(Boolean) as SourceType[];
      } else if (current && trimmed.startsWith("requiredSections:")) {
        const val = trimmed.replace(/^requiredSections:\s*/, "").trim();
        current.requiredSections = val.replace(/[\[\]"]/g, "").split(",").map(s => s.trim()).filter(Boolean);
      } else if (current && trimmed.startsWith("icon:")) {
        current.icon = trimmed.replace(/^icon:\s*/, "").trim();
      }
    }
    if (current) entries.push(current as PageTypeConfig);

    return entries.length > 0 ? entries : DEFAULT_PAGE_TYPES;
  } catch {
    return DEFAULT_PAGE_TYPES;
  }
}

/**
 * Parse domain from SCHEMA.md header.
 * Falls back to "codebase" if not found.
 */
export function loadDomain(schemaPath: string): string {
  console.assert(typeof schemaPath === "string", "schemaPath must be string");

  try {
    const content = fs.readFileSync(schemaPath, "utf-8");
    const match = content.match(/\*\*Domain\*\*:\s*(\w+)/);
    return match?.[1] ?? "codebase";
  } catch {
    return "codebase";
  }
}

/**
 * Parse ingestion mode and thresholds from SCHEMA.md.
 * Falls back to defaults ("auto" mode, no confirmations) if not found.
 */
export function loadIngestionConfig(schemaPath: string): { mode: IngestionMode; thresholds: IngestionThresholds } {
  console.assert(typeof schemaPath === "string", "schemaPath must be string");

  const defaults = {
    mode: "auto" as IngestionMode,
    thresholds: DEFAULT_WIKI_CONFIG.ingestionThresholds,
  };

  try {
    const content = fs.readFileSync(schemaPath, "utf-8");

    // Parse ingestion mode
    const modeMatch = content.match(/\*\*Ingestion Mode\*\*:\s*(\w+)/);
    const mode = (modeMatch?.[1] as IngestionMode) ?? defaults.mode;
    if (!["auto", "confirm", "guided"].includes(mode)) {
      return defaults;
    }

    // Parse thresholds section
    const thresholds: IngestionThresholds = { ...defaults.thresholds };
    const thresholdSection = content.match(/## Ingestion Workflow[\s\S]*?(?=\n##|\n---|$)/);
    if (thresholdSection?.[1]) {
      const section = thresholdSection[1];
      const parseBool = (key: string, fallback: boolean): boolean => {
        const m = section.match(new RegExp(`${key}:\\s*(true|false)`, "i"));
        return m ? m[1]!.toLowerCase() === "true" : fallback;
      };
      thresholds.newPageCreation = parseBool("new_page_creation", thresholds.newPageCreation);
      thresholds.pageDeletion = parseBool("page_deletion", thresholds.pageDeletion);
      thresholds.contradictionResolution = parseBool("contradiction_resolution", thresholds.contradictionResolution);
      thresholds.crossReferenceUpdate = parseBool("cross_reference_update", thresholds.crossReferenceUpdate);
    }

    return { mode, thresholds };
  } catch {
    return defaults;
  }
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
/**
 * Generate SCHEMA.md content with domain and page type configuration.
 * The SCHEMA.md is the "constitution" for the wiki — the LLM reads it
 * on every operation to understand constraints and page types.
 */
export function generateSchemaMD(projectName: string, domain: string = "codebase", pageTypes?: PageTypeConfig[], ingestionMode: IngestionMode = "auto", ingestionThresholds?: IngestionThresholds): string {
  const types = pageTypes ?? DEFAULT_PAGE_TYPES;
  const typesWithDirs = types.filter(pt => pt.directory);

  const pageTypeRows = typesWithDirs
    .map(pt => `| ${pt.name} | \`${pt.directory}/\` | ${pt.id} pages`)
    .join("\n");

  const pageTypeConfigs = types
    .map(pt => `- id: ${pt.id}\n  name: ${pt.name}\n  directory: ${pt.directory || "(none)"}\n  template: ${pt.template || "(none)"}\n  requiredSections: [${pt.requiredSections.join(", ")}]\n  sourceTypes: [${(pt.sourceTypes || []).join(", ")}]\n  icon: ${pt.icon || ""}`)
    .join("\n");

  return `# ${domain === "codebase" ? "Codebase" : domain.charAt(0).toUpperCase() + domain.slice(1)} Wiki Schema

> This file defines how the LLM maintains the wiki for **${projectName}**.
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

**Domain**: ${domain}

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${pageTypeRows}

## Page Types Config

${pageTypeConfigs}

**Ingestion Mode**: ${ingestionMode}

## Ingestion Workflow

\`\`\`
new_page_creation: ${ingestionThresholds?.newPageCreation ?? false}
page_deletion: ${ingestionThresholds?.pageDeletion ?? true}
contradiction_resolution: ${ingestionThresholds?.contradictionResolution ?? true}
cross_reference_update: ${ingestionThresholds?.crossReferenceUpdate ?? false}
\`\`\`

## Operations

### Ingest

When ingesting a new commit or file change:

1. Read the source (diff, file content)
2. Identify affected entities
3. Create or update entity pages in the appropriate directory
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
 * Simple English pluralization — handles common cases and domain-specific irregulars.
 * entity → entities, query → queries, person → people, etc.
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  person: "people",
  media: "media",
};

function pluralize(name: string): string {
  const lower = name.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) {
    const plural = IRREGULAR_PLURALS[lower]!;
    // Preserve original casing: Person → People, person → people
    return name[0] === name[0]!.toUpperCase() ? plural.charAt(0).toUpperCase() + plural.slice(1) : plural;
  }
  if (name.endsWith("y") && !name.endsWith("ay") && !name.endsWith("ey") && !name.endsWith("oy") && !name.endsWith("uy")) {
    return name.slice(0, -1) + "ies";
  }
  if (name.endsWith("s") || name.endsWith("x") || name.endsWith("z") || name.endsWith("ch") || name.endsWith("sh")) {
    return name + "es";
  }
  return name + "s";
}

export function generateIndexMD(projectName: string, domain: string = "codebase", pageTypes?: PageTypeConfig[]): string {
  const types = pageTypes ?? DEFAULT_PAGE_TYPES;
  const domainLabel = domain === "codebase" ? "Codebase" : domain.charAt(0).toUpperCase() + domain.slice(1);
  const sections = types
    .filter(pt => pt.directory)
    .map(pt => `## ${pluralize(pt.name)}\n\n\u003c!-- ${pt.name} pages will be listed here automatically --\u003e`)
    .join("\n\n");

  return `# ${projectName} — ${domainLabel} Wiki Index

> Auto-maintained knowledge base for the **${projectName}** ${domain}.
> Use \`/wiki-query <question>\` to search, or browse pages below.

${sections}

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