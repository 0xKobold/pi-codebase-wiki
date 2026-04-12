/**
 * Git Operations Module
 *
 * Handles all git interactions: log parsing, diff analysis, blame, etc.
 * Pure functions, no globals, all validated inputs.
 */

import { execSync } from "child_process";
import type { GitCommit } from "../shared.js";
import { parseCommitMessage, isIngestibleCommit } from "../shared.js";
import type { IngestConfig } from "../shared.js";

// ============================================================================
// GIT LOG PARSING
// ============================================================================

/**
 * Get recent commits with changed files
 */
export function getRecentCommits(cwd: string, since: string = "1 week ago"): GitCommit[] {
  console.assert(typeof cwd === "string", "cwd must be string");
  console.assert(cwd.length > 0, "cwd must not be empty");

  try {
    const format = "%H%n%an%n%ad%n%s%n%b%n---COMMIT_END---";
    const logOutput = execSync(
      `git log --format="${format}" --name-only --since="${since}"`,
      { encoding: "utf-8", cwd, maxBuffer: 10 * 1024 * 1024 }
    );

    return parseGitLog(logOutput);
  } catch {
    return [];
  }
}

/**
 * Get all commits (for initial ingest)
 */
export function getAllCommits(cwd: string): GitCommit[] {
  console.assert(typeof cwd === "string", "cwd must be string");

  try {
    const format = "%H%n%an%n%ad%n%s%n%b%n---COMMIT_END---";
    const logOutput = execSync(
      `git log --format="${format}" --name-only`,
      { encoding: "utf-8", cwd, maxBuffer: 50 * 1024 * 1024 }
    );

    return parseGitLog(logOutput);
  } catch {
    return [];
  }
}

/**
 * Get commits since a specific commit hash
 */
export function getCommitsSince(cwd: string, sinceHash: string): GitCommit[] {
  console.assert(typeof cwd === "string", "cwd must be string");
  console.assert(typeof sinceHash === "string", "sinceHash must be string");

  try {
    const format = "%H%n%an%n%ad%n%s%n%b%n---COMMIT_END---";
    const logOutput = execSync(
      `git log --format="${format}" --name-only ${sinceHash}..HEAD`,
      { encoding: "utf-8", cwd, maxBuffer: 50 * 1024 * 1024 }
    );

    return parseGitLog(logOutput);
  } catch {
    return [];
  }
}

/**
 * Parse git log output into GitCommit objects
 */
function parseGitLog(output: string): GitCommit[] {
  console.assert(typeof output === "string", "output must be string");

  const commits: GitCommit[] = [];
  const commitBlocks = output.split("---COMMIT_END---").filter(block => block.trim().length > 0);

  for (const block of commitBlocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 4) continue;

    const hash = lines[0]!.trim();
    const author = lines[1]!.trim();
    const date = lines[2]!.trim();
    const subject = lines[3]!.trim();

    // Body is between subject and file list
    const bodyLines: string[] = [];
    const fileLines: string[] = [];
    let inBody = true;

    for (let i = 4; i < lines.length; i++) {
      const line = lines[i]!.trim();
      // Files don't start with letters usually (paths), body lines do
      if (inBody && line.length > 0 && !line.includes(".") && !line.includes("/")) {
        bodyLines.push(line);
      } else if (line.length > 0) {
        inBody = false;
        fileLines.push(line);
      }
    }

    const parsed = parseCommitMessage(subject);

    commits.push({
      hash,
      author,
      date,
      subject,
      body: bodyLines.join("\n"),
      type: parsed.type,
      scope: parsed.scope,
      files: fileLines,
    });
  }

  return commits.reverse(); // Oldest first
}

// ============================================================================
// DIFF ANALYSIS
// ============================================================================

/**
 * Get diff for a specific commit
 */
export function getCommitDiff(cwd: string, hash: string): string {
  console.assert(typeof cwd === "string", "cwd must be string");
  console.assert(typeof hash === "string", "hash must not be empty");

  try {
    return execSync(`git show --stat ${hash}`, {
      encoding: "utf-8",
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/**
 * Get diff between two commits
 */
export function getDiffBetween(cwd: string, from: string, to: string): string {
  console.assert(typeof cwd === "string", "cwd must be string");

  try {
    return execSync(`git diff --stat ${from}..${to}`, {
      encoding: "utf-8",
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

// ============================================================================
// FILE TREE
// ============================================================================

/**
 * Get all tracked files in the repo
 */
export function getTrackedFiles(cwd: string): string[] {
  console.assert(typeof cwd === "string", "cwd must be string");

  try {
    const output = execSync("git ls-files", {
      encoding: "utf-8",
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return output.trim().split("\n").filter(f => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Get the current git branch
 */
export function getCurrentBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      cwd,
    }).trim();
  } catch {
    return "main";
  }
}

/**
 * Get the repo root directory
 */
export function getRepoRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd,
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * Get the latest commit hash
 */
export function getLatestHash(cwd: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      cwd,
    }).trim();
  } catch {
    return "";
  }
}

// ============================================================================
// INGEST FILTERING
// ============================================================================

/**
 * Filter commits by ingestibility
 */
export function filterIngestibleCommits(commits: GitCommit[], config: IngestConfig): GitCommit[] {
  console.assert(Array.isArray(commits), "commits must be array");

  return commits.filter(commit => isIngestibleCommit(commit, config));
}

/**
 * Group commits by scope
 */
export function groupCommitsByScope(commits: GitCommit[]): Map<string, GitCommit[]> {
  const groups = new Map<string, GitCommit[]>();

  for (const commit of commits) {
    const scope = commit.scope || "_root";
    const existing = groups.get(scope) || [];
    existing.push(commit);
    groups.set(scope, existing);
  }

  return groups;
}

/**
 * Extract unique file paths from commits
 */
export function extractChangedFiles(commits: GitCommit[]): string[] {
  const files = new Set<string>();
  for (const commit of commits) {
    for (const file of commit.files) {
      files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * Infer entity name from file paths
 */
export function inferEntityFromPath(filePath: string): string {
  // src/extensions/core/git-commit-extension.ts → git-commit-extension
  // packages/pi-learn/src/index.ts → pi-learn
  const parts = filePath.split("/");

  // Check for packages/pi-X pattern
  if (parts.length >= 2 && parts[0] === "packages") {
    return parts[1]!;
  }

  // Check for src/X pattern
  if (parts.length >= 3 && parts[0] === "src") {
    // src/core/store.ts → core
    // src/extensions/core/git-commit.ts → extensions/git-commit
    if (parts[2]!.endsWith(".ts") || parts[2]!.endsWith(".tsx")) {
      return parts[1]!;
    }
    return `${parts[1]}/${parts[2]!.replace(/\.[^.]+$/, "")}`;
  }

  // Fallback: use filename without extension
  const filename = parts[parts.length - 1]!;
  return filename.replace(/\.[^.]+$/, "");
}