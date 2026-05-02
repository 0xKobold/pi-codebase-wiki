/**
 * Wiki Versioning — Git-based version control for the wiki directory.
 *
 * Initializes a git repo inside `.codebase-wiki/` so every ingest,
 * resolve, and lint operation is tracked. This provides full history
 * of every wiki change and enables rollbacks.
 *
 * This is separate from the project's git repo — the wiki has its own
 * history. The wiki dir is in the project's .gitignore.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// INIT WIKI GIT
// ============================================================================

/**
 * Initialize a git repo inside the wiki directory.
 * No-op if already initialized.
 */
export function initWikiGit(wikiPath: string): boolean {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");

  const gitDir = path.join(wikiPath, ".git");
  if (fs.existsSync(gitDir)) {
    return false; // Already initialized
  }

  try {
    execSync("git init", { cwd: wikiPath, stdio: "pipe" });

    // Ensure there's at least one file to commit
    const gitkeep = path.join(wikiPath, "meta", ".gitkeep");
    if (!fs.existsSync(gitkeep)) {
      fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });
      fs.writeFileSync(gitkeep, "", "utf-8");
    }

    execSync('git -c user.name="wiki" -c user.email="wiki@codebase-wiki.local" add .', { cwd: wikiPath, stdio: "pipe" });
    execSync('git -c user.name="wiki" -c user.email="wiki@codebase-wiki.local" commit -m "wiki: initial structure"', { cwd: wikiPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// AUTO-COMMIT
// ============================================================================

/**
 * Auto-commit all changes in the wiki directory with a descriptive message.
 * No-op if there are no changes.
 */
export function wikiAutoCommit(wikiPath: string, message: string): boolean {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");
  console.assert(typeof message === "string", "message must be string");

  const gitDir = path.join(wikiPath, ".git");
  if (!fs.existsSync(gitDir)) {
    return false; // Wiki git not initialized
  }

  try {
    // Check if there are changes
    const status = execSync("git status --porcelain", { cwd: wikiPath, stdio: "pipe", encoding: "utf-8" });
    if (!status.trim()) {
      return false; // No changes to commit
    }

    execSync("git add -A", { cwd: wikiPath, stdio: "pipe" });
    execSync(`git -c user.name="wiki" -c user.email="wiki@codebase-wiki.local" commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: wikiPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the latest commit hash in the wiki's git repo.
 */
export function getWikiGitHash(wikiPath: string): string | null {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");

  try {
    const hash = execSync("git rev-parse --short HEAD", { cwd: wikiPath, stdio: "pipe", encoding: "utf-8" });
    return hash.trim();
  } catch {
    return null;
  }
}

/**
 * Get recent wiki git log entries.
 */
export function getWikiGitLog(wikiPath: string, count: number = 5): string[] {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");

  try {
    const log = execSync(`git log --oneline -n ${count}`, { cwd: wikiPath, stdio: "pipe", encoding: "utf-8" });
    return log.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if the wiki has uncommitted changes.
 */
export function wikiHasChanges(wikiPath: string): boolean {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");

  try {
    const status = execSync("git status --porcelain", { cwd: wikiPath, stdio: "pipe", encoding: "utf-8" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}