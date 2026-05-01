/**
 * Template Generators — Domain-aware page templates driven by PageTypeConfig.
 *
 * Each page type config specifies a template filename. This module provides
 * a registry of template generators keyed by template filename, plus a generic
 * fallback that builds a template from the PageTypeConfig metadata.
 *
 * Phase 0 defined `generateEntityTemplate()` etc. as hardcoded functions.
 * Phase 3 generalizes this so domain presets (personal, research, book) get
 * their own templates without code changes.
 */

import type { PageTypeConfig } from "../shared.js";

// ============================================================================
// TEMPLATE REGISTRY
// ============================================================================

/**
 * Registry of named template generators.
 * Key = template filename (e.g. "entity.md"), value = generator function.
 */
const TEMPLATE_REGISTRY: Record<string, (name: string) => string> = {
  "entity.md": generateEntityPage,
  "concept.md": generateConceptPage,
  "decision.md": generateDecisionPage,
  "evolution.md": generateEvolutionPage,
  "comparison.md": generateComparisonPage,
  "query.md": generateQueryPage,
  // Personal domain
  "person.md": generatePersonPage,
  "topic.md": generateTopicPage,
  "insight.md": generateInsightPage,
  "media.md": generateMediaPage,
  "habit.md": generateHabitPage,
  // Research domain
  "paper.md": generatePaperPage,
  "finding.md": generateFindingPage,
  "method.md": generateMethodPage,
  // Book domain
  "character.md": generateCharacterPage,
  "theme.md": generateThemePage,
  "chapter.md": generateChapterPage,
  "location.md": generateLocationPage,
  "quote.md": generateQuotePage,
};

/**
 * Get the template content for a page type.
 * If the template filename has a registered generator, use it.
 * Otherwise, generate a generic template from the config.
 */
export function getTemplateForPageType(pageType: PageTypeConfig): string {
  const templateName = pageType.template;
  if (templateName && TEMPLATE_REGISTRY[templateName]) {
    return TEMPLATE_REGISTRY[templateName]!(pageType.name);
  }
  return generateGenericPage(pageType);
}

/**
 * Get all template files for a set of page types.
 * Returns a Record<filename, content> suitable for writing to disk.
 */
export function getTemplatesForPageTypes(pageTypes: PageTypeConfig[]): Record<string, string> {
  const templates: Record<string, string> = {};
  for (const pt of pageTypes) {
    if (pt.template) {
      templates[pt.template] = getTemplateForPageType(pt);
    }
  }
  return templates;
}

// ============================================================================
// CODEBASE DOMAIN TEMPLATES
// ============================================================================

function generateEntityPage(name: string): string {
  return `# {${name} Name}

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

function generateConceptPage(name: string): string {
  return `# {${name} Name}

> **Summary**: One-paragraph explanation of this concept.

## Definition
Formal or working definition.

## How It Works
Detailed explanation with examples.

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

function generateDecisionPage(name: string): string {
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

function generateEvolutionPage(name: string): string {
  return `# Evolution of {${name}}

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

function generateComparisonPage(name: string): string {
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

function generateQueryPage(name: string): string {
  return `# {Question}

> **Filed**: {date}
> **Matches**: {n} pages

## Matched Pages
- [[page-1]] — brief description
- [[page-2]] — brief description

## Answer
*(to be synthesized)*

## Open Questions
- *(to be discovered)*

## Sources
- \`src-xxx\`

---
*Filed by wiki_query*
`;
}

// ============================================================================
// PERSONAL DOMAIN TEMPLATES
// ============================================================================

function generatePersonPage(name: string): string {
  return `# {${name} Name}

> **Summary**: Who this person is and why they matter.

## Key Facts
- **Role**: ...
- **Context**: ...

## Interactions
- How this person connects to topics in this wiki

## Notes
- Observations, quotes, key moments

## See Also
- [[related-topic]]
- [[related-insight]]
`;
}

function generateTopicPage(name: string): string {
  return `# {${name}}

> **Summary**: One-paragraph overview of this topic.

## Key Ideas
- Main concepts and principles

## Connections
- [[related-topic-1]] — how they connect
- [[related-topic-2]] — how they connect

## Questions
- Open questions about this topic

## See Also
- [[related-insight]]
- [[related-person]]
`;
}

function generateInsightPage(name: string): string {
  return `# {${name}}

> **Summary**: The core insight in one sentence.

## Connections
- [[related-topic]] — how this insight relates

## Context
- Where this insight came from

## Implications
- What follows from this insight

## See Also
- [[related-topic]]
`;
}

function generateMediaPage(name: string): string {
  return `# {${name}}

> **Summary**: What this media is and why it's notable.

## Details
- **Type**: book | video | podcast | article
- **Creator**: ...
- **Date**: ...

## Takeaways
- Key lessons from this media

## Quotes
- Notable quotes worth remembering

## See Also
- [[related-topic]]
- [[related-insight]]
`;
}

function generateHabitPage(name: string): string {
  return `# {${name}}

> **Summary**: What this habit is and its purpose.

## Tracking
- Frequency and consistency data

## Notes
- Reflections on this habit

## See Also
- [[related-insight]]
`;
}

// ============================================================================
// RESEARCH DOMAIN TEMPLATES
// ============================================================================

function generatePaperPage(name: string): string {
  return `# {${name}}

> **Summary**: One-paragraph summary of the paper's contribution.

## Key Findings
- Main results and claims

## Methodology
- Approach used in the paper

## Limitations
- Known limitations and threats to validity

## Related Work
- [[related-paper-1]]
- [[related-paper-2]]

## See Also
- [[related-concept]]
- [[related-finding]]
`;
}

function generateFindingPage(name: string): string {
  return `# {${name}}

> **Summary**: What was found and why it matters.

## Evidence
- Data, results, or observations supporting this finding

## Implications
- What this finding means for the research area

## See Also
- [[related-concept]]
- [[related-paper]]
`;
}

function generateMethodPage(name: string): string {
  return `# {${name}}

> **Summary**: What this method does and when to use it.

## Steps
1. Step one
2. Step two
3. Step three

## Trade-offs
- **Pro**: ...
- **Con**: ...

## See Also
- [[related-finding]]
- [[related-concept]]
`;
}

// ============================================================================
// BOOK DOMAIN TEMPLATES
// ============================================================================

function generateCharacterPage(name: string): string {
  return `# {${name}}

> **Summary**: Who this character is and their role in the story.

## Arc
- Beginning: ...
- Development: ...
- Resolution: ...

## Relationships
- [[other-character]] — nature of relationship

## Key Moments
- Events that define this character

## Quotes
- Memorable lines from this character

## See Also
- [[related-theme]]
- [[related-chapter]]
`;
}

function generateThemePage(name: string): string {
  return `# {${name}}

> **Summary**: What this theme explores and why it matters.

## Examples
- How this theme appears in the story

## Connections
- [[related-theme]] — how themes interrelate

## See Also
- [[related-character]]
- [[related-chapter]]
`;
}

function generateChapterPage(name: string): string {
  return `# {${name}}

> **Summary**: What happens in this chapter.

## Key Events
- Event one
- Event two

## Characters
- [[character-1]] — their role
- [[character-2]] — their role

## Themes
- [[theme-1]] — how it appears

## See Also
- [[related-chapter]]
`;
}

function generateLocationPage(name: string): string {
  return `# {${name}}

> **Summary**: What this location is and its significance.

## Significance
- Why this place matters in the story

## Events
- Key events that happen here

## See Also
- [[related-character]]
- [[related-chapter]]
`;
}

function generateQuotePage(name: string): string {
  return `# {${name}}

> **Quote**: The actual quote text.

## Context
- Who said it, when, and why

## Significance
- Why this quote matters

## See Also
- [[related-character]]
- [[related-theme]]
`;
}

// ============================================================================
// GENERIC FALLBACK TEMPLATE
// ============================================================================

/**
 * Generate a generic template for a page type not in the registry.
 * Uses the PageTypeConfig metadata (name, requiredSections, icon) to build
 * a reasonable default.
 */
function generateGenericPage(pt: PageTypeConfig): string {
  const icon = pt.icon || "📄";
  const sections = pt.requiredSections.length > 0
    ? pt.requiredSections.map(s => `## ${s}\n\n(To be filled)\n`).join("\n")
    : "## Notes\n\n(To be filled)\n";

  return `# {${pt.name} Title}

${icon} **Summary**: One-paragraph description of this ${pt.id}.

${sections}
## See Also
- [[related-page]]
`;
}