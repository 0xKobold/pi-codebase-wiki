/**
 * Public API — Pure wiki operations usable without pi.
 *
 * Other packages and the CLI import from here.
 * No pi dependency. No side effects on import.
 */

export { WikiStore } from "./store.js";
export type { WikiPage, WikiStats, StalePage, CrossReference, IngestLog } from "../shared.js";

export {
  loadConfig,
  wikiExists,
  getWikiPath,
  ensureWikiDirs,
  generateSchemaMD,
  generateIndexMD,
  generateLogMD,
  generateEntityTemplate,
  generateDecisionTemplate,
  generateEvolutionTemplate,
  generateConceptTemplate,
  generateComparisonTemplate,
} from "./config.js";

export {
  getRecentCommits,
  getAllCommits,
  getCurrentBranch,
  getLatestHash,
} from "./git.js";

export {
  initWiki,
  ingestCommits,
  ingestFileTree,
  updateIndex,
} from "../operations/ingest.js";

export { searchWiki, getPageContent, getRelatedPages } from "../operations/query.js";
export { lintWiki, formatLintResult } from "../operations/lint.js";
export type { LintResult, LintIssue } from "../operations/lint.js";

export { enrichAllEntities } from "./smart-ingest.js";
export { generateEnrichmentBatch, formatEnrichmentMessage } from "./llm-enrich.js";
export type { EnrichmentPrompt } from "./llm-enrich.js";

export { extractImports, extractExports, resolveImportToSlug, buildCrossReferences } from "./deps.js";
export type { DependencyInfo } from "./deps.js";

export { scanFileTree } from "./indexer.js";