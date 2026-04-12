/**
 * pi-codebase-wiki — Integration Tests
 *
 * Tests for the WikiStore (SQLite), full ingest pipeline,
 * and wiki initialization with real file system operations.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WikiStore } from "../../src/core/store.js";
import {
  initWiki,
  ingestCommits,
  ingestFileTree,
} from "../../src/operations/ingest.js";
import { searchWiki, getPageContent, getRelatedPages } from "../../src/operations/query.js";
import { lintWiki, formatLintResult } from "../../src/operations/lint.js";
import type { WikiPage, WikiConfig } from "../../src/shared.js";
import { DEFAULT_WIKI_CONFIG } from "../../src/shared.js";
import {
  wikiExists,
  getWikiPath,
  ensureWikiDirs,
} from "../../src/core/config.js";

// ============================================================================
// TEST HELPERS
// ============================================================================

let tmpDir: string;
let wikiPath: string;
let store: WikiStore;

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-test-"));

  // Create a minimal project structure
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "pi-learn", "src"), { recursive: true });

  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};")
  fs.writeFileSync(path.join(dir, "src", "auth.ts"), "export const auth = {};");
  fs.writeFileSync(path.join(dir, "src", "utils.ts"), "export const utils = {};");
  fs.writeFileSync(path.join(dir, "packages", "pi-learn", "src", "index.ts"), "export {};");

  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "test-project",
    version: "1.0.0",
  }));

  fs.writeFileSync(path.join(dir, "README.md"), "# Test Project\n\nA test project for wiki integration tests.");

  // Initialize git repo
  try {
    const { execSync } = require("child_process");
    execSync("git init", { cwd: dir });
    execSync("git add .", { cwd: dir });
    execSync('git commit -m "feat: initial commit"', { cwd: dir });
  } catch {
    // Git may not be available; tests that need it will be skipped
  }

  return dir;
}

async function setupStore(): Promise<WikiStore> {
  const dbPath = path.join(wikiPath, "meta", "wiki.db");
  const s = new WikiStore(dbPath);
  await s.init();
  return s;
}

// ============================================================================
// WIKI STORE TESTS
// ============================================================================

describe("WikiStore (SQLite)", () => {
  beforeEach(async () => {
    tmpDir = createTempProject();
    wikiPath = path.join(tmpDir, DEFAULT_WIKI_CONFIG.wikiDir);
    fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });
    store = await setupStore();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stores and retrieves a page", async () => {
    const page: WikiPage = {
      id: "auth-module",
      path: "entities/auth-module.md",
      type: "entity",
      title: "Auth Module",
      summary: "Authentication module",
      sourceFiles: ["src/auth.ts"],
      sourceCommits: ["abc123"],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 2,
      stale: false,
    };

    store.upsertPage(page);

    const retrieved = store.getPage("auth-module");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("auth-module");
    expect(retrieved!.title).toBe("Auth Module");
    expect(retrieved!.sourceFiles).toEqual(["src/auth.ts"]);
    expect(retrieved!.stale).toBe(false);
  });

  test("updates an existing page", async () => {
    const page: WikiPage = {
      id: "auth-module",
      path: "entities/auth-module.md",
      type: "entity",
      title: "Auth Module",
      summary: "Original summary",
      sourceFiles: ["src/auth.ts"],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };

    store.upsertPage(page);

    // Update
    page.summary = "Updated summary";
    page.inboundLinks = 3;
    page.stale = true;
    store.upsertPage(page);

    const retrieved = store.getPage("auth-module");
    expect(retrieved!.summary).toBe("Updated summary");
    expect(retrieved!.inboundLinks).toBe(3);
    expect(retrieved!.stale).toBe(true);
  });

  test("deletes a page", async () => {
    const page: WikiPage = {
      id: "to-delete",
      path: "entities/to-delete.md",
      type: "entity",
      title: "To Delete",
      summary: "",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };

    store.upsertPage(page);
    expect(store.getPage("to-delete")).not.toBeNull();

    store.deletePage("to-delete");
    expect(store.getPage("to-delete")).toBeNull();
  });

  test("manages cross-references", async () => {
    store.addCrossReference("auth-module", "event-bus", "auth emits login events");
    store.addCrossReference("index", "auth-module", "main entity");

    const outbound = store.getOutboundLinks("auth-module");
    expect(outbound.length).toBe(1);
    expect(outbound[0].toPage).toBe("event-bus");

    const inbound = store.getInboundLinks("auth-module");
    expect(inbound.length).toBe(1);
    expect(inbound[0].fromPage).toBe("index");
  });

  test("logs ingest operations", async () => {
    const id = store.logIngest({
      sourceType: "commit",
      sourceRef: "abc123",
      pagesCreated: 3,
      pagesUpdated: 1,
      timestamp: new Date().toISOString(),
    });

    expect(id).toBeTruthy();

    const last = store.getLastIngest();
    expect(last).not.toBeNull();
    expect(last!.sourceType).toBe("commit");
    expect(last!.pagesCreated).toBe(3);
  });

  test("tracks staleness", async () => {
    store.upsertStalenessCheck({
      pageId: "auth-module",
      checkTime: new Date().toISOString(),
      staleFiles: ["src/auth.ts"],
      stalenessScore: 0.6,
    });

    const check = store.getStalenessCheck("auth-module");
    expect(check).not.toBeNull();
    expect(check!.stalenessScore).toBe(0.6);
    expect(check!.staleFiles).toEqual(["src/auth.ts"]);
  });

  test("returns stats", async () => {
    const page: WikiPage = {
      id: "test-entity",
      path: "entities/test-entity.md",
      type: "entity",
      title: "Test Entity",
      summary: "",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };

    store.upsertPage(page);
    const stats = store.getStats();
    expect(stats.totalPages).toBe(1);
    expect(stats.pagesByType.entity).toBe(1);
    expect(stats.stalePages).toBe(0);
  });

  test("persists to disk and reloads", async () => {
    const page: WikiPage = {
      id: "persist-test",
      path: "entities/persist-test.md",
      type: "entity",
      title: "Persist Test",
      summary: "Tests persistence",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };

    store.upsertPage(page);
    store.save();
    store.close();

    // Reload
    const dbPath = path.join(wikiPath, "meta", "wiki.db");
    const newStore = new WikiStore(dbPath);
    await newStore.init();

    const retrieved = newStore.getPage("persist-test");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Persist Test");

    newStore.close();
  });
});

// ============================================================================
// WIKI INITIALIZATION TESTS
// ============================================================================

describe("Wiki Initialization", () => {
  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates wiki directory structure", async () => {
    expect(wikiExists(tmpDir)).toBe(false);

    const config = DEFAULT_WIKI_CONFIG;
    const wikiPath = initWiki(tmpDir, config, await setupStoreForDir(tmpDir));

    expect(wikiExists(tmpDir)).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "SCHEMA.md"))).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "INDEX.md"))).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "meta", "LOG.md"))).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "entities"))).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "concepts"))).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "templates"))).toBe(true);
  });

  test("generates SCHEMA.md with project name", async () => {
    initWiki(tmpDir, DEFAULT_WIKI_CONFIG, await setupStoreForDir(tmpDir));

    const schema = fs.readFileSync(path.join(tmpDir, DEFAULT_WIKI_CONFIG.wikiDir, "SCHEMA.md"), "utf-8");
    expect(schema).toContain("test-project");
  });

  test("does not overwrite existing SCHEMA.md on re-init", async () => {
    const store = await setupStoreForDir(tmpDir);
    initWiki(tmpDir, DEFAULT_WIKI_CONFIG, store);

    // Modify SCHEMA.md
    const schemaPath = path.join(tmpDir, DEFAULT_WIKI_CONFIG.wikiDir, "SCHEMA.md");
    const original = fs.readFileSync(schemaPath, "utf-8");
    fs.writeFileSync(schemaPath, original + "\n## Custom Section\nCustom content.");

    // Re-init should not overwrite
    initWiki(tmpDir, DEFAULT_WIKI_CONFIG, store);

    const afterReinit = fs.readFileSync(schemaPath, "utf-8");
    expect(afterReinit).toContain("Custom Section");
  });
});

// ============================================================================
// QUERY INTEGRATION TESTS
// ============================================================================

describe("Wiki Query", () => {
  let store2: WikiStore;

  beforeEach(async () => {
    tmpDir = createTempProject();
    const wikiDir = DEFAULT_WIKI_CONFIG.wikiDir;
    wikiPath = path.join(tmpDir, wikiDir);
    fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });
    fs.mkdirSync(path.join(wikiPath, "entities"), { recursive: true });

    store2 = await setupStore();

    // Seed some pages
    const pages: WikiPage[] = [
      {
        id: "auth-module",
        path: "entities/auth-module.md",
        type: "entity",
        title: "Auth Module",
        summary: "Handles user authentication and OAuth",
        sourceFiles: ["src/auth.ts"],
        sourceCommits: [],
        lastIngested: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        inboundLinks: 2,
        outboundLinks: 1,
        stale: false,
      },
      {
        id: "event-bus",
        path: "entities/event-bus.md",
        type: "entity",
        title: "Event Bus",
        summary: "Decoupled event system for module communication",
        sourceFiles: ["src/event-bus.ts"],
        sourceCommits: [],
        lastIngested: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        inboundLinks: 3,
        outboundLinks: 5,
        stale: false,
      },
    ];

    for (const page of pages) {
      store2.upsertPage(page);

      // Create the actual markdown file
      const filePath = path.join(wikiPath, page.path);
      fs.writeFileSync(filePath, `# ${page.title}\n\n> **Summary**: ${page.summary}\n\n## Details\n\nContent about ${page.title}.\n\n## See Also\n- [[index]]\n`);
    }

    store2.addCrossReference("auth-module", "event-bus", "auth emits events");
  });

  afterEach(() => {
    store2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("searches wiki pages by keyword", () => {
    // Search for "authentication"
    const result = searchWiki("authentication", wikiPath, store2);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].page.id).toBe("auth-module");
  });

  test("searches wiki pages by title match", () => {
    const result = searchWiki("event bus", wikiPath, store2);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  test("gets page content by slug", () => {
    const result = getPageContent("auth-module", wikiPath, store2);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Auth Module");
    expect(result!.page.title).toBe("Auth Module");
  });

  test("returns null for non-existent page", () => {
    const result = getPageContent("nonexistent", wikiPath, store2);
    expect(result).toBeNull();
  });

  test("gets related pages via cross-references", () => {
    const related = getRelatedPages("auth-module", wikiPath, store2);
    expect(related.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// LINT INTEGRATION TESTS
// ============================================================================

describe("Wiki Lint", () => {
  let store3: WikiStore;

  beforeEach(async () => {
    tmpDir = createTempProject();
    wikiPath = path.join(tmpDir, DEFAULT_WIKI_CONFIG.wikiDir);
    fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });
    store3 = await setupStore();
  });

  afterEach(() => {
    store3.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("lints an empty wiki", () => {
    const result = lintWiki(wikiPath, store3);
    expect(result.totalPages).toBe(0);
    expect(result.issues).toEqual([]);
  });

  test("finds orphan pages", async () => {
    const page: WikiPage = {
      id: "orphan-page",
      path: "entities/orphan-page.md",
      type: "entity",
      title: "Orphan Page",
      summary: "Nobody links to me",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };

    store3.upsertPage(page);
    fs.mkdirSync(path.join(wikiPath, "entities"), { recursive: true });
    fs.writeFileSync(path.join(wikiPath, page.path), `# Orphan Page\n\nNobody links to me.\n`);

    const result = lintWiki(wikiPath, store3);
    const orphans = result.issues.filter(i => i.type === "orphan");
    expect(orphans.length).toBeGreaterThan(0);
  });

  test("formats lint result as readable text", () => {
    const result: WikiPage = {
      id: "test",
      path: "entities/test.md",
      type: "entity",
      title: "Test",
      summary: "",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };
    store3.upsertPage(result);

    const lintResult = lintWiki(wikiPath, store3);
    const text = formatLintResult(lintResult);
    expect(text).toContain("Wiki Lint Report");
  });
});

// ============================================================================
// HELPER
// ============================================================================

async function setupStoreForDir(dir: string): Promise<WikiStore> {
  const wp = path.join(dir, DEFAULT_WIKI_CONFIG.wikiDir);
  fs.mkdirSync(path.join(wp, "meta"), { recursive: true });
  const dbPath = path.join(wp, "meta", "wiki.db");
  const s = new WikiStore(dbPath);
  await s.init();
  return s;
}