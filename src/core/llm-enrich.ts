/**
 * LLM Enrich Module (Phase 3)
 *
 * Uses pi's agent to enrich wiki pages with LLM-written summaries,
 * concept discovery, and design decision extraction.
 *
 * Architecture: Extension -> pi.sendUserMessage(prompt) -> Agent writes wiki
 *
 * The extension crafts structured prompts with entity data, sends them to
 * the running agent, and the agent writes the enriched wiki pages.
 *
 * NASA-10: small functions, validation, no globals.
 */

import * as fs from "fs";
import type { WikiPage } from "../shared.js";
import type { WikiStore } from "./store.js";

// ============================================================================
// TYPES
// ============================================================================

export interface LLMEnrichResult {
  pagesEnriched: number;
  conceptsCreated: number;
  decisionsDiscovered: number;
  errors: string[];
}

export interface EnrichmentPrompt {
  type: "enrich_entity" | "discover_concepts" | "extract_decisions";
  prompt: string;
  targetSlug: string;
}

// ============================================================================
// PROMPT GENERATION
// ============================================================================

const ENRICH_SYSTEM_PROMPT = `You are a wiki enrichment agent. Your job is to improve codebase wiki pages.

Rules:
1. Write clear, concise summaries (1-2 sentences)
2. Use [[wikilinks]] to reference other wiki pages that exist
3. Use backtick code format for imports, file paths, and external references
4. Never remove existing content — only improve or add
5. Keep the existing markdown structure (## sections)
6. Replace "(to be discovered)" and "(to be documented)" with real content
7. Replace generic summaries like "X module" with descriptive ones
8. Add specific details: what the module does, why it exists, key patterns
9. Keep the page under 80 lines total
10. Never modify files outside .codebase-wiki/`;

/**
 * Generate an enrichment prompt for a single entity page
 */
function generateEntityEnrichmentPrompt(
  page: WikiPage,
  pageContent: string,
  dependents: string[],
  allModuleSlugs: string[]
): string {
  const existingModules = dependents.filter(d => allModuleSlugs.includes(d));
  const depList = existingModules.length > 0
    ? existingModules.map(d => `[[${d}]]`).join(", ")
    : "(none found)";

  return `${ENRICH_SYSTEM_PROMPT}

---

Enrich this wiki page with better content. The page is for the "${page.title}" module.

Current content:
\`\`\`markdown
${pageContent}
\`\`\`

Additional context:
- Source files: ${page.sourceFiles.slice(0, 10).join(", ")}
- Known dependents: ${depList}
- Page type: ${page.type}

Rewrite the page with:
1. A descriptive summary (not just "X module")
2. Specific responsibilities based on the source files
3. Describe the dependencies with context (why it depends on each)
4. Fill in any "(to be discovered)" or "(to be documented)" sections
5. Add a "Patterns" section if you can identify any design patterns used

Write the complete enriched page in markdown:`;
}

/**
 * Generate a prompt to discover concept pages from the wiki
 */
function generateConceptDiscoveryPrompt(
  indexContent: string,
  existingConcepts: string[]
): string {
  const conceptList = existingConcepts.length > 0
    ? existingConcepts.join(", ")
    : "(none)";

  return `${ENRICH_SYSTEM_PROMPT}

---

Analyze the wiki index and discover cross-cutting concepts that deserve their own concept pages.

Existing concept pages: ${conceptList}

Wiki Index:
\`\`\`markdown
${indexContent}
\`\`\`

Based on the entities listed, identify 3-5 concepts that:
1. Appear across multiple entities (e.g., "hot-reload pattern", "event-driven architecture")
2. Are architectural patterns or design decisions, not just module names
3. Don't already have a concept page

For each concept, write a concept page with:
- A summary paragraph
- "Applies To" section listing the relevant [[entity]] pages
- Description of the pattern/concept
- Key characteristics

Write each concept as a separate markdown section starting with "---CONCEPT---":`;
}

/**
 * Generate a prompt to extract design decisions from commit history
 */
function generateDecisionExtractionPrompt(
  recentCommits: string,
  existingDecisions: string[]
): string {
  const decisionList = existingDecisions.length > 0
    ? existingDecisions.join(", ")
    : "(none)";

  return `${ENRICH_SYSTEM_PROMPT}

---

Analyze these git commits and extract architecture decisions (ADRs).

Existing ADR pages: ${decisionList}

Recent commits:
\`\`\`
${recentCommits}
\`\`\`

For each significant architectural decision you find:
1. Identify the decision (e.g., "Use SQLite over LevelDB", "Event bus for decoupling")
2. Write an ADR page with: Status, Context, Decision, Consequences
3. Only extract real decisions — skip trivial changes, formatting, typo fixes

Focus on decisions that involve:
- Technology choices
- Architecture patterns
- Trade-offs between alternatives
- Breaking changes

Write each ADR as a separate markdown section starting with "---ADR---":`;
}

// ============================================================================
// BATCH ENRICHMENT
// ============================================================================

/**
 * Generate enrichment prompts for the most impactful pages.
 * Prioritizes stub pages (generic summaries) first.
 */
export function generateEnrichmentBatch(
  pages: WikiPage[],
  store: WikiStore,
  wikiPath: string,
  maxPrompts: number = 5
): EnrichmentPrompt[] {
  console.assert(Array.isArray(pages), "pages must be array");
  console.assert(typeof wikiPath === "string", "wikiPath must be string");

  const allModuleSlugs = pages.map(p => p.id);
  const prompts: EnrichmentPrompt[] = [];

  // Find entity pages that are stubs (generic summaries)
  const stubPages = pages
    .filter(p => p.type === "entity")
    .filter(p => {
      const summary = p.summary || "";
      return summary.includes("module") && summary.length < 80;
    })
    .sort((a, b) => (a.summary || "").length - (b.summary || "").length)
    .slice(0, maxPrompts);

  for (const page of stubPages) {
    const pagePath = path.join(wikiPath, page.path);
    let content = "";
    try {
      content = fs.readFileSync(pagePath, "utf-8");
    } catch {
      continue;
    }

    // Get dependents from cross-reference table
    const xrefs = store.getCrossReferences(page.id);
    const dependents = xrefs.map(x => x.toPage);

    prompts.push({
      type: "enrich_entity",
      targetSlug: page.id,
      prompt: generateEntityEnrichmentPrompt(page, content, dependents, allModuleSlugs)
    });
  }

  return prompts.slice(0, maxPrompts);
}

// ============================================================================
// SEND TO AGENT
// ============================================================================

/**
 * Format an enrichment prompt for pi.sendUserMessage()
 * Returns the user message content string
 */
export function formatEnrichmentMessage(prompts: EnrichmentPrompt[]): string {
  if (prompts.length === 0) {
    return "";
  }

  const lines: string[] = [
    "📖 **Wiki Enrichment Request**",
    "",
    "The codebase wiki has pages that need enrichment. Please improve these wiki pages:",
    ""
  ];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    lines.push(`### ${i + 1}. Enrich: \`${p.targetSlug}\``);
    lines.push("");
    lines.push(p.prompt);
    lines.push("");
  }

  lines.push("---");
  lines.push("Write each enriched page to its file path (under `.codebase-wiki/entities/`).");
  lines.push("Use the `write` tool to save each page.");

  return lines.join("\n");
}

// Need path for join
import * as path from "path";