/**
 * Source Ingestion Module — arbitrary content ingestion for the LLM Wiki.
 *
 * Handles storing and processing any type of source content
 * (articles, notes, conversations, URLs, etc.) — not just git commits.
 *
 * Phase 1 of the v2 general-purpose LLM Wiki spec.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { SourceManifest, SourceType, PageTypeConfig } from "../shared.js";
import { DEFAULT_PAGE_TYPES, getDirectoryForPageType, toSlug, formatWikiDate } from "../shared.js";
import type { WikiStore } from "../core/store.js";
import { serializeFrontmatter, stripFrontmatter } from "../core/frontmatter.js";

// ============================================================================
// TYPES
// ============================================================================

export interface IngestSourceResult {
  manifestId: string;
  sourcePath: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  errors: string[];
}

export interface IngestUrlResult {
  manifestId: string;
  sourcePath: string;
  title: string;
  contentLength: number;
  pagesCreated: string[];
  pagesUpdated: string[];
  errors: string[];
}

// ============================================================================
// SOURCE STORAGE
// ============================================================================

/**
 * Generate a unique source ID
 */
export function generateSourceId(type: SourceType, title: string): string {
  const slug = toSlug(title).slice(0, 40);
  const hash = crypto.randomBytes(4).toString("hex");
  return `src-${type}-${slug}-${hash}`;
}

/**
 * Compute SHA-256 hash of content
 */
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Determine file extension from source type
 */
function getExtensionForType(type: SourceType): string {
  const extensions: Record<string, string> = {
    "git-commits": "json",
    article: "md",
    note: "md",
    conversation: "md",
    document: "md",
    url: "md",
    media: "md",
    manual: "md",
  };
  return extensions[type] ?? "md";
}

/**
 * Store a source in the wiki sources directory and create a manifest.
 */
export function storeSource(
  wikiPath: string,
  type: SourceType,
  title: string,
  content: string,
  store: WikiStore,
  metadata: Record<string, any> = {}
): SourceManifest {
  const id = generateSourceId(type, title);
  const ext = getExtensionForType(type);
  const dir = path.join(wikiPath, "sources", type);
  const fileName = `${id}.${ext}`;
  const filePath = path.join(dir, fileName);
  const relativePath = `sources/${type}/${fileName}`;

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  // Compute hash before writing
  const hash = computeHash(content);

  // Check for duplicate (same hash = same content already stored)
  const existingSources = store.getSources(type);
  const duplicate = existingSources.find(s => s.hash === hash);
  if (duplicate) {
    // Return existing manifest — don't store duplicate
    return store.getSource(duplicate.id)!;
  }

  // Write source content
  fs.writeFileSync(filePath, content, "utf-8");

  // Create and store manifest
  const manifest: SourceManifest = {
    id,
    type,
    title,
    path: relativePath,
    hash,
    ingestedAt: new Date().toISOString(),
    pagesCreated: [],
    metadata,
  };

  store.addSource(manifest);

  return manifest;
}

// ============================================================================
// SOURCE INGESTION PIPELINE
// ============================================================================

/**
 * Ingest an arbitrary source into the wiki.
 *
 * This stores the source content, creates a manifest, and generates
 * an enrichment prompt for the LLM agent. The agent then creates/updates
 * wiki pages based on the source content.
 */
export function ingestSource(
  wikiPath: string,
  rootDir: string,
  type: SourceType,
  title: string,
  content: string,
  store: WikiStore,
  options: {
    url?: string;
    filePath?: string;
    metadata?: Record<string, any>;
    pageType?: string;
    updateExisting?: string[];
  } = {}
): IngestSourceResult {
  const result: IngestSourceResult = {
    manifestId: "",
    sourcePath: "",
    pagesCreated: [],
    pagesUpdated: [],
    errors: [],
  };

  try {
    // Store source and create manifest
    const metadata = { ...options.metadata };
    if (options.url) metadata.url = options.url;
    if (options.filePath) metadata.filePath = options.filePath;

    const manifest = storeSource(wikiPath, type, title, content, store, metadata);
    result.manifestId = manifest.id;
    result.sourcePath = manifest.path;

    // If updateExisting pages are specified, mark them for update
    if (options.updateExisting) {
      for (const pageId of options.updateExisting) {
        const page = store.getPage(pageId);
        if (page) {
          page.sourceIds = [...(page.sourceIds ?? []), manifest.id];
          page.lastIngested = new Date().toISOString();
          store.upsertPage(page);
          result.pagesUpdated.push(pageId);
        }
      }
    }

    // Create a source summary page in the wiki
    const summaryPageId = createSourceSummaryPage(
      wikiPath,
      manifest,
      content,
      store,
      options.pageType
    );
    if (summaryPageId) {
      result.pagesCreated.push(summaryPageId);
      manifest.pagesCreated.push(summaryPageId);
    }

    // Update manifest with created pages
    store.addSource(manifest);

    // Append to structured log
    appendSourceToLog(wikiPath, manifest, result);

  } catch (err) {
    result.errors.push(`Source ingestion failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Ingest a URL by fetching its content and storing it as a source.
 */
export async function ingestUrl(
  wikiPath: string,
  rootDir: string,
  url: string,
  store: WikiStore,
  options: {
    title?: string;
    pageType?: string;
  } = {}
): Promise<IngestUrlResult> {
  const result: IngestUrlResult = {
    manifestId: "",
    sourcePath: "",
    title: "",
    contentLength: 0,
    pagesCreated: [],
    pagesUpdated: [],
    errors: [],
  };

  try {
    // Fetch the URL content
    let content: string;
    let pageTitle: string;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const html = await response.text();
      content = extractReadableContent(html);
      pageTitle = options.title || extractTitle(html) || new URL(url).hostname;
    } catch (fetchErr) {
      // If fetch fails, create a stub source with the URL reference
      content = `[Source URL](${url})\n\nContent could not be fetched.\nURL: ${url}\nFetched: ${new Date().toISOString()}`;
      pageTitle = options.title || new URL(url).hostname;
    }

    result.title = pageTitle;
    result.contentLength = content.length;

    // Ingest as a URL source
    const ingestResult = ingestSource(
      wikiPath,
      rootDir,
      "url",
      pageTitle,
      content,
      store,
      {
        url,
        pageType: options.pageType,
        metadata: { url, fetchedAt: new Date().toISOString() },
      }
    );

    result.manifestId = ingestResult.manifestId;
    result.sourcePath = ingestResult.sourcePath;
    result.pagesCreated = ingestResult.pagesCreated;
    result.pagesUpdated = ingestResult.pagesUpdated;
    result.errors = ingestResult.errors;

  } catch (err) {
    result.errors.push(`URL ingestion failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ============================================================================
// SOURCE SUMMARY PAGE GENERATION
// ============================================================================

/**
 * Create a wiki page summarizing an ingested source.
 * This is the "compiled knowledge" from the source — the LLM will later enrich it.
 */
function createSourceSummaryPage(
  wikiPath: string,
  manifest: SourceManifest,
  content: string,
  store: WikiStore,
  pageType?: string
): string | null {
  const slug = toSlug(manifest.title);
  const type = pageType || inferPageTypeFromSource(manifest.type);
  const dir = getDirectoryForPageType(type);

  if (!dir) {
    // Skip pages for types without directories (index, schema, changelog)
    return null;
  }

  const dirPath = path.join(wikiPath, dir);
  fs.mkdirSync(dirPath, { recursive: true });

  const filePath = path.join(dirPath, `${slug}.md`);
  const today = formatWikiDate(new Date());

  // Truncate content for the summary
  const contentPreview = content.length > 500
    ? content.slice(0, 500) + "..."
    : content;

  // Build frontmatter
  const frontmatter: Record<string, any> = {
    id: slug,
    type,
    title: manifest.title,
    sources: [manifest.id],
    created: today,
    updated: today,
    stale: false,
  };

  if (manifest.metadata?.url) {
    frontmatter.url = manifest.metadata.url;
  }

  // Build page content
  const lines: string[] = [
    `# ${manifest.title}`,
    "",
    `> **Summary**: ${manifest.type === "url" ? `Source: [${manifest.title}](${manifest.metadata?.url ?? "#"})` : `Ingested from ${manifest.type}`}`,
    "",
    "## Source",
    "",
    `- **Type**: ${manifest.type}`,
    `- **Ingested**: ${today}`,
  ];

  if (manifest.metadata?.url) {
    lines.push(`- **URL**: [${manifest.metadata.url}](${manifest.metadata.url})`);
  }

  lines.push(
    `- **Manifest ID**: \`${manifest.id}\``,
    "",
    "## Content Preview",
    "",
    contentPreview,
    "",
    "## Key Points",
    "",
    "- *(to be expanded through analysis)*",
    "",
    "## See Also",
    "- [[index]]",
    "",
    "---",
    `*Ingested: ${today} · Source: ${manifest.id}*`
  );

  const pageContent = serializeFrontmatter(frontmatter, lines.join("\n"));
  fs.writeFileSync(filePath, pageContent, "utf-8");

  // Register in store
  store.upsertPage({
    id: slug,
    path: `${dir}/${slug}.md`,
    type,
    title: manifest.title,
    summary: `${manifest.type} source: ${manifest.title}`,
    sourceFiles: [],
    sourceCommits: [],
    sourceIds: [manifest.id],
    lastIngested: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    inboundLinks: 0,
    outboundLinks: 0,
    stale: false,
    metadata: frontmatter,
  });

  // Add cross-reference from index
  store.addCrossReference("index", slug, `Source: ${manifest.title}`);

  return slug;
}

// ============================================================================
// CONTENT EXTRACTION HELPERS
// ============================================================================

/**
 * Extract readable content from HTML.
 * Strips tags, removes scripts/styles, collapses whitespace.
 */
function extractReadableContent(html: string): string {
  let content = html;

  // Remove script and style blocks
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  // Remove HTML tags
  content = content.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  content = content.replace(/&amp;/g, "&");
  content = content.replace(/&lt;/g, "<");
  content = content.replace(/&gt;/g, ">");
  content = content.replace(/&quot;/g, '"');
  content = content.replace(/&#39;/g, "'");
  content = content.replace(/&nbsp;/g, " ");

  // Collapse whitespace
  content = content.replace(/\s+/g, " ").trim();

  return content;
}

/**
 * Extract the title from HTML content.
 */
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1]!.trim() : null;
}

/**
 * Infer the best wiki page type from a source type.
 */
function inferPageTypeFromSource(sourceType: SourceType): string {
  const mapping: Record<string, string> = {
    "git-commits": "entity",
    article: "concept",
    note: "concept",
    conversation: "concept",
    document: "concept",
    url: "concept",
    media: "concept",
    manual: "concept",
  };
  return mapping[sourceType] ?? "concept";
}

// ============================================================================
// STRUCTURED LOG
// ============================================================================
// STRUCTURED LOG — Re-exports from central log module
// ============================================================================

export type { LogEntry } from "./log.js";

/**
 * Append a source ingestion entry to the structured LOG.md
 */
function appendSourceToLog(
  wikiPath: string,
  manifest: SourceManifest,
  result: IngestSourceResult
): void {
  // Import dynamically to avoid circular dependency at module level
  const { appendToLog } = require("./log.js") as typeof import("./log.js");
  const entry: import("./log.js").LogEntry = {
    timestamp: manifest.ingestedAt,
    type: "ingest",
    source: manifest.type,
    title: manifest.title,
    sourceManifestId: manifest.id,
    pagesCreated: result.pagesCreated,
    pagesUpdated: result.pagesUpdated,
  };

  appendToLog(wikiPath, entry);
}

// ============================================================================

/**
 * Append a structured log entry to LOG.md
 */

// (Log functions centralized in ./log.ts — import from there)

// ============================================================================

/**
 * Create a source manifest for a git commit ingest.
 * Called by ingestCommits after processing.
 */
export function createGitSourceManifest(
  wikiPath: string,
  store: WikiStore,
  commitRange: string,
  pagesCreated: string[],
  pagesUpdated: string[]
): SourceManifest | null {
  const id = generateSourceId("git-commits", commitRange);
  const title = `Git commits: ${commitRange}`;

  // Create a JSON manifest file with commit info
  const manifestContent = JSON.stringify({
    type: "git-commits",
    range: commitRange,
    pagesCreated,
    pagesUpdated,
    ingestedAt: new Date().toISOString(),
  }, null, 2);

  const dir = path.join(wikiPath, "sources", "git-commits");
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${id}.json`);
  const relativePath = `sources/git-commits/${id}.json`;
  const hash = computeHash(manifestContent);

  // Write manifest file
  fs.writeFileSync(filePath, manifestContent, "utf-8");

  const manifest: SourceManifest = {
    id,
    type: "git-commits",
    title,
    path: relativePath,
    hash,
    ingestedAt: new Date().toISOString(),
    pagesCreated,
    metadata: {
      commitRange,
      pagesCreatedCount: pagesCreated.length,
      pagesUpdatedCount: pagesUpdated.length,
    },
  };

  store.addSource(manifest);
  return manifest;
}