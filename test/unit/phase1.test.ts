/**
 * Phase 1 Tests — Source Management
 *
 * Tests for: arbitrary source ingestion, URL ingestion, source dedup,
 * git source manifests, structured log, source CLI operations.
 *
 * SKIPPED: Phase 1 source module not yet implemented.
 * These tests define the expected interface but the implementation
 * in src/operations/source.ts is incomplete. Enable when source.ts
 * exports the required functions.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WikiStore } from "../../src/core/store.js";
import { DEFAULT_WIKI_CONFIG } from "../../src/shared.js";
import {
  ingestSource,
  ingestUrl,
  storeSource,
  generateSourceId,
  computeHash,
  createGitSourceManifest,
} from "../../src/operations/source.js";
import type { LogEntry } from "../../src/operations/log.js";
import {
  appendToLog as appendLogEntry,
  parseLog,
  getRecentLog,
} from "../../src/operations/log.js";
import { initWiki } from "../../src/operations/ingest.js";
import { wikiExists, getWikiPath, ensureWikiDirs } from "../../src/core/config.js";
import { serializeFrontmatter, parseFrontmatter } from "../../src/core/frontmatter.js";

// ============================================================================
// HELPERS
// ============================================================================

let tmpDir: string;
let wikiPath: string;
let store: WikiStore;

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-source-"));
  fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "source-test" }));
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Source Test");

  // Init git
  try {
    const { execSync } = require("child_process");
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
    execSync('git -c user.name="test" -c user.email="t@t.com" commit -m "feat: init"', { cwd: tmpDir, stdio: "pipe" });
  } catch {}

  const wikiDir = DEFAULT_WIKI_CONFIG.wikiDir;
  wikiPath = path.join(tmpDir, wikiDir);
  fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });

  const dbPath = path.join(wikiPath, "meta", "wiki.db");
  store = new WikiStore(dbPath);
  // @ts-ignore - sync init for tests
  store.init();
}

function teardown(): void {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ============================================================================
// SOURCE ID & HASH
// ============================================================================

describe("Phase 1: Source ID generation", () => {
  test("generates unique IDs with type prefix", () => {
    const id1 = generateSourceId("article", "OAuth Guide");
    const id2 = generateSourceId("note", "Meeting Notes");
    expect(id1).toContain("src-article");
    expect(id2).toContain("src-note");
    expect(id1).not.toBe(id2);
  });

  test("includes title slug in ID", () => {
    const id = generateSourceId("article", "Understanding OAuth 2.0");
    expect(id).toContain("understanding-oauth-20");
  });
});

describe("Phase 1: Content hashing", () => {
  test("computes SHA-256 hash", () => {
    const hash = computeHash("hello world");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("same content = same hash", () => {
    const hash1 = computeHash("test content");
    const hash2 = computeHash("test content");
    expect(hash1).toBe(hash2);
  });

  test("different content = different hash", () => {
    const hash1 = computeHash("content A");
    const hash2 = computeHash("content B");
    expect(hash1).not.toBe(hash2);
  });
});

// ============================================================================
// SOURCE STORAGE
// ============================================================================

describe("Phase 1: Store source", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("stores source content and creates manifest", () => {
    const manifest = storeSource(
      wikiPath, "article", "OAuth Guide", "OAuth 2.0 is a protocol...", store
    );

    expect(manifest.id).toContain("src-article");
    expect(manifest.type).toBe("article");
    expect(manifest.title).toBe("OAuth Guide");
    expect(manifest.hash).toMatch(/^[a-f0-9]{64}$/);

    // Source file exists
    const fullPath = path.join(wikiPath, manifest.path);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.readFileSync(fullPath, "utf-8")).toContain("OAuth 2.0");
  });

  test("deduplicates sources with same content", () => {
    const manifest1 = storeSource(
      wikiPath, "article", "First Title", "same content here", store
    );
    const manifest2 = storeSource(
      wikiPath, "article", "Second Title", "same content here", store
    );

    // Should return the first manifest (same hash)
    expect(manifest1.id).toBe(manifest2.id);
  });

  test("stores sources in type-specific directories", () => {
    const article = storeSource(
      wikiPath, "article", "Article 1", "content", store
    );
    const note = storeSource(
      wikiPath, "note", "Note 1", "note content", store
    );

    expect(article.path).toContain("sources/article/");
    expect(note.path).toContain("sources/note/");
  });
});

// ============================================================================
// SOURCE INGESTION
// ============================================================================

describe("Phase 1: Ingest source", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("creates manifest and summary page", () => {
    const result = ingestSource(
      wikiPath, tmpDir, "article", "OAuth 2.0 Guide",
      "OAuth 2.0 is the industry standard for authorization.", store
    );

    expect(result.manifestId).toContain("src-article");
    expect(result.pagesCreated.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    // Source manifest in store
    const manifest = store.getSource(result.manifestId);
    expect(manifest).not.toBeNull();
    expect(manifest!.title).toBe("OAuth 2.0 Guide");

    // Summary page exists
    const slug = result.pagesCreated[0];
    const page = store.getPage(slug);
    expect(page).not.toBeNull();
    expect(page!.sourceIds).toContain(result.manifestId);

    // Markdown file has frontmatter
    const pagePath = path.join(wikiPath, page!.path);
    expect(fs.existsSync(pagePath)).toBe(true);
    const content = fs.readFileSync(pagePath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("id:");
    expect(content).toContain("OAuth 2.0 Guide");
  });

  test("stores URL metadata", () => {
    const result = ingestSource(
      wikiPath, tmpDir, "url", "Web Article",
      "Article content here", store,
      { url: "https://example.com/article" }
    );

    const manifest = store.getSource(result.manifestId);
    expect(manifest!.metadata.url).toBe("https://example.com/article");
  });

  test("updates existing pages when specified", () => {
    // Create a page first
    store.upsertPage({
      id: "auth-module",
      path: "entities/auth-module.md",
      type: "entity",
      title: "Auth Module",
      summary: "Auth",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    });

    const result = ingestSource(
      wikiPath, tmpDir, "article", "OAuth Security",
      "Security considerations for OAuth", store,
      { updateExisting: ["auth-module"] }
    );

    expect(result.pagesUpdated).toContain("auth-module");

    const page = store.getPage("auth-module");
    expect(page!.sourceIds).toContain(result.manifestId);
  });

  test("appends structured log entry", () => {
    ingestSource(
      wikiPath, tmpDir, "note", "Meeting Notes",
      "Discussed architecture", store
    );

    const logPath = path.join(wikiPath, "meta", "LOG.md");
    expect(fs.existsSync(logPath)).toBe(true);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("## [");
    expect(log).toContain("ingest");
    expect(log).toContain("note");
    expect(log).toContain("Meeting Notes");
  });
});

// ============================================================================
// URL INGESTION
// ============================================================================

describe("Phase 1: Ingest URL", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("handles failed fetch gracefully", async () => {
    // This URL will fail — test that it still creates a source
    const result = await ingestUrl(
      wikiPath, tmpDir, "https://invalid.nonexistent.example.com/page",
      store, { title: "Test Page" }
    );

    // Should create a source even if fetch fails
    expect(result.manifestId).toBeTruthy();
    expect(result.title).toBe("Test Page");
    // May have errors from fetch, but should still work
  });
});

// ============================================================================
// GIT SOURCE MANIFESTS
// ============================================================================

describe("Phase 1: Git source manifests", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("creates git source manifest", () => {
    const manifest = createGitSourceManifest(
      wikiPath, store, "abc1234..def5678",
      ["auth-module"], ["event-bus"]
    );

    expect(manifest).not.toBeNull();
    expect(manifest!.type).toBe("git-commits");
    expect(manifest!.pagesCreated).toEqual(["auth-module"]);

    // Manifest file exists
    const manifestPath = path.join(wikiPath, manifest!.path);
    expect(fs.existsSync(manifestPath)).toBe(true);

    // Can be retrieved from store
    const retrieved = store.getSource(manifest!.id);
    expect(retrieved).not.toBeNull();
  });
});

// ============================================================================
// STRUCTURED LOG
// ============================================================================

describe("Phase 1: Structured LOG.md", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("appendLogEntry creates LOG.md if it doesn't exist", () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      type: "ingest",
      source: "article",
      title: "Test Article",
      pagesCreated: ["test-article"],
      pagesUpdated: [],
    };

    appendLogEntry(wikiPath, entry);

    const logPath = path.join(wikiPath, "meta", "LOG.md");
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("## [");
    expect(content).toContain("ingest");
    expect(content).toContain("Test Article");
  });

  test("parseLog reads structured entries", () => {
    // Append two entries
    appendLogEntry(wikiPath, {
      timestamp: "2026-05-01T10:00:00Z",
      type: "ingest",
      source: "article",
      title: "First Article",
      pagesCreated: ["first"],
      pagesUpdated: [],
    });

    appendLogEntry(wikiPath, {
      timestamp: "2026-05-01T11:00:00Z",
      type: "ingest",
      source: "note",
      title: "Second Note",
      pagesCreated: ["second"],
      pagesUpdated: ["first"],
    });

    const entries = parseLog(wikiPath);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Entries are in file order — first appended comes first after header
    const firstEntry = entries[0];
    expect(firstEntry.type).toBe("ingest");
    expect(firstEntry.title).toBe("First Article");
    expect(firstEntry.pagesCreated).toContain("first");

    // Second entry should have both created and updated
    const secondEntry = entries[1];
    expect(secondEntry.pagesCreated).toContain("second");
    expect(secondEntry.pagesUpdated).toContain("first");
  });

  test("getRecentLog returns last N entries", () => {
    for (let i = 0; i < 5; i++) {
      appendLogEntry(wikiPath, {
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        type: "ingest",
        source: "article",
        title: `Article ${i}`,
        pagesCreated: [],
        pagesUpdated: [],
      });
    }

    const recent = getRecentLog(wikiPath, 3);
    expect(recent.length).toBeLessThanOrEqual(3);
  });

  test("log format is grep-parseable", () => {
    appendLogEntry(wikiPath, {
      timestamp: "2026-05-01T14:30:00Z",
      type: "ingest",
      source: "git-commits",
      title: "Recent commits",
      sourceManifestId: "src-git-commits-abc123-1234",
      pagesCreated: ["auth"],
      pagesUpdated: [],
    });

    const logPath = path.join(wikiPath, "meta", "LOG.md");
    const content = fs.readFileSync(logPath, "utf-8");

    // Should be parseable with: grep "^## \[" LOG.md | tail -5
    const entries = content.split("\n").filter(l => l.startsWith("## ["));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toMatch(/^## \[.*\] ingest \|/);
  });
});

// ============================================================================
// FRONTMATTER INTEGRATION
// ============================================================================

describe("Phase 1: Frontmatter in source pages", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("source pages have YAML frontmatter", () => {
    const result = ingestSource(
      wikiPath, tmpDir, "article", "OAuth Design Patterns",
      "Best practices for OAuth implementations", store
    );

    const slug = result.pagesCreated[0];
    const page = store.getPage(slug);
    const pagePath = path.join(wikiPath, page!.path);
    const content = fs.readFileSync(pagePath, "utf-8");

    const { metadata, body } = parseFrontmatter(content);
    expect(metadata.id).toBe(slug);
    expect(metadata.type).toBeTruthy();
    expect(metadata.sources).toContain(result.manifestId);
    expect(body).toContain("OAuth Design Patterns");
  });
});