/**
 * Domain Presets & Configurable Page Types Tests
 *
 * Tests: domain preset structure, template generation per domain,
 * --domain flag in init, SCHEMA.md page type config, loadPageTypes parsing,
 * pluralization, generic fallback templates.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WikiStore } from "../../src/core/store.js";
import {
  DOMAIN_PRESETS,
  DEFAULT_PAGE_TYPES,
  getDirectoryForPageType,
} from "../../src/shared.js";
import {
  loadConfig,
  wikiExists,
  generateSchemaMD,
  generateIndexMD,
  loadPageTypes,
  loadDomain,
  loadIngestionConfig,
} from "../../src/core/config.js";
import {
  getTemplateForPageType,
  getTemplatesForPageTypes,
} from "../../src/core/templates.js";

let tmpDir: string;
let wikiPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-p3-"));
  wikiPath = path.join(tmpDir, ".codebase-wiki");
  fs.mkdirSync(path.join(wikiPath, "meta"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── DOMAIN PRESETS ──────────────────────────────────────────────────────────

describe("DOMAIN_PRESETS has all expected domain types", () => {
  test("contains codebase, personal, research, and book presets", () => {
    expect(DOMAIN_PRESETS.codebase).toBeDefined();
    expect(DOMAIN_PRESETS.personal).toBeDefined();
    expect(DOMAIN_PRESETS.research).toBeDefined();
    expect(DOMAIN_PRESETS.book).toBeDefined();
  });

  test("each preset has name, description, pageTypes, and sourceTypes", () => {
    for (const [key, preset] of Object.entries(DOMAIN_PRESETS)) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.pageTypes.length).toBeGreaterThan(0);
      expect(preset.sourceTypes.length).toBeGreaterThan(0);
    }
  });

  test("codebase preset page types match DEFAULT_PAGE_TYPES", () => {
    expect(DOMAIN_PRESETS.codebase.pageTypes).toEqual(DEFAULT_PAGE_TYPES);
  });

  test("personal preset has person, topic, insight, media, habit", () => {
    const ids = DOMAIN_PRESETS.personal.pageTypes.map(pt => pt.id);
    expect(ids).toContain("person");
    expect(ids).toContain("topic");
    expect(ids).toContain("insight");
    expect(ids).toContain("media");
    expect(ids).toContain("habit");
  });

  test("research preset has paper, concept, finding, method", () => {
    const ids = DOMAIN_PRESETS.research.pageTypes.map(pt => pt.id);
    expect(ids).toContain("paper");
    expect(ids).toContain("concept");
    expect(ids).toContain("finding");
    expect(ids).toContain("method");
  });

  test("book preset has character, theme, chapter, location, quote", () => {
    const ids = DOMAIN_PRESETS.book.pageTypes.map(pt => pt.id);
    expect(ids).toContain("character");
    expect(ids).toContain("theme");
    expect(ids).toContain("chapter");
    expect(ids).toContain("location");
    expect(ids).toContain("quote");
  });
});

// ─── TEMPLATE GENERATION ─────────────────────────────────────────────────────

describe("getTemplatesForPageTypes generates templates per type", () => {
  test("codebase templates include all core page types", () => {
    const templates = getTemplatesForPageTypes(DEFAULT_PAGE_TYPES);
    expect(templates["entity.md"]).toBeDefined();
    expect(templates["concept.md"]).toBeDefined();
    expect(templates["decision.md"]).toBeDefined();
    expect(templates["evolution.md"]).toBeDefined();
    expect(templates["comparison.md"]).toBeDefined();
  });

  test("personal domain templates include person, topic, insight, media, habit", () => {
    const templates = getTemplatesForPageTypes(DOMAIN_PRESETS.personal.pageTypes);
    expect(templates["person.md"]).toBeDefined();
    expect(templates["topic.md"]).toBeDefined();
    expect(templates["insight.md"]).toBeDefined();
    expect(templates["media.md"]).toBeDefined();
    expect(templates["habit.md"]).toBeDefined();
  });

  test("research domain templates include paper, finding, method", () => {
    const templates = getTemplatesForPageTypes(DOMAIN_PRESETS.research.pageTypes);
    expect(templates["paper.md"]).toBeDefined();
    expect(templates["finding.md"]).toBeDefined();
    expect(templates["method.md"]).toBeDefined();
  });

  test("book domain templates include character, theme, chapter, location, quote", () => {
    const templates = getTemplatesForPageTypes(DOMAIN_PRESETS.book.pageTypes);
    expect(templates["character.md"]).toBeDefined();
    expect(templates["theme.md"]).toBeDefined();
    expect(templates["chapter.md"]).toBeDefined();
    expect(templates["location.md"]).toBeDefined();
    expect(templates["quote.md"]).toBeDefined();
  });

  test("templates contain page type name", () => {
    const templates = getTemplatesForPageTypes(DOMAIN_PRESETS.personal.pageTypes);
    expect(templates["person.md"]).toContain("Person");
    expect(templates["topic.md"]).toContain("Topic");
    expect(templates["insight.md"]).toContain("Insight");
  });
});

describe("getTemplateForPageType produces content for each type", () => {
  test("generates entity template with required sections", () => {
    const pt = DEFAULT_PAGE_TYPES.find(p => p.id === "entity")!;
    const content = getTemplateForPageType(pt);
    expect(content).toContain("Summary");
    expect(content).toContain("See Also");
  });

  test("generates generic fallback for unknown page type", () => {
    const pt = { id: "custom", name: "Custom", directory: "customs", template: "", requiredSections: ["Notes"], sourceTypes: [], icon: "" };
    const content = getTemplateForPageType(pt);
    expect(content).toContain("Custom");
    expect(content).toContain("Notes");
  });
});

// ─── SCHEMA.MD DOMAIN & PAGE TYPE CONFIG ─────────────────────────────────────

describe("generateSchemaMD includes domain and page type config", () => {
  test("default schema has codebase domain", () => {
    const schema = generateSchemaMD("test-project");
    expect(schema).toContain("Domain");
    expect(schema).toContain("codebase");
    expect(schema).toContain("Page Types Config");
  });

  test("personal domain schema has Domain: personal", () => {
    const schema = generateSchemaMD("test-project", "personal", DOMAIN_PRESETS.personal.pageTypes);
    expect(schema).toContain("personal");
    expect(schema).toContain("person");
    expect(schema).toContain("topic");
  });

  test("page type config section lists all page types", () => {
    const schema = generateSchemaMD("test-project", "codebase", DEFAULT_PAGE_TYPES);
    expect(schema).toContain("id: entity");
    expect(schema).toContain("id: concept");
    expect(schema).toContain("id: decision");
  });
});

// ─── INDEX.MD DYNAMIC SECTIONS ───────────────────────────────────────────────

describe("generateIndexMD creates sections per page type", () => {
  test("default index has Entities section", () => {
    const index = generateIndexMD("my-project");
    expect(index).toContain("my-project");
    expect(index).toContain("Entities");
    expect(index).toContain("Concepts");
    expect(index).toContain("Decisions");
  });

  test("personal domain index has People and Topics", () => {
    const index = generateIndexMD("my-journal", "personal", DOMAIN_PRESETS.personal.pageTypes);
    expect(index).toContain("People");
    expect(index).toContain("Topics");
    expect(index).toContain("Insights");
  });

  test("book domain index has Characters and Themes", () => {
    const index = generateIndexMD("my-book", "book", DOMAIN_PRESETS.book.pageTypes);
    expect(index).toContain("Characters");
    expect(index).toContain("Themes");
  });

  test("Query pluralizes to Queries not Querys", () => {
    const index = generateIndexMD("test", "codebase", DEFAULT_PAGE_TYPES);
    expect(index).toContain("Queries");
    expect(index).not.toContain("Querys");
  });
});

// ─── LOAD PAGE TYPES FROM SCHEMA ─────────────────────────────────────────────

describe("loadPageTypes parses page types from SCHEMA.md", () => {
  test("returns DEFAULT_PAGE_TYPES when SCHEMA.md has no config section", () => {
    const schemaPath = path.join(wikiPath, "SCHEMA.md");
    fs.writeFileSync(schemaPath, "# Test Schema\n\nNo page types here.\n");
    const result = loadPageTypes(schemaPath);
    expect(result).toEqual(DEFAULT_PAGE_TYPES);
  });

  test("returns DEFAULT_PAGE_TYPES when SCHEMA.md doesn't exist", () => {
    const result = loadPageTypes(path.join(wikiPath, "nonexistent.md"));
    expect(result).toEqual(DEFAULT_PAGE_TYPES);
  });

  test("parses page type config from SCHEMA.md", () => {
    const schemaPath = path.join(wikiPath, "SCHEMA.md");
    fs.writeFileSync(schemaPath, `# Test Schema

## Page Types Config

- id: person
  name: Person
  directory: people
  template: person.md
  requiredSections: [Summary, See Also]
  sourceTypes: [note, conversation]
  icon: 👤

- id: topic
  name: Topic
  directory: topics
  template: topic.md
  requiredSections: [Summary, Key Ideas]
  sourceTypes: [article, note]
  icon: 💡
`);
    const result = loadPageTypes(schemaPath);
    expect(result.length).toBe(2);
    expect(result[0]!.id).toBe("person");
    expect(result[0]!.name).toBe("Person");
    expect(result[0]!.directory).toBe("people");
    expect(result[1]!.id).toBe("topic");
  });
});

describe("loadDomain parses domain from SCHEMA.md", () => {
  test("returns codebase when no domain specified", () => {
    const schemaPath = path.join(wikiPath, "SCHEMA.md");
    fs.writeFileSync(schemaPath, "# Test Schema\n\nSome content.\n");
    expect(loadDomain(schemaPath)).toBe("codebase");
  });

  test("returns codebase when file doesn't exist", () => {
    expect(loadDomain(path.join(wikiPath, "nonexistent.md"))).toBe("codebase");
  });

  test("parses Domain from SCHEMA.md", () => {
    const schemaPath = path.join(wikiPath, "SCHEMA.md");
    fs.writeFileSync(schemaPath, "# Schema\n\n**Domain**: personal\n\nMore content.\n");
    expect(loadDomain(schemaPath)).toBe("personal");
  });

  test("parses book domain", () => {
    const schemaPath = path.join(wikiPath, "SCHEMA.md");
    fs.writeFileSync(schemaPath, "# Schema\n\n**Domain**: book\n\nContent.\n");
    expect(loadDomain(schemaPath)).toBe("book");
  });
});

// ─── DIRECTORY RESOLUTION ─────────────────────────────────────────────────────

describe("getDirectoryForPageType works with domain presets", () => {
  test("personal domain page types resolve to correct directories", () => {
    const pt = DOMAIN_PRESETS.personal.pageTypes;
    expect(getDirectoryForPageType("person", pt)).toBe("people");
    expect(getDirectoryForPageType("topic", pt)).toBe("topics");
    expect(getDirectoryForPageType("insight", pt)).toBe("insights");
  });

  test("book domain page types resolve to correct directories", () => {
    const pt = DOMAIN_PRESETS.book.pageTypes;
    expect(getDirectoryForPageType("character", pt)).toBe("characters");
    expect(getDirectoryForPageType("theme", pt)).toBe("themes");
    expect(getDirectoryForPageType("chapter", pt)).toBe("chapters");
  });

  test("unknown type falls back to type + 's'", () => {
    expect(getDirectoryForPageType("whatever")).toBe("whatevers");
  });
});

describe("loadIngestionConfig parses SCHEMA.md ingestion mode", () => {
  let tmpDir: string;
  let schemaPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-schema-ingest-"));
    schemaPath = path.join(tmpDir, "SCHEMA.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("defaults to auto mode when no ingestion config", () => {
    fs.writeFileSync(schemaPath, generateSchemaMD("test", "codebase"));
    const config = loadIngestionConfig(schemaPath);
    expect(config.mode).toBe("auto");
    expect(config.thresholds.newPageCreation).toBe(false);
  });

  test("parses confirm mode from SCHEMA.md", () => {
    const schema = generateSchemaMD("test", "codebase", undefined, "confirm" as any);
    fs.writeFileSync(schemaPath, schema);
    const config = loadIngestionConfig(schemaPath);
    expect(config.mode).toBe("confirm");
  });

  test("parses guided mode from SCHEMA.md", () => {
    const schema = generateSchemaMD("test", "codebase", undefined, "guided" as any);
    fs.writeFileSync(schemaPath, schema);
    const config = loadIngestionConfig(schemaPath);
    expect(config.mode).toBe("guided");
  });

  test("falls back to auto for missing schema file", () => {
    const config = loadIngestionConfig("/nonexistent/path/SCHEMA.md");
    expect(config.mode).toBe("auto");
  });

  test("falls back to auto for invalid mode", () => {
    const schema = "# Test Wiki Schema\n\n**Domain**: codebase\n\n**Ingestion Mode**: invalid\n";
    fs.writeFileSync(schemaPath, schema);
    const config = loadIngestionConfig(schemaPath);
    expect(config.mode).toBe("auto");
  });
});