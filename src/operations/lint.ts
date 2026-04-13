/**
 * Lint Pipeline — health checks for the wiki
 *
 * Checks for contradictions, orphans, stale pages, broken links,
 * missing concepts, and empty sections. Returns structured LintResult.
 */

import * as path from "path";
import type { LintResult, LintIssue, WikiPage } from "../shared.js";
import type { WikiStore } from "../core/store.js";
import {
  checkAllStaleness,
  findOrphanPages,
  findBrokenLinks,
  findStalePages,
  findMissingConcepts,
  findEmptySections,
  findContradictions,
} from "../core/staleness.js";

// ============================================================================
// LINT OPERATIONS
// ============================================================================

/**
 * Run all lint checks and return a structured result
 */
export function lintWiki(
  wikiPath: string,
  store: WikiStore
): LintResult {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");

  const pages = store.getAllPages();
  const issues: LintIssue[] = [];

  // 1. Stale pages (source files changed since last ingest)
  const staleIssues = findStalePages(pages);
  issues.push(...staleIssues);

  // 2. Orphan pages (no inbound links)
  const orphanIssues = findOrphanPages(pages, store);
  issues.push(...orphanIssues);

  // 3. Broken wikilinks
  const brokenLinkIssues = findBrokenLinks(wikiPath, pages);
  issues.push(...brokenLinkIssues);

  // 4. Missing concepts (terms mentioned 3+ times without pages)
  const missingConceptIssues = findMissingConcepts(wikiPath, pages);
  issues.push(...missingConceptIssues);

  // 5. Empty sections
  const emptySectionIssues = findEmptySections(wikiPath, pages);
  issues.push(...emptySectionIssues);

  // 6. Contradictions (high-overlap pages that might be duplicates)
  const contradictionIssues = findContradictions(wikiPath, pages);
  issues.push(...contradictionIssues);

  // 7. Update staleness checks in the store
  const stalenessChecks = checkAllStaleness(pages, wikiPath);
  for (const check of stalenessChecks) {
    store.upsertStalenessCheck(check);
  }

  // Count page states
  const stalePageCount = pages.filter(p => p.stale).length;
  const orphanCount = issues.filter(i => i.type === "orphan").length;

  return {
    issues,
    totalPages: pages.length,
    healthyPages: pages.length - stalePageCount - orphanCount,
    stalePages: stalePageCount,
    orphanPages: orphanCount,
    lastLintTime: new Date().toISOString(),
  };
}

/**
 * Format lint result as a human-readable string
 */
export function formatLintResult(result: LintResult): string {
  const lines: string[] = [
    `📖 Wiki Lint Report`,
    ``,
    `**Pages**: ${result.totalPages} total, ${result.healthyPages} healthy, ${result.stalePages} stale, ${result.orphanPages} orphans`,
    `**Issues**: ${result.issues.length} found`,
    `**Last lint**: ${result.lastLintTime}`,
    ``,
  ];

  if (result.issues.length === 0) {
    lines.push("✅ No issues found. Wiki is healthy!");
    return lines.join("\n");
  }

  // Group by severity
  const errors = result.issues.filter(i => i.severity === "error");
  const warnings = result.issues.filter(i => i.severity === "warning");
  const infos = result.issues.filter(i => i.severity === "info");

  if (errors.length > 0) {
    lines.push(`### ❌ Errors (${errors.length})`);
    for (const issue of errors) {
      lines.push(`- **${issue.type}**: ${issue.description}`);
      lines.push(`  → ${issue.suggestion}`);
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(`### ⚠️ Warnings (${warnings.length})`);
    for (const issue of warnings) {
      lines.push(`- **${issue.type}**: ${issue.description}`);
      lines.push(`  → ${issue.suggestion}`);
    }
    lines.push("");
  }

  if (infos.length > 0) {
    lines.push(`### 💡 Suggestions (${infos.length})`);
    for (const issue of infos) {
      lines.push(`- **${issue.type}**: ${issue.description}`);
      lines.push(`  → ${issue.suggestion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}