/**
 * Log Module — Structured LOG.md management for the wiki.
 *
 * Manages the wiki's append-only log file in a structured, grep-parseable format.
 * Every wiki operation (ingest, query, lint, resolve, manual) appends an entry.
 *
 * Format: `## [ISO-timestamp] type | source | title`
 * Parseable with: `grep "^## \[" LOG.md | tail -5`
 *
 * Migrated from inline log writing in ingest.ts to a centralized module.
 */

import * as fs from "fs";
import * as path from "path";
import { formatWikiDate } from "../shared.js";

// ============================================================================
// LOG ENTRY TYPES
// ============================================================================

/**
 * Log entry format for the structured LOG.md
 */
export interface LogEntry {
  timestamp: string;
  type: "ingest" | "query" | "lint" | "resolve" | "manual";
  source: string;
  title: string;
  sourceManifestId?: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  contradictions?: string[];
  details?: string;
}


// ============================================================================
// APPEND TO LOG
// ============================================================================

/**
 * Append a structured log entry to LOG.md.
 * Creates the log file if it doesn't exist.
 * Uses the format: ## [ISO-timestamp] type | source | title
 */
export function appendToLog(wikiPath: string, entry: LogEntry): void {
  const logPath = path.join(wikiPath, "meta", "LOG.md");
  const today = entry.timestamp.split("T")[0] ?? formatWikiDate(new Date());
  const prefix = `## [${entry.timestamp}] ${entry.type} | ${entry.source} | ${entry.title}`;

  const lines: string[] = [
    prefix,
    "",
    `- **Source**: ${entry.source}${entry.sourceManifestId ? ` (\`${entry.sourceManifestId}\`)` : ""}`,
    `- **Pages created**: ${entry.pagesCreated.length > 0 ? entry.pagesCreated.map(p => `[[${p}]]`).join(", ") : "none"}`,
    `- **Pages updated**: ${entry.pagesUpdated.length > 0 ? entry.pagesUpdated.map(p => `[[${p}]]`).join(", ") : "none"}`,
  ];

  if (entry.contradictions && entry.contradictions.length > 0) {
    lines.push(`- **Contradictions**: ${entry.contradictions.join(", ")}`);
  }

  if (entry.details) {
    lines.push(`- **Details**: ${entry.details}`);
  }

  lines.push("");

  // Ensure meta directory exists
  fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });

  let content: string;
  if (fs.existsSync(logPath)) {
    content = fs.readFileSync(logPath, "utf-8");
    // Append at the end
    content = content.trimEnd() + "\n\n" + lines.join("\n") + "\n";
  } else {
    // Create new LOG.md with structured header
    content = generateInitialLog() + "\n" + lines.join("\n") + "\n";
  }

  fs.writeFileSync(logPath, content, "utf-8");
}

/**
 * Append a legacy-style log entry (for backward compatibility with old call sites).
 * Converts the old table-row format into a structured entry.
 */
export function appendLegacyLog(
  wikiPath: string,
  sourceType: string,
  sourceRef: string,
  pagesCreated: number,
  pagesUpdated: number
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    type: "ingest" as const,
    source: sourceType,
    title: sourceRef,
    pagesCreated: [], // Legacy callers only have counts, not IDs
    pagesUpdated: [],
    details: `${pagesCreated} pages created, ${pagesUpdated} pages updated`,
  };

  appendToLog(wikiPath, entry);
}

/**
 * Generate initial LOG.md content with header.
 */
function generateInitialLog(): string {
  const today = formatWikiDate(new Date());
  return `# Ingest Log

> Auto-maintained by pi-codebase-wiki. Parse recent entries with:
> \`grep "^## \[" .codebase-wiki/meta/LOG.md | tail -5\`

| Timestamp | Source | Ref | Pages Created | Pages Updated |
|-----------|--------|-----|---------------|----------------|
| - | - | - | - | - |

---
*Wiki initialized: ${today}*
`;
}

// ============================================================================
// PARSE LOG
// ============================================================================

/**
 * Parse structured log entries from LOG.md.
 */
export function parseLog(wikiPath: string): LogEntry[] {
  const logPath = path.join(wikiPath, "meta", "LOG.md");
  const entries: LogEntry[] = [];

  let content: string;
  try {
    content = fs.readFileSync(logPath, "utf-8");
  } catch {
    return entries;
  }

  const lines = content.split("\n");
  let currentEntry: Partial<LogEntry> | null = null;

  for (const line of lines) {
    // Match structured entry: ## [ISO-timestamp] type | source | title
    const match = line.match(/^## \[([^\]]+)\]\s+(\w+)\s*\|\s*(\w[\w-]*)\s*\|\s*(.+)$/);
    if (match) {
      if (currentEntry) {
        entries.push(currentEntry as LogEntry);
      }
      currentEntry = {
        timestamp: match[1]!,
        type: match[2]!.toLowerCase() as LogEntry["type"],
        source: match[3]!,
        title: match[4]!.trim(),
        pagesCreated: [],
        pagesUpdated: [],
      };
      continue;
    }

    // Parse list items within an entry
    if (currentEntry) {
      const createdMatch = line.match(/- \*\*Pages created\*\*: (.+)/);
      if (createdMatch) {
        currentEntry.pagesCreated = createdMatch[1]!
          .replace(/none/g, "")
          .split(/\[\[([^\]]+)\]\]/g)
          .filter((s: string, i: number) => i % 2 === 1);
      }

      const updatedMatch = line.match(/- \*\*Pages updated\*\*: (.+)/);
      if (updatedMatch) {
        currentEntry.pagesUpdated = updatedMatch[1]!
          .replace(/none/g, "")
          .split(/\[\[([^\]]+)\]\]/g)
          .filter((s: string, i: number) => i % 2 === 1);
      }

      const sourceMatch = line.match(/- \*\*Source\*\*: (\w[\w-]*)(?: \(`([^`]+)`\))?/);
      if (sourceMatch && sourceMatch[2]) {
        currentEntry.sourceManifestId = sourceMatch[2];
      }

      const contradictionMatch = line.match(/- \*\*Contradictions\*\*: (.+)/);
      if (contradictionMatch) {
        currentEntry.contradictions = contradictionMatch[1]!.split(", ").filter(Boolean);
      }

      const detailMatch = line.match(/- \*\*Details\*\*: (.+)/);
      if (detailMatch) {
        currentEntry.details = detailMatch[1]!;
      }
    }
  }

  // Push last entry
  if (currentEntry) {
    entries.push(currentEntry as LogEntry);
  }

  return entries;
}

/**
 * Get recent log entries (newest first).
 */
export function getRecentLog(wikiPath: string, count: number = 5): LogEntry[] {
  const entries = parseLog(wikiPath);
  return entries.slice(-count).reverse();
}

/**
 * Get log entries filtered by type.
 */
export function getLogByType(wikiPath: string, type: string): LogEntry[] {
  const entries = parseLog(wikiPath);
  return entries.filter(e => e.type === type);
}

/**
 * Get log entries since a given date.
 */
export function getLogSince(wikiPath: string, since: string): LogEntry[] {
  const entries = parseLog(wikiPath);
  const sinceDate = new Date(since).getTime();
  return entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
}