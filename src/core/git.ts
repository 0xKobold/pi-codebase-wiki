/**
 * Git Operations Module
 *
 * Handles all git interactions: log parsing, diff analysis, blame, etc.
 * Pure functions, no globals, all validated inputs.
 *
 * Phase 2: Uses null-delimited format for robust commit parsing.
 */

import { execSync } from "child_process";
import type { GitCommit } from "../shared.js";
import { parseCommitMessage, isIngestibleCommit } from "../shared.js";
import type { IngestConfig } from "../shared.js";

// Null byte delimiter for robust git log parsing
const COMMIT_DELIM = "\x00";
const FIELD_DELIM = "\x01";

// ============================================================================
// GIT LOG PARSING
// ============================================================================

/**
 * Get recent commits with changed files
 * Uses null-delimited format for robust parsing (Phase 2)
 */
export function getRecentCommits(cwd: string, since: string = "1 week ago"): GitCommit[] {
  console.assert(typeof cwd === "string", "cwd must be string");
  console.assert(cwd.length > 0, "cwd must not be empty");

  try {
    // Use null-delimited format: hash\x01author\x01date\x01subject\x01body\x00files-list
    const logOutput = execSync(
      `git log --format="%H${FIELD_DELIM}%an${FIELD_DELIM}%aI${FIELD_DELIM}%s${FIELD_DELIM}%b" --name-only --since="${since}" -z`,
      { encoding: "utf-8", cwd, maxBuffer: 10 * 1024 * 1024 }
    );

    return parseGitLogDelimited(logOutput);
  } catch {
    // Fallback to legacy format
    try {
      const format = "%H%n%an%n%aI%n%s%n%b";
      const logOutput = execSync(
        `git log --format="${format}" --name-only --since="${since}"`,
        { encoding: "utf-8", cwd, maxBuffer: 10 * 1024 * 1024 }
      );
      return parseGitLogLegacy(logOutput);
    } catch {
      return [];
    }
  }
}

/**
 * Get all commits (for initial ingest)
 */
export function getAllCommits(cwd: string): GitCommit[] {
  console.assert(typeof cwd === "string", "cwd must be string");

  try {
    const logOutput = execSync(
      `git log --format="%H${FIELD_DELIM}%an${FIELD_DELIM}%aI${FIELD_DELIM}%s${FIELD_DELIM}%b" --name-only -z`,
      { encoding: "utf-8", cwd, maxBuffer: 50 * 1024 * 1024 }
    );

    return parseGitLogDelimited(logOutput);
  } catch {
    try {
      const format = "%H%n%an%n%aI%n%s%n%b";
      const logOutput = execSync(
        `git log --format="${format}" --name-only`,
        { encoding: "utf-8", cwd, maxBuffer: 50 * 1024 * 1024 }
      );
      return parseGitLogLegacy(logOutput);
    } catch {
      return [];
    }
  }
}

/**
 * Get commits since a specific commit hash
 */
export function getCommitsSince(cwd: string, sinceHash: string): GitCommit[] {
  console.assert(typeof cwd === "string", "cwd must be string");
  console.assert(typeof sinceHash === "string", "sinceHash must be string");

  const validHash = sinceHash.replace(/[^a-f0-9]/g, "").slice(0, 40);
  if (!validHash || validHash.length < 7) return [];

  try {
    const logOutput = execSync(
      `git log --format="%H${FIELD_DELIM}%an${FIELD_DELIM}%aI${FIELD_DELIM}%s${FIELD_DELIM}%b" --name-only -z ${validHash}..HEAD`,
      { encoding: "utf-8", cwd, maxBuffer: 50 * 1024 * 1024 }
    );

    return parseGitLogDelimited(logOutput);
  } catch {
    return [];
  }
}

/**
 * Parse null-delimited git log output (Phase 2 format)
 * Format: hash\x01author\x01date\x01subject\x01body\x00file1\x00file2\n...
 */
function parseGitLogDelimited(output: string): GitCommit[] {
  console.assert(typeof output === "string", "output must be string");

  const commits: GitCommit[] = [];
  // Split by commit boundary: each commit ends with newline before next hash
  // With -z flag, entries are null-delimited
  const rawEntries = output.split(COMMIT_DELIM).filter(e => e.trim().length > 0);

  let currentCommit: Partial<GitCommit> | null = null;
  let collectingFiles = false;
  const fileLines: string[] = [];

  for (const entry of rawEntries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    // Check if this entry contains field delimiters (commit header)
    if (trimmed.includes(FIELD_DELIM)) {
      // Save previous commit if we have one
      if (currentCommit && currentCommit.hash) {
        commits.push(finalizeCommit(currentCommit, fileLines));
        fileLines.length = 0;
      }

      const fields = trimmed.split(FIELD_DELIM);
      const hash = (fields[0] ?? "").trim();
      if (!hash || hash.length < 7) continue;

      currentCommit = {
        hash,
        author: (fields[1] ?? "").trim(),
        date: (fields[2] ?? "").trim(),
        subject: (fields[3] ?? "").trim(),
        body: (fields[4] ?? "").trim(),
      };
      collectingFiles = false;
    } else if (currentCommit) {
      // This is a file entry
      const cleanFile = trimmed.replace(/^[\n\r]+/, "").replace(/[\n\r]+$/, "");
      if (cleanFile.length > 0 && (cleanFile.includes("/") || cleanFile.includes("."))) {
        fileLines.push(cleanFile);
      }
      collectingFiles = true;
    }
  }

  // Save last commit
  if (currentCommit && currentCommit.hash) {
    commits.push(finalizeCommit(currentCommit, fileLines));
  }

  return commits.reverse(); // Oldest first
}

/**
 * Finalize a partially-parsed commit
 */
function finalizeCommit(partial: Partial<GitCommit>, files: string[]): GitCommit {
  console.assert(partial.hash !== undefined, "commit must have hash");

  const subject = partial.subject ?? "";
  const parsed = parseCommitMessage(subject);

  return {
    hash: partial.hash!,
    author: partial.author ?? "",
    date: partial.date ?? "",
    subject,
    body: partial.body ?? "",
    type: parsed.type,
    scope: parsed.scope,
    files: [...files],
  };
}

/**
 * Legacy git log parser (fallback)
 */
function parseGitLogLegacy(output: string): GitCommit[] {
  console.assert(typeof output === "string", "output must be string");

  const commits: GitCommit[] = [];
  // Split by double newline pattern between commit blocks
  const blocks = output.split(/\n(?=[a-f0-9]{40}\n)/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 4) continue;

    const hash = lines[0]!.trim();
    if (!/^[a-f0-9]{7,40}$/.test(hash)) continue;

    const author = lines[1]!.trim();
    const date = lines[2]!.trim();
    const subject = lines[3]!.trim();

    // Separate body from file list
    const bodyLines: string[] = [];
    const fileLines: string[] = [];
    let pastBody = false;

    for (let i = 4; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.length === 0) {
        pastBody = true;
        continue;
      }
      // Files contain / or .  body prose is plain text
      if (!pastBody && !line.includes("/") && !line.includes(".")) {
        bodyLines.push(line);
      } else if (line.includes("/") || line.includes(".")) {
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

  return commits.reverse();
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
    // Nested directory: normalize / to - for slug compatibility (validateSlug rejects /)
    return `${parts[1]}-${parts[2]!.replace(/\.[^.]+$/, "")}`;
  }

  // Fallback: use filename without extension
  const filename = parts[parts.length - 1]!;
  return filename.replace(/\.[^.]+$/, "");
}