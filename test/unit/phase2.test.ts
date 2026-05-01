/**
 * Structured Log & Frontmatter Integration Tests
 *
 * Tests: centralized log append/parse, log filtering by type and date,
 * frontmatter round-trip on query pages, structured format grep-parseability.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  appendToLog,
  appendLegacyLog,
  parseLog,
  getRecentLog,
  getLogByType,
  getLogSince,
} from "../../src/operations/log.js";
import type { LogEntry } from "../../src/operations/log.js";
import { serializeFrontmatter, parseFrontmatter, stripFrontmatter } from "../../src/core/frontmatter.js";

let tmpDir: string;
let wikiPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-p2-"));
  wikiPath = path.join(tmpDir, ".codebase-wiki");
  fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });
  fs.mkdirSync(path.join(wikiPath, "entities"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── LOG APPEND & PARSE ──────────────────────────────────────────────────────

describe("appendToLog writes structured entries to LOG.md", () => {
  test("creates LOG.md with structured format on first write", () => {
    appendToLog(wikiPath, {
      timestamp: "2026-05-01T10:00:00.000Z",
      type: "ingest",
      source: "git-commits",
      title: "3 commits processed",
      pagesCreated: ["auth-module"],
      pagesUpdated: ["api-gateway"],
      details: "3 created, 1 updated, 12 files",
    });

    const logPath = path.join(wikiPath, "meta", "LOG.md");
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("## [2026-05-01T10:00:00.000Z] ingest | git-commits | 3 commits processed");
    expect(content).toContain("[[auth-module]]");
    expect(content).toContain("[[api-gateway]]");
    expect(content).toContain("3 created, 1 updated, 12 files");
  });

  test("appends multiple entries preserving order", () => {
    appendToLog(wikiPath, {
      timestamp: "2026-05-01T10:00:00.000Z",
      type: "ingest",
      source: "git-commits",
      title: "First ingest",
      pagesCreated: [],
      pagesUpdated: [],
    });

    appendToLog(wikiPath, {
      timestamp: "2026-05-01T11:00:00.000Z",
      type: "query",
      source: "wiki_query",
      title: "How does auth work?",
      pagesCreated: ["how-does-auth-work"],
      pagesUpdated: [],
    });

    const entries = parseLog(wikiPath);
    expect(entries.length).toBe(2);
    expect(entries[0]!.type).toBe("ingest");
    expect(entries[1]!.type).toBe("query");
    expect(entries[1]!.pagesCreated).toEqual(["how-does-auth-work"]);
  });

  test("preserves sourceManifestId in entries", () => {
    appendToLog(wikiPath, {
      timestamp: "2026-05-01T10:00:00.000Z",
      type: "ingest",
      source: "articles",
      title: "Ingested article",
      sourceManifestId: "src-articles-abc123",
      pagesCreated: ["my-article"],
      pagesUpdated: [],
    });

    const entries = parseLog(wikiPath);
    expect(entries.length).toBe(1);
    expect(entries[0]!.sourceManifestId).toBe("src-articles-abc123");
  });
});

describe("parseLog reads structured entries from LOG.md", () => {
  test("returns empty array when LOG.md does not exist", () => {
    const entries = parseLog(wikiPath);
    expect(entries).toEqual([]);
  });

  test("round-trips a full entry with all fields", () => {
    const entry: LogEntry = {
      timestamp: "2026-05-01T14:30:00.000Z",
      type: "query",
      source: "wiki_query",
      title: "How does caching work?",
      pagesCreated: ["caching-query"],
      pagesUpdated: ["cache-module"],
      details: "2 matches, filed as [[caching-query]]",
    };

    appendToLog(wikiPath, entry);
    const parsed = parseLog(wikiPath);

    expect(parsed.length).toBe(1);
    expect(parsed[0]!.timestamp).toBe(entry.timestamp);
    expect(parsed[0]!.type).toBe(entry.type);
    expect(parsed[0]!.source).toBe(entry.source);
    expect(parsed[0]!.title).toBe(entry.title);
    expect(parsed[0]!.pagesCreated).toEqual(entry.pagesCreated);
    expect(parsed[0]!.pagesUpdated).toEqual(entry.pagesUpdated);
    expect(parsed[0]!.details).toBe(entry.details);
  });

  test("round-trips an entry with contradictions", () => {
    const entry: LogEntry = {
      timestamp: "2026-05-01T14:30:00.000Z",
      type: "lint",
      source: "wiki_lint",
      title: "Contradiction detected: auth approach",
      pagesCreated: [],
      pagesUpdated: [],
      contradictions: ["auth-approach-v1 vs auth-approach-v2"],
    };

    appendToLog(wikiPath, entry);
    const parsed = parseLog(wikiPath);

    expect(parsed[0]!.contradictions).toEqual(["auth-approach-v1 vs auth-approach-v2"]);
  });

  test("log entries match grep-parseable pattern", () => {
    appendToLog(wikiPath, {
      timestamp: "2026-05-01T10:00:00.000Z",
      type: "ingest",
      source: "git-commits",
      title: "5 commits processed",
      pagesCreated: ["auth"],
      pagesUpdated: ["api"],
    });

    const logPath = path.join(wikiPath, "meta", "LOG.md");
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n");

    const structured = lines.filter(l => l.startsWith("## [") && l.includes("ingest"));
    expect(structured.length).toBe(1);

    const pattern = /^## \[[^\]]+\]\s+\w+\s*\|\s*\w[\w-]*\s*\|\s*.+$/;
    expect(pattern.test(structured[0]!)).toBe(true);
  });
});

describe("appendLegacyLog bridges old callers to structured format", () => {
  test("creates structured entry from legacy source/ref/counts format", () => {
    appendLegacyLog(wikiPath, "commit", "abc..def", 3, 1);

    const entries = parseLog(wikiPath);
    expect(entries.length).toBe(1);
    expect(entries[0]!.type).toBe("ingest");
    expect(entries[0]!.source).toBe("commit");
    expect(entries[0]!.title).toBe("abc..def");
    expect(entries[0]!.details).toContain("3 pages created");
    expect(entries[0]!.details).toContain("1 pages updated");
  });
});

// ─── LOG FILTERING ───────────────────────────────────────────────────────────

describe("getLogByType filters entries by operation type", () => {
  beforeEach(() => {
    appendToLog(wikiPath, {
      timestamp: "2026-04-28T10:00:00.000Z", type: "ingest", source: "git", title: "Old ingest",
      pagesCreated: [], pagesUpdated: [],
    });
    appendToLog(wikiPath, {
      timestamp: "2026-04-30T10:00:00.000Z", type: "query", source: "wiki_query", title: "Old query",
      pagesCreated: [], pagesUpdated: [],
    });
    appendToLog(wikiPath, {
      timestamp: "2026-05-01T10:00:00.000Z", type: "ingest", source: "git", title: "New ingest",
      pagesCreated: [], pagesUpdated: [],
    });
  });

  test("returns only entries matching the type", () => {
    const ingests = getLogByType(wikiPath, "ingest");
    expect(ingests.length).toBe(2);
    expect(ingests.every(e => e.type === "ingest")).toBe(true);
  });

  test("returns empty for a type with no entries", () => {
    const results = getLogByType(wikiPath, "resolve");
    expect(results).toEqual([]);
  });
});

describe("getLogSince filters entries by date threshold", () => {
  beforeEach(() => {
    appendToLog(wikiPath, {
      timestamp: "2026-04-28T10:00:00.000Z", type: "ingest", source: "git", title: "Old ingest",
      pagesCreated: [], pagesUpdated: [],
    });
    appendToLog(wikiPath, {
      timestamp: "2026-04-30T10:00:00.000Z", type: "query", source: "wiki_query", title: "Old query",
      pagesCreated: [], pagesUpdated: [],
    });
    appendToLog(wikiPath, {
      timestamp: "2026-05-01T10:00:00.000Z", type: "ingest", source: "git", title: "New ingest",
      pagesCreated: [], pagesUpdated: [],
    });
  });

  test("returns only entries on or after the given date", () => {
    const recent = getLogSince(wikiPath, "2026-05-01");
    expect(recent.length).toBe(1);
    expect(recent[0]!.title).toBe("New ingest");
  });

  test("returns all entries for a very early date", () => {
    const all = getLogSince(wikiPath, "2020-01-01");
    expect(all.length).toBe(3);
  });
});

describe("getRecentLog returns last N entries", () => {
  beforeEach(() => {
    appendToLog(wikiPath, {
      timestamp: "2026-04-28T10:00:00.000Z", type: "ingest", source: "git", title: "First",
      pagesCreated: [], pagesUpdated: [],
    });
    appendToLog(wikiPath, {
      timestamp: "2026-04-30T10:00:00.000Z", type: "ingest", source: "git", title: "Second",
      pagesCreated: [], pagesUpdated: [],
    });
    appendToLog(wikiPath, {
      timestamp: "2026-05-01T10:00:00.000Z", type: "ingest", source: "git", title: "Third",
      pagesCreated: [], pagesUpdated: [],
    });
  });

  test("returns the most recent N entries", () => {
    const recent = getRecentLog(wikiPath, 2);
    expect(recent.length).toBe(2);
  });

  test("returns all entries if fewer than requested count", () => {
    const recent = getRecentLog(wikiPath, 10);
    expect(recent.length).toBe(3);
  });
});

// ─── FRONTMATTER ON QUERY PAGES ──────────────────────────────────────────────

describe("frontmatter serialization produces valid YAML for query pages", () => {
  test("serializes metadata and body into frontmatter + markdown", () => {
    const meta = {
      id: "auth-architecture",
      type: "query",
      title: "How does auth work?",
      filed: "2026-05-01",
      matches: ["auth-module", "api-gateway"],
    };

    const content = serializeFrontmatter(meta, "# How does auth work?\n\nBody text");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("id: auth-architecture");
    expect(content).toContain("type: query");
    expect(content).toContain("# How does auth work?");
  });

  test("includes sources field when sourceIds are present", () => {
    const meta = {
      id: "query-with-sources",
      type: "query",
      title: "What sources discuss auth?",
      filed: "2026-05-01",
      matches: ["auth-module"],
      sources: ["src-articles-abc", "src-urls-def"],
    };

    const content = serializeFrontmatter(meta, "# What sources discuss auth?");
    expect(content).toContain("sources:");
    expect(content).toContain("src-articles-abc");
  });
});

describe("frontmatter round-trips through serialize then parse", () => {
  test("preserves all metadata fields and body", () => {
    const meta = {
      id: "test-page",
      type: "query",
      title: "Test",
      matches: ["a", "b"],
    };

    const content = serializeFrontmatter(meta, "# Test\n\nBody");
    const { metadata, body } = parseFrontmatter(content);

    expect(metadata.id).toBe("test-page");
    expect(metadata.type).toBe("query");
    expect(metadata.matches).toEqual(["a", "b"]);
    expect(body).toContain("# Test");
    expect(body).toContain("Body");
  });
});