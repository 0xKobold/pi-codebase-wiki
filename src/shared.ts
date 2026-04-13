/**
 * pi-codebase-wiki Shared Types & Utilities
 *
 * Common types, constants, and utility functions for the codebase wiki system.
 * Follows NASA-10 coding rules: small functions, minimal scope, validation.
 */

// ============================================================================
// TYPES
// ============================================================================

/** Wiki page types */
export type PageType = "entity" | "concept" | "decision" | "evolution" | "comparison" | "query" | "changelog" | "index" | "schema";

/** Ingest source types */
export type IngestSourceType = "commit" | "file" | "docs" | "manual" | "full-tree";

/** Lint issue severity */
export type LintSeverity = "error" | "warning" | "info";

/** Lint issue types */
export type LintIssueType =
  | "contradiction"
  | "orphan"
  | "stale"
  | "broken_link"
  | "missing_concept"
  | "duplicate"
  | "empty_section";

/** Wiki page record */
export interface WikiPage {
  id: string;                     // kebab-case slug
  path: string;                   // relative path from wiki root
  type: PageType;
  title: string;
  summary: string;                 // first paragraph
  sourceFiles: string[];          // source file paths this page derives from
  sourceCommits: string[];        // commit hashes this page derives from
  lastIngested: string;           // ISO timestamp
  lastChecked: string;            // last staleness check
  inboundLinks: number;
  outboundLinks: number;
  stale: boolean;
}

/** Ingest log entry */
export interface IngestLog {
  id: string;
  sourceType: IngestSourceType;
  sourceRef: string;              // commit hash, file path, or description
  pagesCreated: number;
  pagesUpdated: number;
  timestamp: string;              // ISO timestamp
}

/** Cross-reference between pages */
export interface CrossReference {
  fromPage: string;               // source page slug
  toPage: string;                 // target page slug
  context: string;                // why this link exists
}

/** Staleness check result */
export interface StalenessCheck {
  pageId: string;
  checkTime: string;
  staleFiles: string[];           // files that changed since last ingest
  stalenessScore: number;        // 0-1
}

/** Lint issue */
export interface LintIssue {
  type: LintIssueType;
  severity: LintSeverity;
  pagePath: string;
  description: string;
  suggestion: string;
}

/** Lint result */
export interface LintResult {
  issues: LintIssue[];
  totalPages: number;
  healthyPages: number;
  stalePages: number;
  orphanPages: number;
  lastLintTime: string;
}

/** Ingest configuration */
export interface IngestConfig {
  minBatchSize: number;           // default: 3
  recentCommitAge: string;        // default: "7d"
  importantTypes: string[];       // default: ["feat", "fix", "refactor", "breaking"]
  ignorePatterns: string[];       // default: ["chore: update deps", "docs: typos"]
  includePatterns: string[];      // default: ["src/**", "lib/**", "packages/*/src/**"]
  excludePatterns: string[];      // default: ["node_modules", "dist", ".git"]
}

/** Extension configuration */
export interface WikiConfig {
  autoIngest: boolean;            // default: false
  ingestOnStart: boolean;         // default: false
  stalenessCheckInterval: string; // default: "1h"
  maxContextPages: number;        // default: 5
  commitBatchSize: number;       // default: 3
  importantCommitTypes: string[];
  excludeCommitPatterns: string[];
  wikiDir: string;                // default: ".codebase-wiki"
}

/** Git commit info */
export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  type: string;                   // feat, fix, refactor, etc.
  scope: string;                  // parenthesized scope
  files: string[];                // changed files
}

/** File tree entry */
export interface FileEntry {
  path: string;
  type: "file" | "directory";
  extension?: string;
  size?: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const DEFAULT_WIKI_DIR = ".codebase-wiki";

export const PAGE_TYPE_DIR: Record<PageType, string> = {
  entity: "entities",
  concept: "concepts",
  decision: "decisions",
  evolution: "evolution",
  comparison: "comparisons",
  query: "queries",
  changelog: "",
  index: "",
  schema: "",
} as const;

export const COMMIT_TYPES = [
  { type: "feat", desc: "A new feature" },
  { type: "fix", desc: "A bug fix" },
  { type: "docs", desc: "Documentation only changes" },
  { type: "style", desc: "Code style changes (formatting, semicolons, etc)" },
  { type: "refactor", desc: "Code refactoring without changing functionality" },
  { type: "perf", desc: "Performance improvements" },
  { type: "test", desc: "Adding or fixing tests" },
  { type: "build", desc: "Build system or dependency changes" },
  { type: "ci", desc: "CI/CD configuration changes" },
  { type: "chore", desc: "Other changes that don't modify src or test files" },
  { type: "revert", desc: "Reverting a previous commit" },
] as const;

export const DEFAULT_INGEST_CONFIG: IngestConfig = {
  minBatchSize: 3,
  recentCommitAge: "7d",
  importantTypes: ["feat", "fix", "refactor", "breaking"],
  ignorePatterns: ["chore: update deps", "docs: typos"],
  includePatterns: ["src/**", "lib/**", "packages/*/src/**"],
  excludePatterns: ["node_modules", "dist", ".git", "coverage", ".codebase-wiki"],
};

export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  autoIngest: false,
  ingestOnStart: false,
  stalenessCheckInterval: "1h",
  maxContextPages: 5,
  commitBatchSize: 3,
  importantCommitTypes: ["feat", "fix", "refactor", "breaking"],
  excludeCommitPatterns: ["chore: update deps", "docs: typos"],
  wikiDir: DEFAULT_WIKI_DIR,
};

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Generate a unique ID
 */
export function generateId(prefix: string = ""): string {
  console.assert(typeof prefix === "string", "prefix must be string");
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Validate slug format (kebab-case)
 */
export function validateSlug(slug: string): boolean {
  console.assert(typeof slug === "string", "slug must be string");
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug);
}

/**
 * Convert text to kebab-case slug
 */
export function toSlug(text: string): string {
  console.assert(typeof text === "string", "text must be string");
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unnamed";  // fallback for empty slugs
}

/**
 * Parse conventional commit message
 */
export function parseCommitMessage(message: string): { type: string; scope: string; description: string; body: string; footer: string; isBreaking: boolean } {
  console.assert(message !== null, "message must not be null");

  const regex =/^(\w+)(?:\(([^)]+)\))?(!?): (.+?)(?:\n\n([\s\S]*?))?(?:\n\n([\s\S]*))?$/;
  const match = message.match(regex);

  if (!match) {
    return { type: "", scope: "", description: message.trim(), body: "", footer: "", isBreaking: false };
  }

  const [, type, scope, breaking, description, body, footer] = match;
  return {
    type: type || "",
    scope: scope || "",
    description: description || "",
    body: body || "",
    footer: footer || "",
    isBreaking: breaking === "!",
  };
}

/**
 * Check if a commit should be ingested (not noise)
 */
export function isIngestibleCommit(commit: GitCommit, config: IngestConfig): boolean {
  console.assert(commit !== null, "commit must not be null");
  console.assert(config !== null, "config must not be null");

  // Skip merge commits
  if (commit.subject.startsWith("Merge") || commit.subject.startsWith("merge")) {
    return false;
  }

  // Skip ignored patterns
  for (const pattern of config.ignorePatterns) {
    if (commit.subject.toLowerCase().startsWith(pattern.toLowerCase())) {
      return false;
    }
  }

  // Important types always ingested
  if (config.importantTypes.includes(commit.type)) {
    return true;
  }

  // Everything else: subject to batch size
  return true;
}

/**
 * Format date for wiki pages
 */
export function formatWikiDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  console.assert(d instanceof Date && !isNaN(d.getTime()), "invalid date");
  return d.toISOString().split("T")[0]!;
}

/**
 * Estimate token count (rough: ~4 chars per token)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Safely read file, returning null on error
 */
export function safeReadFile(path: string): string | null {
  try {
    const { readFileSync } = require("fs");
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Check if path matches any glob pattern (simple prefix matching)
 */
export function matchesPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const prefix = pattern.replace(/\/?\*\*?\/?/g, "/");
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}