/**
 * Phase 0 Tests — Foundation Refactor
 *
 * Tests for: PageType as string, PageTypeConfig, SourceManifest,
 * frontmatter parsing, domain presets, getDirectoryForPageType.
 */

import { test, expect, describe } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  PageType,
  PageTypeConfig,
  SourceManifest,
  SourceType,
  BUILTIN_PAGE_TYPES,
  DEFAULT_PAGE_TYPES,
  DOMAIN_PRESETS,
  getDirectoryForPageType,
  DEFAULT_WIKI_CONFIG,
  toSlug,
  validateSlug,
} from "../../src/shared.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  stripFrontmatter,
  hasFrontmatter,
} from "../../src/core/frontmatter.js";

// ============================================================================
// PageType IS STRING (backward compatible)
// ============================================================================

describe("PageType is string", () => {
  test("accepts any string value", () => {
    const t: PageType = "entity";
    expect(t).toBe("entity");

    const custom: PageType = "person";
    expect(custom).toBe("person");

    const chapter: PageType = "chapter";
    expect(chapter).toBe("chapter");
  });

  test("BUILTIN_PAGE_TYPES contains all original types", () => {
    expect(BUILTIN_PAGE_TYPES).toContain("entity");
    expect(BUILTIN_PAGE_TYPES).toContain("concept");
    expect(BUILTIN_PAGE_TYPES).toContain("decision");
    expect(BUILTIN_PAGE_TYPES).toContain("evolution");
    expect(BUILTIN_PAGE_TYPES).toContain("comparison");
    expect(BUILTIN_PAGE_TYPES).toContain("query");
    expect(BUILTIN_PAGE_TYPES.length).toBe(9);
  });
});

// ============================================================================
// PageTypeConfig
// ============================================================================

describe("PageTypeConfig", () => {
  test("DEFAULT_PAGE_TYPES has all expected entries", () => {
    expect(DEFAULT_PAGE_TYPES.length).toBe(9);

    const entityConfig = DEFAULT_PAGE_TYPES.find(pt => pt.id === "entity");
    expect(entityConfig).toBeDefined();
    expect(entityConfig!.directory).toBe("entities");
    expect(entityConfig!.template).toBe("entity.md");
    expect(entityConfig!.icon).toBe("📦");
  });

  test("each config has required fields", () => {
    for (const pt of DEFAULT_PAGE_TYPES) {
      expect(pt.id).toBeTruthy();
      expect(pt.name).toBeTruthy();
      expect(pt.requiredSections).toBeInstanceOf(Array);
    }
  });
});

// ============================================================================
// DOMAIN_PRESETS
// ============================================================================

describe("Domain presets", () => {
  test("has codebase preset that matches DEFAULT_PAGE_TYPES", () => {
    expect(DOMAIN_PRESETS.codebase).toBeDefined();
    expect(DOMAIN_PRESETS.codebase.pageTypes).toBe(DEFAULT_PAGE_TYPES);
    expect(DOMAIN_PRESETS.codebase.name).toBe("Codebase");
  });

  test("has personal preset with correct page types", () => {
    expect(DOMAIN_PRESETS.personal).toBeDefined();
    const types = DOMAIN_PRESETS.personal.pageTypes.map(pt => pt.id);
    expect(types).toContain("person");
    expect(types).toContain("topic");
    expect(types).toContain("insight");
    expect(types).toContain("media");
    expect(types).toContain("habit");
  });

  test("has research preset", () => {
    expect(DOMAIN_PRESETS.research).toBeDefined();
    const types = DOMAIN_PRESETS.research.pageTypes.map(pt => pt.id);
    expect(types).toContain("paper");
    expect(types).toContain("concept");
    expect(types).toContain("finding");
  });

  test("has book preset", () => {
    expect(DOMAIN_PRESETS.book).toBeDefined();
    const types = DOMAIN_PRESETS.book.pageTypes.map(pt => pt.id);
    expect(types).toContain("character");
    expect(types).toContain("theme");
    expect(types).toContain("chapter");
    expect(types).toContain("location");
    expect(types).toContain("quote");
  });

  test("each preset has name and description", () => {
    for (const [key, preset] of Object.entries(DOMAIN_PRESETS)) {
      expect(preset.name).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.pageTypes.length).toBeGreaterThan(0);
      expect(preset.sourceTypes.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// getDirectoryForPageType
// ============================================================================

describe("getDirectoryForPageType", () => {
  test("returns correct directory for builtin types", () => {
    expect(getDirectoryForPageType("entity")).toBe("entities");
    expect(getDirectoryForPageType("concept")).toBe("concepts");
    expect(getDirectoryForPageType("decision")).toBe("decisions");
    expect(getDirectoryForPageType("evolution")).toBe("evolution");
    expect(getDirectoryForPageType("comparison")).toBe("comparisons");
    expect(getDirectoryForPageType("query")).toBe("queries");
  });

  test("falls back to type + 's' for unknown types", () => {
    expect(getDirectoryForPageType("person")).toBe("persons");
    expect(getDirectoryForPageType("chapter")).toBe("chapters");
  });

  test("uses custom page types when provided", () => {
    const customTypes: PageTypeConfig[] = [
      { id: "person", name: "Person", directory: "people", template: "person.md", requiredSections: ["Summary"] },
    ];
    expect(getDirectoryForPageType("person", customTypes)).toBe("people");
  });
});

// ============================================================================
// WikiConfig defaults
// ============================================================================

describe("WikiConfig v2 defaults", () => {
  test("DEFAULT_WIKI_CONFIG has domain and pageTypes", () => {
    expect(DEFAULT_WIKI_CONFIG.domain).toBe("codebase");
    expect(DEFAULT_WIKI_CONFIG.pageTypes).toBe(DEFAULT_PAGE_TYPES);
    expect(DEFAULT_WIKI_CONFIG.ingestionMode).toBe("auto");
    expect(DEFAULT_WIKI_CONFIG.ingestionThresholds.newPageCreation).toBe(false);
    expect(DEFAULT_WIKI_CONFIG.ingestionThresholds.contradictionResolution).toBe(true);
  });
});

// ============================================================================
// FRONTMATTER
// ============================================================================

describe("parseFrontmatter", () => {
  test("parses frontmatter from a page with frontmatter", () => {
    const content = `---
id: auth-module
type: entity
title: Auth Module
links:
  - event-bus
  - oauth-flow
---

# Auth Module

> **Summary**: Handles authentication`;

    const { metadata, body } = parseFrontmatter(content);
    expect(metadata.id).toBe("auth-module");
    expect(metadata.type).toBe("entity");
    expect(metadata.title).toBe("Auth Module");
    expect(metadata.links).toEqual(["event-bus", "oauth-flow"]);
    expect(body.trim()).toBe("# Auth Module\n\n> **Summary**: Handles authentication");
  });

  test("returns empty metadata for pages without frontmatter", () => {
    const content = "# Auth Module\n\n> **Summary**: Handles authentication";
    const { metadata, body } = parseFrontmatter(content);
    expect(Object.keys(metadata).length).toBe(0);
    expect(body).toBe(content);
  });

  test("handles boolean and number values", () => {
    const content = `---
stale: true
count: 42
---
Body`;
    const { metadata } = parseFrontmatter(content);
    expect(metadata.stale).toBe(true);
    expect(metadata.count).toBe(42);
  });

  test("handles quoted strings", () => {
    const content = `---
title: "Auth Module: The Definitive Guide"
---
Body`;
    const { metadata } = parseFrontmatter(content);
    expect(metadata.title).toBe("Auth Module: The Definitive Guide");
  });

  test("handles empty arrays", () => {
    const content = `---
sourceIds: []
---
Body`;
    const { metadata } = parseFrontmatter(content);
    expect(metadata.sourceIds).toEqual([]);
  });
});

describe("serializeFrontmatter", () => {
  test("serializes metadata to YAML frontmatter", () => {
    const metadata = {
      id: "auth-module",
      type: "entity",
      title: "Auth Module",
      links: ["event-bus", "oauth-flow"],
    };
    const body = "# Auth Module\n\nContent here.";
    const result = serializeFrontmatter(metadata, body);

    expect(result).toContain("---");
    expect(result).toContain("auth-module");
    expect(result).toContain("entity");
    expect(result).toContain("event-bus");
    expect(result).toContain("# Auth Module");
  });

  test("returns body unchanged when metadata is empty", () => {
    const body = "# Just content\n\nNo frontmatter.";
    const result = serializeFrontmatter({}, body);
    expect(result).toBe(body);
  });
});

describe("stripFrontmatter", () => {
  test("strips frontmatter from content", () => {
    const content = `---
id: test
---
# Body`;
    expect(stripFrontmatter(content)).toBe("# Body");
  });

  test("returns content unchanged if no frontmatter", () => {
    const content = "# Just content";
    expect(stripFrontmatter(content)).toBe(content);
  });
});

describe("hasFrontmatter", () => {
  test("detects frontmatter", () => {
    const content = `---
id: test
---
# Body`;
    expect(hasFrontmatter(content)).toBe(true);
  });

  test("detects absence of frontmatter", () => {
    expect(hasFrontmatter("# No frontmatter")).toBe(false);
  });
});

// ============================================================================
// SourceManifest TYPE
// ============================================================================

describe("SourceManifest type", () => {
  test("creates a valid source manifest", () => {
    const manifest: SourceManifest = {
      id: "src-article-oauth",
      type: "article",
      title: "Understanding OAuth 2.0",
      path: "sources/articles/src-article-oauth.md",
      hash: "abc123def456",
      ingestedAt: new Date().toISOString(),
      pagesCreated: ["oauth-flow", "auth-module"],
      metadata: { url: "https://example.com/oauth" },
    };

    expect(manifest.id).toBe("src-article-oauth");
    expect(manifest.type).toBe("article");
    expect(manifest.pagesCreated.length).toBe(2);
  });

  test("SourceType accepts all defined types", () => {
    const types: SourceType[] = [
      "git-commits", "article", "note", "conversation",
      "document", "url", "media", "manual",
    ];
    expect(types.length).toBe(8);
    for (const t of types) {
      expect(typeof t).toBe("string");
    }
  });
});