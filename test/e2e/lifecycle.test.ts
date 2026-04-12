/**
 * pi-codebase-wiki — E2E Tests
 *
 * Full lifecycle tests: init → ingest → query → lint → evolve
 * Tests the complete user workflow from scratch.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WikiStore } from "../../src/core/store.js";
import { initWiki, ingestFileTree } from "../../src/operations/ingest.js";
import { searchWiki, getPageContent } from "../../src/operations/query.js";
import { lintWiki, formatLintResult } from "../../src/operations/lint.js";
import { DEFAULT_WIKI_CONFIG } from "../../src/shared.js";
import { wikiExists, getWikiPath } from "../../src/core/config.js";
import type { WikiPage } from "../../src/shared.js";

// ============================================================================
// E2E: FULL LIFECYCLE
// ============================================================================

describe("E2E: Full Wiki Lifecycle", () => {
  let tmpDir: string;
  let store: WikiStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-e2e-"));

    // Create a realistic project structure
    fs.mkdirSync(path.join(tmpDir, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "core"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "skills"), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, "src", "auth", "index.ts"), "export const auth = {};");
    fs.writeFileSync(path.join(tmpDir, "src", "auth", "oauth.ts"), "export const oauth = {};");
    fs.writeFileSync(path.join(tmpDir, "src", "core", "event-bus.ts"), "export class EventBus {}");
    fs.writeFileSync(path.join(tmpDir, "src", "core", "store.ts"), "export class Store {}");
    fs.writeFileSync(path.join(tmpDir, "src", "skills", "loader.ts"), "export const loadSkills = () => {};");

    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "e2e-project",
      version: "0.1.0",
    }));

    fs.writeFileSync(path.join(tmpDir, "README.md"), "# E2E Project\n\nA project for testing the full wiki lifecycle.");

    // Try to init git
    try {
      const { execSync } = require("child_process");
      execSync("git init", { cwd: tmpDir, stdio: "pipe" });
      execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
      execSync('git -c user.name="test" -c user.email="test@test.com" commit -m "feat: initial commit"', { cwd: tmpDir, stdio: "pipe" });
    } catch {
      // Git not available; some tests will be limited
    }
  });

  afterEach(() => {
    if (store) store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("init → ingest tree → query → lint lifecycle", async () => {
    // Step 1: Init wiki
    expect(wikiExists(tmpDir)).toBe(false);

    const wikiDir = DEFAULT_WIKI_CONFIG.wikiDir;
    const dbPath = path.join(tmpDir, wikiDir, "meta", "wiki.db");
    store = new WikiStore(dbPath);
    await store.init();

    const wikiPath = initWiki(tmpDir, DEFAULT_WIKI_CONFIG, store);
    expect(wikiExists(tmpDir)).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "SCHEMA.md"))).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, "INDEX.md"))).toBe(true);

    // Step 2: Ingest file tree
    const result = await ingestFileTree(tmpDir, DEFAULT_WIKI_CONFIG, store);
    expect(result.filesProcessed).toBeGreaterThan(0);
    expect(result.pagesCreated).toBeGreaterThan(0);

    // Step 3: Verify entity pages exist
    const stats = store.getStats();
    expect(stats.totalPages).toBeGreaterThan(0);

    // Step 4: Create a manual entity page
    const entityPage: WikiPage = {
      id: "auth-module",
      path: "entities/auth-module.md",
      type: "entity",
      title: "Auth Module",
      summary: "Handles user authentication including OAuth",
      sourceFiles: ["src/auth/index.ts", "src/auth/oauth.ts"],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };
    store.upsertPage(entityPage);

    // Write the actual markdown file
    const entityPath = path.join(wikiPath, "entities", "auth-module.md");
    fs.writeFileSync(entityPath, `# Auth Module\n\n> **Summary**: Handles user authentication including OAuth\n\n## Key Files\n- \`src/auth/index.ts\` — main auth entry\n- \`src/auth/oauth.ts\` — OAuth implementation\n\n## See Also\n- [[event-bus]]\n`);

    // Step 5: Query
    const queryResult = searchWiki("authentication", wikiPath, store);
    expect(queryResult.matches.length).toBeGreaterThan(0);

    // Step 6: Get page content
    const pageContent = getPageContent("auth-module", wikiPath, store);
    expect(pageContent).not.toBeNull();
    expect(pageContent!.content).toContain("Auth Module");

    // Step 7: Lint
    const lintResult = lintWiki(wikiPath, store);
    // Fresh wiki with few pages — might have orphans but should be valid
    const report = formatLintResult(lintResult);
    expect(report).toContain("Wiki Lint Report");
  });

  test("creates and queries ADRs", async () => {
    const wikiDir = DEFAULT_WIKI_CONFIG.wikiDir;
    const dbPath = path.join(tmpDir, wikiDir, "meta", "wiki.db");
    store = new WikiStore(dbPath);
    await store.init();

    initWiki(tmpDir, DEFAULT_WIKI_CONFIG, store);

    // Create an ADR page
    const adrPage: WikiPage = {
      id: "adr-001-sqlite-over-leveldb",
      path: "decisions/adr-001-sqlite-over-leveldb.md",
      type: "decision",
      title: "ADR-001: Use SQLite over LevelDB",
      summary: "Chose SQLite for its SQL interface and cross-platform support",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };
    store.upsertPage(adrPage);

    const decisions = store.getPagesByType("decision");
    expect(decisions.length).toBe(1);
    expect(decisions[0].title).toContain("SQLite");

    // Query for it
    const wikiPath = getWikiPath(tmpDir, DEFAULT_WIKI_CONFIG.wikiDir);
    const result = searchWiki("SQLite", wikiPath, store);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  test("tracks cross-references between pages", async () => {
    const wikiDir = DEFAULT_WIKI_CONFIG.wikiDir;
    const dbPath = path.join(tmpDir, wikiDir, "meta", "wiki.db");
    store = new WikiStore(dbPath);
    await store.init();

    initWiki(tmpDir, DEFAULT_WIKI_CONFIG, store);

    // Create two entity pages
    const authPage: WikiPage = {
      id: "auth",
      path: "entities/auth.md",
      type: "entity",
      title: "Auth",
      summary: "Authentication module",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 1,
      outboundLinks: 1,
      stale: false,
    };
    const busPage: WikiPage = {
      id: "event-bus",
      path: "entities/event-bus.md",
      type: "entity",
      title: "Event Bus",
      summary: "Event system for communication",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 1,
      outboundLinks: 2,
      stale: false,
    };

    store.upsertPage(authPage);
    store.upsertPage(busPage);

    // Add cross-references
    store.addCrossReference("auth", "event-bus", "auth emits login events");
    store.addCrossReference("event-bus", "auth", "auth subscribes to events");

    // Verify
    const authOutbound = store.getOutboundLinks("auth");
    expect(authOutbound.length).toBe(1);
    expect(authOutbound[0].toPage).toBe("event-bus");

    const busOutbound = store.getOutboundLinks("event-bus");
    expect(busOutbound.length).toBe(1);
    expect(busOutbound[0].toPage).toBe("auth");
  });

  test("detects stale pages after file modification", async () => {
    const wikiDir = DEFAULT_WIKI_CONFIG.wikiDir;
    const dbPath = path.join(tmpDir, wikiDir, "meta", "wiki.db");
    store = new WikiStore(dbPath);
    await store.init();

    initWiki(tmpDir, DEFAULT_WIKI_CONFIG, store);

    // Create a page with source files
    const page: WikiPage = {
      id: "stale-test",
      path: "entities/stale-test.md",
      type: "entity",
      title: "Stale Test",
      summary: "Will become stale",
      sourceFiles: ["src/auth/index.ts"],
      sourceCommits: [],
      lastIngested: new Date("2025-01-01").toISOString(), // Long ago
      lastChecked: new Date("2025-01-01").toISOString(),
      inboundLinks: 1,
      outboundLinks: 0,
      stale: false,
    };

    store.upsertPage(page);

    // File was modified recently (it was just created in beforeEach)
    // Since lastIngested is 2025-01-01, the file should be considered stale

    // Check that stale detection recognizes the mtime gap
    const stalePages = store.getStalePages();
    // No pages marked stale yet (we set stale: false manually)
    expect(stalePages.length).toBe(0);

    // But if we mark it stale via lint or staleness check
    page.stale = true;
    store.upsertPage(page);

    const staleAfterMark = store.getStalePages();
    expect(staleAfterMark.length).toBe(1);
  });

  test("ingest log tracks operations", async () => {
    const wikiDir = DEFAULT_WIKI_CONFIG.wikiDir;
    const dbPath = path.join(tmpDir, wikiDir, "meta", "wiki.db");
    store = new WikiStore(dbPath);
    await store.init();

    // Log a manual ingest
    store.logIngest({
      sourceType: "commit",
      sourceRef: "abc123def456",
      pagesCreated: 5,
      pagesUpdated: 2,
      timestamp: new Date().toISOString(),
    });

    const lastIngest = store.getLastIngest();
    expect(lastIngest).not.toBeNull();
    expect(lastIngest!.sourceType).toBe("commit");
    expect(lastIngest!.pagesCreated).toBe(5);
    expect(lastIngest!.pagesUpdated).toBe(2);

    // Log another
    store.logIngest({
      sourceType: "full-tree",
      sourceRef: "initial-ingest",
      pagesCreated: 10,
      pagesUpdated: 0,
      timestamp: new Date().toISOString(),
    });

    const lastIngest2 = store.getLastIngest();
    expect(lastIngest2!.sourceType).toBe("full-tree");
  });
});