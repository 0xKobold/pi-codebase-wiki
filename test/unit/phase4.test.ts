/**
 * Contradiction Resolution Tests
 *
 * Tests: resolution strategy suggestion, merge, update (cross-reference),
 * split, contradiction detection with detailed output.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WikiStore } from "../../src/core/store.js";
import { mergePages, updatePages, splitPage, suggestResolution } from "../../src/operations/resolve.js";
import { findContradictionsDetailed } from "../../src/core/staleness.js";
import type { WikiPage } from "../../src/shared.js";
import { DEFAULT_WIKI_CONFIG } from "../../src/shared.js";
import { initWiki } from "../../src/core/index.js";
import { ensureWikiDirs } from "../../src/core/config.js";
import { formatWikiDate } from "../../src/shared.js";

let tmpDir: string;
let wikiPath: string;
let store: WikiStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-p4-"));
  wikiPath = path.join(tmpDir, ".codebase-wiki");

  const { execSync } = require("child_process");
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "resolve-test" }));
  execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  execSync('git -c user.name="test" -c user.email="t@t.com" add .', { cwd: tmpDir, stdio: "pipe" });
  execSync('git -c user.name="test" -c user.email="t@t.com" commit -m "feat: init"', { cwd: tmpDir, stdio: "pipe" });

  ensureWikiDirs(tmpDir, ".codebase-wiki");
  const dbPath = path.join(wikiPath, "meta", "wiki.db");
  store = new WikiStore(dbPath);
  await store.init();
});

afterEach(() => {
  try { store.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createPage(id: string, type: string, title: string, content: string): WikiPage {
  const dir = type === "entity" ? "entities" : type === "concept" ? "concepts" : type === "decision" ? "decisions" : "queries";
  const pagePath = path.join(wikiPath, dir, `${id}.md`);
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.writeFileSync(pagePath, content, "utf-8");

  const page: WikiPage = {
    id,
    path: `${dir}/${id}.md`,
    type,
    title,
    summary: content.split("\n").find(l => l.startsWith("> **Summary**:"))?.replace("> **Summary**: ", "") || title,
    sourceFiles: [],
    sourceCommits: [],
    lastIngested: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    inboundLinks: 0,
    outboundLinks: 0,
    stale: false,
  };
  store.upsertPage(page);
  return page;
}

// ─── SUGGEST RESOLUTION ──────────────────────────────────────────────────────

describe("suggestResolution recommends the right strategy", () => {
  test("same type with >75% overlap suggests merge", () => {
    const result = suggestResolution({ id: "auth", type: "entity" }, { id: "oauth", type: "entity" }, 0.85);
    expect(result.strategy).toBe("merge");
    expect(result.reason).toContain("duplicates");
  });

  test("same type with 40-75% overlap suggests update", () => {
    const result = suggestResolution({ id: "auth", type: "entity" }, { id: "api", type: "entity" }, 0.55);
    expect(result.strategy).toBe("update");
    expect(result.reason).toContain("cross-reference");
  });

  test("different types with overlap suggests update", () => {
    const result = suggestResolution({ id: "auth", type: "entity" }, { id: "auth-pattern", type: "concept" }, 0.45);
    expect(result.strategy).toBe("update");
    expect(result.reason).toContain("Different types");
  });

  test("low overlap suggests update with cross-references", () => {
    const result = suggestResolution({ id: "a", type: "entity" }, { id: "b", type: "entity" }, 0.2);
    expect(result.strategy).toBe("update");
  });
});

// ─── MERGE PAGES ────────────────────────────────────────────────────────────

describe("mergePages combines two pages into one", () => {
  test("merges page B into page A and redirects references", () => {
    createPage("auth-module", "entity", "Auth Module", "# Auth Module\n\n> **Summary**: Authentication module.\n\n## Key Files\n- auth.ts\n\n## See Also\n- [[api-gateway]]");
    createPage("oauth-flow", "entity", "OAuth Flow", "# OAuth Flow\n\n> **Summary**: OAuth 2.0 flow.\n\n## Endpoints\n- /oauth/token\n\n## See Also\n- [[auth-module]]");
    createPage("api-gateway", "entity", "API Gateway", "# API Gateway\n\nReferences [[auth-module]] and [[oauth-flow]].");

    const result = mergePages(wikiPath, store, "oauth-flow", "auth-module");

    expect(result.merged).toBe("auth-module");
    expect(result.redirected).toContain("api-gateway");

    // Auth module page should contain merged content
    const mergedPath = path.join(wikiPath, "entities", "auth-module.md");
    const merged = fs.readFileSync(mergedPath, "utf-8");
    expect(merged).toContain("Auth Module");

    // OAuth flow page should be deleted from store
    expect(store.getPage("oauth-flow")).toBeNull();

    // API gateway should now reference auth-module instead of oauth-flow
    const gwPath = path.join(wikiPath, "entities", "api-gateway.md");
    const gw = fs.readFileSync(gwPath, "utf-8");
    expect(gw).toContain("[[auth-module]]");
  });
});

// ─── UPDATE PAGES (CROSS-REFERENCES) ────────────────────────────────────────

describe("updatePages adds cross-reference notes to both pages", () => {
  test("adds overlap notes and store cross-references", () => {
    createPage("auth-module", "entity", "Auth Module", "# Auth Module\n\n> **Summary**: Authentication module.\n\n## Key Files\n- auth.ts");
    createPage("auth-pattern", "concept", "Auth Pattern", "# Auth Pattern\n\n> **Summary**: Pattern for auth.\n\n## Where It Appears\n- [[auth-module]]");

    const result = updatePages(wikiPath, store, "auth-module", "auth-pattern");

    expect(result.updated.length).toBeGreaterThanOrEqual(1);

    // Both pages should have cross-reference notes
    const authPath = path.join(wikiPath, "entities", "auth-module.md");
    const auth = fs.readFileSync(authPath, "utf-8");
    expect(auth).toContain("[[auth-pattern]]");
    expect(auth).toContain("overlap");
  });
});

// ─── SPLIT PAGE ──────────────────────────────────────────────────────────────

describe("splitPage separates content into a new page", () => {
  test("creates a new page with split sections", () => {
    createPage("big-module", "entity", "Big Module", "# Big Module\n\n> **Summary**: A big module.\n\n## Core Logic\nCore stuff here.\n\n## API Surface\nAPI endpoints.\n\n## See Also\n- [[other]]");

    const result = splitPage(
      wikiPath,
      store,
      "big-module",
      "big-module-api",
      "Big Module API",
      (sectionTitle) => sectionTitle === "API Surface"
    );

    expect(result.original).toBe("big-module");
    expect(result.newPage).toBe("big-module-api");

    // New page should exist in store
    const newPage = store.getPage("big-module-api");
    expect(newPage).not.toBeNull();
    expect(newPage!.title).toBe("Big Module API");
  });
});

// ─── FIND CONTRADICTIONS DETAILED ─────────────────────────────────────────────

describe("findContradictionsDetailed detects overlap with suggestions", () => {
  test("finds high-overlap same-type pages and suggests merge", async () => {
    const content1 = "# Auth Module\n\nAuthentication module for handling user login and token management. This includes OAuth2, JWT, and session-based authentication strategies. The auth module provides login, logout, token refresh, and permission checking functionality.\n\n## Key Files\n- auth.ts\n- oauth.ts\n- jwt.ts\n";
    const content2 = "# OAuth Module\n\nOAuth module for handling OAuth2 authentication flows. This includes token management, refresh tokens, and session handling. The OAuth module provides login, logout, token refresh, and scope-based permission checking.\n\n## Key Files\n- oauth.ts\n- jwt.ts\n";

    createPage("auth-module", "entity", "Auth Module", content1);
    createPage("oauth-module", "entity", "OAuth Module", content2);

    const pages = store.getAllPages();
    const contradictions = findContradictionsDetailed(wikiPath, pages);

    // Should find at least one contradiction with suggestion
    expect(contradictions.length).toBeGreaterThanOrEqual(1);

    const authContradiction = contradictions.find(c =>
      (c.pageA.id === "auth-module" && c.pageB.id === "oauth-module") ||
      (c.pageA.id === "oauth-module" && c.pageB.id === "auth-module")
    );
    expect(authContradiction).toBeDefined();
    expect(authContradiction!.suggestion).toBeDefined();
    expect(typeof authContradiction!.similarity).toBe("number");
  });

  test("returns empty for distinct non-overlapping pages", async () => {
    createPage("auth-module", "entity", "Auth Module", "# Auth Module\n\nAuthentication module. login logout tokens.\n\n## Key Files\n- auth.ts\n");
    createPage("database-utils", "entity", "Database Utils", "# Database Utils\n\nDatabase connection pooling, query builders, migrations.\n\n## Key Files\n- db.ts\n- migrate.ts\n");

    const pages = store.getAllPages();
    const contradictions = findContradictionsDetailed(wikiPath, pages);
    expect(contradictions.length).toBe(0);
  });
});