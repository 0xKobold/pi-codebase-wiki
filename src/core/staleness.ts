/**
 * Staleness Detection Module
 *
 * Detects when wiki pages are out of date relative to their source files.
 * Uses file modification times and git history to compute staleness scores.
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiPage, StalenessCheck, LintIssue } from "../shared.js";
import { formatWikiDate } from "../shared.js";
import type { WikiStore } from "./store.js";

// ============================================================================
// STALENESS CHECKS
// ============================================================================

/**
 * Check staleness for a single page
 */
export function checkPageStaleness(
  page: WikiPage,
  wikiRoot: string
): StalenessCheck {
  console.assert(page !== null, "page must not be null");

  const staleFiles: string[] = [];
  let lastMtime = 0;

  // Parse last ingested time
  const lastIngested = new Date(page.lastIngested).getTime();

  // Check each source file
  for (const sourceFile of page.sourceFiles) {
    try {
      const fullPath = path.resolve(wikiRoot, "..", sourceFile);
      // Go up from .codebase-wiki/ to project root
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > lastIngested) {
        staleFiles.push(sourceFile);
        lastMtime = Math.max(lastMtime, stat.mtimeMs);
      }
    } catch {
      // File might have been deleted — definitely stale
      staleFiles.push(sourceFile);
    }
  }

  // Also check git commits
  for (const commitHash of page.sourceCommits) {
    // We can't easily check commit timestamps without git,
    // so we skip this for now. Could be enhanced with git integration.
  }

  // Compute staleness score: 0 = fresh, 1 = very stale
  const staleCount = staleFiles.length;
  const totalFiles = page.sourceFiles.length || 1;
  const rawScore = staleCount / totalFiles;
  // Scale by age: older stale files are worse
  const ageDays = (Date.now() - lastIngested) / (1000 * 60 * 60 * 24);
  const ageFactor = Math.min(ageDays / 30, 1); // max out at 30 days
  const stalenessScore = rawScore * (0.5 + 0.5 * ageFactor);

  return {
    pageId: page.id,
    checkTime: new Date().toISOString(),
    staleFiles,
    stalenessScore: Math.min(stalenessScore, 1),
  };
}

/**
 * Check staleness for all pages
 */
export function checkAllStaleness(pages: WikiPage[], wikiRoot: string): StalenessCheck[] {
  console.assert(Array.isArray(pages), "pages must be array");

  return pages
    .filter(page => page.sourceFiles.length > 0) // Skip pages without sources
    .map(page => checkPageStaleness(page, wikiRoot));
}

// ============================================================================
// LINT CHECKS
// ============================================================================

/**
 * Find orphan pages (no inbound links, not index/schema/changelog)
 */
export function findOrphanPages(pages: WikiPage[], store: WikiStore): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const page of pages) {
    if (page.type === "index" || page.type === "schema" || page.type === "changelog") {
      continue; // These are expected to not have inbound links
    }

    if (page.inboundLinks === 0) {
      issues.push({
        type: "orphan",
        severity: "warning",
        pagePath: page.path,
        description: `Page "${page.title}" has no inbound links`,
        suggestion: `Add a link to [[${page.id}]] from related pages`,
      });
    }
  }

  return issues;
}

/**
 * Find broken wikilinks in the wiki
 */
export function findBrokenLinks(wikiRoot: string, pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const pageIds = new Set(pages.map(p => p.id));

  // Read each page and check [[wikilinks]]
  for (const page of pages) {
    const pagePath = path.join(wikiRoot, page.path);
    try {
      const content = fs.readFileSync(pagePath, "utf-8");
      const linkPattern = /\[\[([^\]]+)\]\]/g;
      let match: RegExpExecArray | null;

      while ((match = linkPattern.exec(content)) !== null) {
        const targetId = match[1]!.trim().toLowerCase();
        if (!pageIds.has(targetId)) {
          issues.push({
            type: "broken_link",
            severity: "error",
            pagePath: page.path,
            description: `Broken link to [[${match[1]}]] in "${page.title}"`,
            suggestion: `Create a page for "${match[1]}" or update the link`,
          });
        }
      }
    } catch {
      // File might not exist yet
    }
  }

  return issues;
}

/**
 * Find stale pages
 */
export function findStalePages(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const page of pages) {
    if (page.stale) {
      const age = Date.now() - new Date(page.lastIngested).getTime();
      const ageDays = Math.floor(age / (1000 * 60 * 60 * 24));

      issues.push({
        type: "stale",
        severity: ageDays > 14 ? "error" : "warning",
        pagePath: page.path,
        description: `Page "${page.title}" is stale (${ageDays} days old)`,
        suggestion: `Re-ingest sources for this page using wiki_ingest`,
      });
    }
  }

  return issues;
}

/**
 * Find missing concepts — terms frequently mentioned but without their own page
 */
export function findMissingConcepts(wikiRoot: string, pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const existingIds = new Set(pages.map(p => p.id));

  // Track term frequency across all pages
  const termFreq = new Map<string, number>();

  for (const page of pages) {
    const pagePath = path.join(wikiRoot, page.path);
    try {
      const content = fs.readFileSync(pagePath, "utf-8");
      // Look for quoted terms and backtick-enclosed terms
      const termPatterns = [/`([^`]+)`/g, /\*\*([^*]+)\*\*/g];

      for (const pattern of termPatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const term = match[1]!.trim().toLowerCase();
          if (term.length > 3 && !existingIds.has(term.replace(/\s+/g, "-"))) {
            termFreq.set(term, (termFreq.get(term) || 0) + 1);
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Terms mentioned 3+ times without a page
  for (const [term, count] of termFreq) {
    if (count >= 3) {
      issues.push({
        type: "missing_concept",
        severity: "info",
        pagePath: "(global)",
        description: `"${term}" mentioned ${count} times but has no wiki page`,
        suggestion: `Create a concept page: [[${term.replace(/\s+/g, "-")}]]`,
      });
    }
  }

  return issues;
}

/**
 * Find empty sections in pages
 */
export function findEmptySections(wikiRoot: string, pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const page of pages) {
    const pagePath = path.join(wikiRoot, page.path);
    try {
      const content = fs.readFileSync(pagePath, "utf-8");
      // Check for sections with only placeholder text or nothing
      const sectionPattern = /^##\s+(.+)$/gm;
      let match: RegExpExecArray | null;
      const lines = content.split("\n");

      let sectionStart = -1;
      let sectionTitle = "";

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const headerMatch = line.match(/^##\s+(.+)$/);

        if (headerMatch) {
          // Check if previous section was empty
          if (sectionStart >= 0 && i - sectionStart <= 1) {
            issues.push({
              type: "empty_section",
              severity: "info",
              pagePath: page.path,
              description: `Empty section "## ${sectionTitle}" in "${page.title}"`,
              suggestion: `Add content to the "${sectionTitle}" section or remove it`,
            });
          }
          sectionStart = i + 1;
          sectionTitle = headerMatch[1]!;
        }
      }

      // Check last section
      if (sectionStart >= 0 && lines.length - sectionStart <= 1) {
        issues.push({
          type: "empty_section",
          severity: "info",
          pagePath: page.path,
          description: `Empty section "## ${sectionTitle}" in "${page.title}"`,
          suggestion: `Add content to the "${sectionTitle}" section or remove it`,
        });
      }
    } catch {
      continue;
    }
  }

  return issues;
}