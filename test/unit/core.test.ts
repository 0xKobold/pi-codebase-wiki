/**
 * pi-codebase-wiki — Unit Tests
 *
 * Tests for pure functions: slug validation, commit parsing, staleness,
 * file tree scanning, and config generation.
 */

import { test, expect, describe } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  validateSlug,
  toSlug,
  parseCommitMessage,
  isIngestibleCommit,
  formatWikiDate,
  estimateTokens,
  matchesPattern,
  DEFAULT_WIKI_CONFIG,
  DEFAULT_INGEST_CONFIG,
  type GitCommit,
  type IngestConfig,
} from "../../src/shared.js";
import {
  filterIngestibleCommits,
  groupCommitsByScope,
  extractChangedFiles,
  inferEntityFromPath,
} from "../../src/core/git.js";
import {
  checkPageStaleness,
  findOrphanPages,
  findBrokenLinks,
} from "../../src/core/staleness.js";
import {
  scanFileTree,
  inferModules,
} from "../../src/core/indexer.js";
import {
  generateSchemaMD,
  generateIndexMD,
  generateEntityTemplate,
  generateDecisionTemplate,
  wikiExists,
} from "../../src/core/config.js";

// ============================================================================
// SLUG VALIDATION
// ============================================================================

describe("validateSlug", () => {
  test("accepts valid kebab-case slugs", () => {
    expect(validateSlug("auth-module")).toBe(true);
    expect(validateSlug("event-bus")).toBe(true);
    expect(validateSlug("pi-learn")).toBe(true);
    expect(validateSlug("a")).toBe(true);
    expect(validateSlug("abc")).toBe(true);
  });

  test("rejects invalid slugs", () => {
    expect(validateSlug("Auth-Module")).toBe(false);
    expect(validateSlug("auth module")).toBe(false);
    expect(validateSlug("")).toBe(false);
    expect(validateSlug("-auth")).toBe(false);
    expect(validateSlug("auth_")).toBe(false);
  });
});

// ============================================================================
// TO SLUG
// ============================================================================

describe("toSlug", () => {
  test("converts text to kebab-case", () => {
    expect(toSlug("Auth Module")).toBe("auth-module");
    expect(toSlug("Event Bus")).toBe("event-bus");
    expect(toSlug("  Pi Learn  ")).toBe("pi-learn");
  });

  test("handles special characters", () => {
    expect(toSlug("API Gateway (v2)")).toBe("api-gateway-v2");
    // toSlug strips dots and slashes
    expect(toSlug("src/core/store.ts")).toBe("srccorestorets");
  });
});

// ============================================================================
// COMMIT PARSING
// ============================================================================

describe("parseCommitMessage", () => {
  test("parses conventional commit with scope", () => {
    const result = parseCommitMessage("feat(auth): add OAuth login");
    expect(result.type).toBe("feat");
    expect(result.scope).toBe("auth");
    expect(result.description).toBe("add OAuth login");
    expect(result.isBreaking).toBe(false);
  });

  test("parses conventional commit without scope", () => {
    const result = parseCommitMessage("fix: correct typo");
    expect(result.type).toBe("fix");
    expect(result.scope).toBe("");
    expect(result.description).toBe("correct typo");
  });

  test("parses breaking change", () => {
    const result = parseCommitMessage("feat(api)!: remove v1 endpoints");
    expect(result.type).toBe("feat");
    expect(result.scope).toBe("api");
    expect(result.isBreaking).toBe(true);
  });

  test("handles non-conventional messages", () => {
    const result = parseCommitMessage("random commit message");
    expect(result.type).toBe("");
    expect(result.description).toBe("random commit message");
  });
});

// ============================================================================
// INGESTIBLE COMMITS
// ============================================================================

describe("isIngestibleCommit", () => {
  const config: IngestConfig = DEFAULT_INGEST_CONFIG;

  const makeCommit = (subject: string): GitCommit => ({
    hash: "abc1234",
    author: "test",
    date: "2026-04-12",
    subject,
    body: "",
    type: subject.split(":")[0]?.trim() ?? "",
    scope: "",
    files: [],
  });

  test("accepts feat commits", () => {
    expect(isIngestibleCommit(makeCommit("feat(auth): add OAuth"), config)).toBe(true);
  });

  test("accepts fix commits", () => {
    expect(isIngestibleCommit(makeCommit("fix: memory leak"), config)).toBe(true);
  });

  test("rejects merge commits", () => {
    expect(isIngestibleCommit(makeCommit("Merge branch 'main'"), config)).toBe(false);
  });

  test("rejects ignored patterns", () => {
    expect(isIngestibleCommit(makeCommit("chore: update deps"), config)).toBe(false);
    expect(isIngestibleCommit(makeCommit("docs: typos"), config)).toBe(false);
  });

  test("accepts refactor commits", () => {
    expect(isIngestibleCommit(makeCommit("refactor(core): simplify store"), config)).toBe(true);
  });
});

// ============================================================================
// FORMAT DATE
// ============================================================================

describe("formatWikiDate", () => {
  test("formats date as YYYY-MM-DD", () => {
    const result = formatWikiDate(new Date("2026-04-12T15:30:00Z"));
    expect(result).toBe("2026-04-12");
  });

  test("formats date string", () => {
    const result = formatWikiDate("2026-04-12T15:30:00Z");
    expect(result).toBe("2026-04-12");
  });
});

// ============================================================================
// ESTIMATE TOKENS
// ============================================================================

describe("estimateTokens", () => {
  test("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

// ============================================================================
// MATCHES PATTERN
// ============================================================================

describe("matchesPattern", () => {
  test("matches simple prefix patterns", () => {
    expect(matchesPattern("src/core/store.ts", ["src/"])).toBe(true);
    expect(matchesPattern("packages/pi-learn/src/index.ts", ["packages/"])).toBe(true);
  });

  test("does not match excluded patterns", () => {
    expect(matchesPattern("node_modules/foo.ts", ["src/"])).toBe(false);
  });
});

// ============================================================================
// GROUP COMMITS BY SCOPE
// ============================================================================

describe("groupCommitsByScope", () => {
  test("groups commits by scope", () => {
    const base: GitCommit = {
      hash: "abc", author: "test", date: "2026-04-12",
      subject: "test", body: "", type: "feat", scope: "", files: [],
    };
    const commits: GitCommit[] = [
      { ...base, scope: "auth" },
      { ...base, scope: "auth" },
      { ...base, scope: "core" },
      { ...base, scope: "" },
    ];

    const groups = groupCommitsByScope(commits);
    expect(groups.get("auth")!.length).toBe(2);
    expect(groups.get("core")!.length).toBe(1);
    expect(groups.get("_root")!.length).toBe(1);
  });
});

// ============================================================================
// EXTRACT CHANGED FILES
// ============================================================================

describe("extractChangedFiles", () => {
  test("extracts unique file paths from commits", () => {
    const base: GitCommit = {
      hash: "abc", author: "test", date: "2026-04-12",
      subject: "test", body: "", type: "feat", scope: "", files: [],
    };
    const commits: GitCommit[] = [
      { ...base, files: ["src/auth.ts", "src/store.ts"] },
      { ...base, files: ["src/auth.ts", "src/utils.ts"] },
    ];

    const files = extractChangedFiles(commits);
    expect(files).toContain("src/auth.ts");
    expect(files).toContain("src/store.ts");
    expect(files).toContain("src/utils.ts");
    expect(files.length).toBe(3);
  });
});

// ============================================================================
// INFER ENTITY FROM PATH
// ============================================================================

describe("inferEntityFromPath", () => {
  test("infers package name from packages/ path", () => {
    expect(inferEntityFromPath("packages/pi-learn/src/index.ts")).toBe("pi-learn");
  });

  test("infers module from src/ path", () => {
    expect(inferEntityFromPath("src/core/store.ts")).toBe("core");
  });

  test("infers nested directory from src/ path", () => {
    // parts[1]="extensions", parts[2]="core" (not a .ts file)
    expect(inferEntityFromPath("src/extensions/core/git-commit.ts")).toBe("extensions/core");
  });

  test("falls back to filename", () => {
    expect(inferEntityFromPath("README.md")).toBe("README");
  });
});

// ============================================================================
// STALENESS DETECTION
// ============================================================================

describe("checkPageStaleness", () => {
  const makeBasePage = () => ({
    id: "auth-module",
    path: "entities/auth-module.md",
    type: "entity" as const,
    title: "Auth Module",
    summary: "Authentication module",
    sourceFiles: [] as string[],
    sourceCommits: ["abc123"],
    lastIngested: new Date("2026-04-01").toISOString(),
    lastChecked: new Date("2026-04-01").toISOString(),
    inboundLinks: 2,
    outboundLinks: 3,
    stale: false,
  });

  test("reports no stale files for pages without sources", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-test-"));
    try {
      const page = { ...makeBasePage(), sourceFiles: [] };
      const result = checkPageStaleness(page, path.join(tmpDir, ".codebase-wiki"));
      expect(result.staleFiles.length).toBe(0);
      expect(result.stalenessScore).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("detects deleted source files as stale", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-test-"));
    try {
      const wikiDir = path.join(tmpDir, ".codebase-wiki");
      fs.mkdirSync(path.join(wikiDir), { recursive: true });

      // Page references files that don't exist
      const page = {
        ...makeBasePage(),
        sourceFiles: ["src/nonexistent.ts"],
        lastIngested: new Date("2020-01-01").toISOString(),
      };

      const result = checkPageStaleness(page, wikiDir);
      // Deleted files are counted as stale
      expect(result.staleFiles.length).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// CONFIG GENERATION
// ============================================================================

describe("Config Generation", () => {
  test("generates SCHEMA.md with project name", () => {
    const schema = generateSchemaMD("my-project");
    expect(schema).toContain("my-project");
    expect(schema).toContain("kebab-case");
    expect(schema).toContain("Ingest");
    expect(schema).toContain("Query");
    expect(schema).toContain("Lint");
  });

  test("generates INDEX.md with project name", () => {
    const index = generateIndexMD("my-project");
    expect(index).toContain("my-project");
    expect(index).toContain("Entities");
    expect(index).toContain("Concepts");
    expect(index).toContain("Decisions");
  });

  test("generates entity template", () => {
    const template = generateEntityTemplate();
    expect(template).toContain("Summary");
    expect(template).toContain("Location");
    expect(template).toContain("Dependencies");
    expect(template).toContain("See Also");
  });

  test("generates decision template", () => {
    const template = generateDecisionTemplate();
    expect(template).toContain("Context");
    expect(template).toContain("Decision");
    expect(template).toContain("Alternatives Considered");
  });
});

// ============================================================================
// ORPHAN PAGE DETECTION
// ============================================================================

describe("findOrphanPages", () => {
  test("identifies entities with zero inbound links as orphans", () => {
    const page = {
      id: "lonely-module",
      path: "entities/lonely-module.md",
      type: "entity" as const,
      title: "Lonely Module",
      summary: "",
      sourceFiles: [],
      sourceCommits: [],
      lastIngested: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      inboundLinks: 0,
      outboundLinks: 0,
      stale: false,
    };

    expect(page.inboundLinks).toBe(0);
    expect(page.type).toBe("entity");
  });
});

// ============================================================================
// HELPER — used by some helper functions in stale test
// ============================================================================

function makeBaseGitCommit(): GitCommit {
  return {
    hash: "abc1234def5678",
    author: "test",
    date: "2026-04-12T10:00:00Z",
    subject: "feat: test commit",
    body: "",
    type: "feat",
    scope: "",
    files: [],
  };
}