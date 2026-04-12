/**
 * Query Pipeline — search and synthesize answers from the wiki
 *
 * Reads wiki pages (not raw source) and returns structured results.
 * The LLM agent does the synthesis — this module provides the data.
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiPage } from "../shared.js";
import type { WikiStore } from "../core/store.js";

// ============================================================================
// QUERY TYPES
// ============================================================================

export interface QueryResult {
  query: string;
  matches: PageMatch[];
  totalPages: number;
  stats: { totalPages: number; stalePages: number; lastIngest: string | null };
}

export interface PageMatch {
  page: WikiPage;
  score: number;              // Relevance score 0-1
  snippet: string;            // First 200 chars of content
  filePath: string;           // Full path to the markdown file
}

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

/**
 * Search wiki pages by keyword
 */
export function searchWiki(
  query: string,
  wikiPath: string,
  store: WikiStore,
  limit: number = 10
): QueryResult {
  console.assert(typeof query === "string", "query must be string");
  console.assert(query.length > 0, "query must not be empty");

  const allPages = store.getAllPages();
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  const matches: PageMatch[] = [];

  for (const page of allPages) {
    const score = scorePage(page, terms, wikiPath);
    if (score > 0) {
      const filePath = path.join(wikiPath, page.path);
      let snippet = "";
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        // Extract first paragraph after the title
        const lines = content.split("\n");
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]!.trim();
          if (line.length > 0 && !line.startsWith("#") && !line.startsWith(">")) {
            snippet = line.slice(0, 200);
            break;
          }
        }
      } catch {
        snippet = page.summary || "(content not available)";
      }

      matches.push({ page, score, snippet, filePath });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  const stats = store.getStats();

  return {
    query,
    matches: matches.slice(0, limit),
    totalPages: allPages.length,
    stats: {
      totalPages: stats.totalPages,
      stalePages: stats.stalePages,
      lastIngest: stats.lastIngest,
    },
  };
}

/**
 * Get a specific page by slug
 */
export function getPageContent(
  slug: string,
  wikiPath: string,
  store: WikiStore
): { page: WikiPage; content: string } | null {
  console.assert(typeof slug === "string", "slug must be string");

  const page = store.getPage(slug);
  if (!page) return null;

  const filePath = path.join(wikiPath, page.path);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return { page, content };
  } catch {
    return { page, content: "(file not found)" };
  }
}

/**
 * Get pages related to a given page
 */
export function getRelatedPages(
  slug: string,
  wikiPath: string,
  store: WikiStore
): WikiPage[] {
  console.assert(typeof slug === "string", "slug must be string");

  const outbound = store.getOutboundLinks(slug);
  const inbound = store.getInboundLinks(slug);

  const relatedIds = new Set<string>();
  for (const ref of outbound) relatedIds.add(ref.toPage);
  for (const ref of inbound) relatedIds.add(ref.fromPage);

  const pages: WikiPage[] = [];
  for (const id of relatedIds) {
    const page = store.getPage(id);
    if (page) pages.push(page);
  }

  return pages;
}

/**
 * Extract all wikilinks from a page's content
 */
export function extractWikilinks(content: string): string[] {
  const pattern = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    links.push(match[1]!.trim().toLowerCase());
  }

  return [...new Set(links)];
}

// ============================================================================
// SCORING (pure function)
// ============================================================================

function scorePage(page: WikiPage, terms: string[], wikiPath: string): number {
  let score = 0;
  const titleLower = page.title.toLowerCase();
  const summaryLower = (page.summary || "").toLowerCase();

  // Title match — highest weight
  for (const term of terms) {
    if (titleLower.includes(term)) score += 0.4;
    if (titleLower === term) score += 0.3; // Exact match bonus
  }

  // Summary match
  for (const term of terms) {
    if (summaryLower.includes(term)) score += 0.2;
  }

  // Content match (read the file)
  try {
    const filePath = path.join(wikiPath, page.path);
    const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
    for (const term of terms) {
      const occurrences = (content.match(new RegExp(term, "g")) || []).length;
      score += Math.min(occurrences * 0.05, 0.3); // Cap at 0.3 per term
    }
  } catch {
    // File not found — skip content scoring
  }

  // Recency bonus (fresher pages are slightly more relevant)
  const ageMs = Date.now() - new Date(page.lastIngested).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) score += 0.1;
  else if (ageDays < 7) score += 0.05;

  return Math.min(score, 1.0);
}