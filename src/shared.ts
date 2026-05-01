/**
 * pi-codebase-wiki Shared Types & Utilities
 *
 * Common types, constants, and utility functions for the codebase wiki system.
 * Follows NASA-10 coding rules: small functions, minimal scope, validation.
 *
 * v2: PageType is now a string (configurable via PageTypeConfig).
 * Source manifests track arbitrary content, not just git.
 */

import * as fs from "fs";

// ============================================================================
// TYPES
// ============================================================================

/** Wiki page type — now configurable, not a fixed union */
export type PageType = string;

/** Built-in page types for backward compatibility */
export const BUILTIN_PAGE_TYPES: string[] = [
  "entity", "concept", "decision", "evolution", "comparison",
  "query", "changelog", "index", "schema",
] as const;

/** Page type configuration — defines directories, templates, and validation */
export interface PageTypeConfig {
  id: string;                    // kebab-case type ID (e.g., "entity", "person", "chapter")
  name: string;                  // Display name (e.g., "Entity", "Person", "Chapter")
  directory: string;             // Subdirectory under wiki root (e.g., "entities", "people")
  template: string;              // Template filename in templates/ (e.g., "entity.md")
  requiredSections: string[];    // Sections that must exist on pages of this type
  sourceTypes?: SourceType[];    // Which source types can create this page type
  icon?: string;                 // Emoji for UI display
}

/** Source type — Phase 3: used by /wiki-ingest --source article/note/conversation */
export type SourceType =
  | "git-commits"         // Batch of git commits (existing)
  | "article"             // Web article, PDF, blog post
  | "note"                // Personal note, journal entry
  | "conversation"        // Chat transcript, meeting notes
  | "document"            // README, spec, design doc
  | "url"                 // Fetched web resource
  | "media"               // Image, diagram, video transcript
  | "manual";             // Manual entry by user

/** Legacy IngestSourceType — maps to new SourceType for backward compat */
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

/** Source manifest — tracks an ingested raw source */
export interface SourceManifest {
  id: string;                     // UUID
  type: SourceType;               // What kind of source
  title: string;                  // Human-readable title
  path: string;                   // Relative to .codebase-wiki/sources/
  hash: string;                   // SHA-256 of file contents (immutability check)
  ingestedAt: string;             // ISO timestamp
  pagesCreated: string[];         // Page IDs created/updated from this source
  metadata: Record<string, any>; // Type-specific metadata
}

/** Wiki page record */
export interface WikiPage {
  id: string;                     // kebab-case slug
  path: string;                   // relative path from wiki root
  type: PageType;
  title: string;
  summary: string;                 // first paragraph
  sourceFiles: string[];          // source file paths this page derives from
  sourceCommits: string[];        // commit hashes this page derives from
  sourceIds?: string[];           // references to SourceManifest IDs
  lastIngested: string;           // ISO timestamp
  lastChecked: string;            // last staleness check
  inboundLinks: number;
  outboundLinks: number;
  stale: boolean;
  metadata?: Record<string, any>; // extensible metadata from frontmatter
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

/** Ingestion workflow mode — Phase 5: confirmation/guided mode */
export type IngestionMode = "auto" | "confirm" | "guided";

/** Ingestion confirmation thresholds — Phase 5: confirmation/guided mode */
export interface IngestionThresholds {
  newPageCreation: boolean;           // Ask before creating new pages (default: false)
  pageDeletion: boolean;              // Ask before deleting/merging pages (default: true)
  contradictionResolution: boolean;  // Ask before resolving contradictions (default: true)
  crossReferenceUpdate: boolean;     // Ask for cross-ref updates (default: false)
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
  domain: string;                // default: "codebase"
  pageTypes: PageTypeConfig[];   // default: DEFAULT_PAGE_TYPES
  ingestionMode: IngestionMode;  // default: "auto"
  ingestionThresholds: IngestionThresholds; // default: auto (no confirmations)
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

/** Default page type configurations for codebase wikis */
export const DEFAULT_PAGE_TYPES: PageTypeConfig[] = [
  { id: "entity",    name: "Entity",    directory: "entities",   template: "entity.md",    requiredSections: ["Summary", "See Also"], sourceTypes: ["git-commits", "document"], icon: "📦" },
  { id: "concept",   name: "Concept",   directory: "concepts",   template: "concept.md",   requiredSections: ["Summary", "See Also"], sourceTypes: ["article", "note", "conversation"], icon: "💡" },
  { id: "decision",  name: "Decision",  directory: "decisions",  template: "decision.md",  requiredSections: ["Context", "Decision", "Consequences"], sourceTypes: ["git-commits", "conversation", "manual"], icon: "⚖️" },
  { id: "evolution", name: "Evolution", directory: "evolution",   template: "evolution.md", requiredSections: ["Timeline", "Current State"], sourceTypes: ["git-commits"], icon: "📈" },
  { id: "comparison",name: "Comparison",directory: "comparisons", template: "comparison.md",requiredSections: ["Comparison", "Recommendation"], sourceTypes: ["article", "note"], icon: "📊" },
  { id: "query",    name: "Query",     directory: "queries",    template: "query.md",     requiredSections: ["Matched Pages"], sourceTypes: ["manual"], icon: "🔍" },
  { id: "changelog", name: "Changelog", directory: "",           template: "",            requiredSections: [], icon: "📋" },
  { id: "index",    name: "Index",     directory: "",           template: "",            requiredSections: [], icon: "📖" },
  { id: "schema",   name: "Schema",    directory: "",           template: "",            requiredSections: [], icon: "📜" },
];

/** Domain preset page type configurations — Phase 3: used by /wiki-init --preset */
export const DOMAIN_PRESETS: Record<string, { name: string; description: string; pageTypes: PageTypeConfig[]; sourceTypes: SourceType[] }> = {
  codebase: {
    name: "Codebase",
    description: "Software project knowledge base (default)",
    pageTypes: DEFAULT_PAGE_TYPES,
    sourceTypes: ["git-commits", "document", "url"],
  },
  personal: {
    name: "Personal",
    description: "Personal knowledge base — goals, notes, insights",
    pageTypes: [
      { id: "person",   name: "Person",   directory: "people",     template: "person.md",    requiredSections: ["Summary", "See Also"], sourceTypes: ["note", "conversation"], icon: "👤" },
      { id: "topic",    name: "Topic",    directory: "topics",      template: "topic.md",     requiredSections: ["Summary", "Key Ideas"], sourceTypes: ["article", "note", "url"], icon: "💡" },
      { id: "insight",  name: "Insight",  directory: "insights",    template: "insight.md",   requiredSections: ["Summary", "Connections"], sourceTypes: ["note", "conversation"], icon: "⚡" },
      { id: "media",    name: "Media",    directory: "media",       template: "media.md",    requiredSections: ["Summary", "Takeaways"], sourceTypes: ["url", "media"], icon: "🎬" },
      { id: "habit",    name: "Habit",    directory: "habits",       template: "habit.md",     requiredSections: ["Summary", "Tracking"], sourceTypes: ["note", "manual"], icon: "🔄" },
    ],
    sourceTypes: ["note", "article", "conversation", "url", "media", "manual"],
  },
  research: {
    name: "Research",
    description: "Research paper and topic knowledge base",
    pageTypes: [
      { id: "paper",    name: "Paper",    directory: "papers",      template: "paper.md",     requiredSections: ["Summary", "Key Findings"], sourceTypes: ["url", "document"], icon: "📄" },
      { id: "concept",   name: "Concept",   directory: "concepts",   template: "concept.md",   requiredSections: ["Summary", "See Also"], sourceTypes: ["article", "note"], icon: "💡" },
      { id: "finding",  name: "Finding",  directory: "findings",   template: "finding.md",   requiredSections: ["Summary", "Evidence"], sourceTypes: ["article", "note"], icon: "🔬" },
      { id: "method",    name: "Method",    directory: "methods",    template: "method.md",    requiredSections: ["Summary", "Steps"], sourceTypes: ["document", "note"], icon: "🧪" },
      { id: "comparison",name: "Comparison",directory: "comparisons", template: "comparison.md",requiredSections: ["Comparison", "Recommendation"], sourceTypes: ["article", "note"], icon: "📊" },
    ],
    sourceTypes: ["article", "document", "url", "note"],
  },
  book: {
    name: "Book",
    description: "Book reading companion — characters, themes, chapters",
    pageTypes: [
      { id: "character", name: "Character", directory: "characters", template: "character.md", requiredSections: ["Summary", "Arc"], sourceTypes: ["note", "manual"], icon: "🧑" },
      { id: "theme",     name: "Theme",     directory: "themes",     template: "theme.md",      requiredSections: ["Summary", "Examples"], sourceTypes: ["note", "manual"], icon: "🎯" },
      { id: "chapter",   name: "Chapter",  directory: "chapters",  template: "chapter.md",    requiredSections: ["Summary", "Key Events"], sourceTypes: ["note", "manual"], icon: "📖" },
      { id: "location",  name: "Location",  directory: "locations",  template: "location.md",   requiredSections: ["Summary", "Significance"], sourceTypes: ["note", "manual"], icon: "📍" },
      { id: "quote",     name: "Quote",     directory: "quotes",     template: "quote.md",      requiredSections: ["Quote", "Context"], sourceTypes: ["note", "manual"], icon: "💬" },
    ],
    sourceTypes: ["note", "manual", "url"],
  },
};

/**
 * Get the directory for a page type from config.
 * Falls back to DEFAULT_PAGE_TYPES if config is not loaded.
 */
export function getDirectoryForPageType(type: string, pageTypes?: PageTypeConfig[]): string {
  const configs = pageTypes ?? DEFAULT_PAGE_TYPES;
  const config = configs.find(pt => pt.id === type);
  return config?.directory ?? type + "s"; // fallback: entity → entities
}

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
  domain: "codebase",
  pageTypes: DEFAULT_PAGE_TYPES,
  ingestionMode: "auto",
  ingestionThresholds: {
    newPageCreation: false,
    pageDeletion: true,
    contradictionResolution: true,
    crossReferenceUpdate: false,
  },
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
export function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
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