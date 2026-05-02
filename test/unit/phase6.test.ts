/**
 * Wiki Versioning & Polish Tests
 *
 * Tests: git-based versioning (init, auto-commit, hash, changes),
 * batch ingestion, and versioning integration with wiki operations.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  initWikiGit,
  wikiAutoCommit,
  getWikiGitHash,
  getWikiGitLog,
  wikiHasChanges,
} from "../../src/core/versioning.js";

let tmpDir: string;
let wikiPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-p6-"));
  wikiPath = path.join(tmpDir, ".codebase-wiki");
  fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });
  fs.mkdirSync(path.join(wikiPath, "entities"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── INIT WIKI GIT ──────────────────────────────────────────────────────────

describe("initWikiGit creates a git repo in the wiki directory", () => {
  test("initializes git repo on first call", () => {
    const result = initWikiGit(wikiPath);
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(wikiPath, ".git"))).toBe(true);
  });

  test("returns false on second call (already initialized)", () => {
    initWikiGit(wikiPath);
    const result = initWikiGit(wikiPath);
    expect(result).toBe(false);
  });

  test("creates initial commit", () => {
    initWikiGit(wikiPath);
    const hash = getWikiGitHash(wikiPath);
    expect(hash).not.toBeNull();
    expect(hash!.length).toBeGreaterThanOrEqual(7);
  });
});

// ─── AUTO COMMIT ────────────────────────────────────────────────────────────

describe("wikiAutoCommit commits changes to wiki git", () => {
  test("commits new files", () => {
    initWikiGit(wikiPath);

    // Create a new file
    fs.writeFileSync(path.join(wikiPath, "entities", "test.md"), "# Test\n", "utf-8");

    const result = wikiAutoCommit(wikiPath, "wiki: added test entity");
    expect(result).toBe(true);

    // Should be in the log
    const log = getWikiGitLog(wikiPath, 5);
    expect(log.some(l => l.includes("added test entity"))).toBe(true);
  });

  test("returns false when no changes", () => {
    initWikiGit(wikiPath);

    const result = wikiAutoCommit(wikiPath, "wiki: no changes");
    expect(result).toBe(false);
  });

  test("returns false when wiki git not initialized", () => {
    const result = wikiAutoCommit(wikiPath, "wiki: no git");
    expect(result).toBe(false);
  });
});

// ─── GIT HASH ────────────────────────────────────────────────────────────────

describe("getWikiGitHash returns current commit hash", () => {
  test("returns hash after init", () => {
    initWikiGit(wikiPath);
    const hash = getWikiGitHash(wikiPath);
    expect(hash).not.toBeNull();
  });

  test("returns null when no git repo", () => {
    const hash = getWikiGitHash(wikiPath);
    expect(hash).toBeNull();
  });

  test("hash changes after commit", () => {
    initWikiGit(wikiPath);
    const hash1 = getWikiGitHash(wikiPath);

    fs.writeFileSync(path.join(wikiPath, "entities", "new.md"), "# New\n", "utf-8");
    wikiAutoCommit(wikiPath, "wiki: new entity");

    const hash2 = getWikiGitHash(wikiPath);
    expect(hash2).not.toBe(hash1);
  });
});

// ─── GIT LOG ─────────────────────────────────────────────────────────────────

describe("getWikiGitLog returns recent commits", () => {
  test("returns initial commit", () => {
    initWikiGit(wikiPath);
    const log = getWikiGitLog(wikiPath, 5);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]).toContain("initial structure");
  });

  test("shows new commits after auto-commit", () => {
    initWikiGit(wikiPath);

    fs.writeFileSync(path.join(wikiPath, "test1.md"), "# One\n", "utf-8");
    wikiAutoCommit(wikiPath, "wiki: first commit");

    fs.writeFileSync(path.join(wikiPath, "test2.md"), "# Two\n", "utf-8");
    wikiAutoCommit(wikiPath, "wiki: second commit");

    const log = getWikiGitLog(wikiPath, 10);
    expect(log.length).toBeGreaterThanOrEqual(3); // init + 2 commits
    expect(log[0]).toContain("second commit");
  });

  test("returns empty when no git repo", () => {
    const log = getWikiGitLog(wikiPath, 5);
    expect(log).toEqual([]);
  });
});

// ─── HAS CHANGES ─────────────────────────────────────────────────────────────

describe("wikiHasChanges detects uncommitted changes", () => {
  test("returns false after init and commit", () => {
    initWikiGit(wikiPath);
    expect(wikiHasChanges(wikiPath)).toBe(false);
  });

  test("returns true after adding a file", () => {
    initWikiGit(wikiPath);
    fs.writeFileSync(path.join(wikiPath, "new.md"), "# New\n", "utf-8");
    expect(wikiHasChanges(wikiPath)).toBe(true);
  });

  test("returns false after committing changes", () => {
    initWikiGit(wikiPath);
    fs.writeFileSync(path.join(wikiPath, "new.md"), "# New\n", "utf-8");
    wikiAutoCommit(wikiPath, "wiki: add new");
    expect(wikiHasChanges(wikiPath)).toBe(false);
  });

  test("returns false when no git repo", () => {
    expect(wikiHasChanges(wikiPath)).toBe(false);
  });
});