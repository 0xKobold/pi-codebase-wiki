import * as fs from "fs";
import * as path from "path";

/**
 * Frontmatter Module — Parse and serialize YAML frontmatter for wiki pages.
 *
 * Frontmatter is optional — pages without it still work (backward compatible).
 * When present, it provides machine-readable metadata for Obsidian, Dataview,
 * and the wiki's own lint system.
 *
 * NASA-10: small functions, validation, no globals.
 */

// ============================================================================
// PARSING
// ============================================================================

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Parse YAML frontmatter from a markdown page.
 * Returns { metadata, body } — metadata is a simple key-value map, body is the rest.
 *
 * Handles:
 * - Pages with frontmatter: extracts metadata and strips the frontmatter block
 * - Pages without frontmatter: returns empty metadata and the full content
 * - Malformed frontmatter: treats as no frontmatter (graceful degradation)
 */
export function parseFrontmatter(content: string): { metadata: Record<string, any>; body: string } {
  console.assert(typeof content === "string", "content must be string");

  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const rawFrontmatter = match[1]!;
  const body = content.slice(match[0].length);
  const metadata = parseSimpleYaml(rawFrontmatter);

  return { metadata, body };
}

/**
 * Serialize metadata as YAML frontmatter and prepend to body.
 * Always produces consistent, readable frontmatter.
 */
export function serializeFrontmatter(metadata: Record<string, any>, body: string): string {
  console.assert(typeof metadata === "object", "metadata must be object");
  console.assert(typeof body === "string", "body must be string");

  if (Object.keys(metadata).length === 0) {
    return body;
  }

  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${serializeYamlValue(item)}`);
        }
      }
    } else {
      lines.push(`${key}: ${serializeYamlValue(value)}`);
    }
  }
  lines.push("---");
  lines.push("");

  return lines.join("\n") + body;
}

/**
 * Strip frontmatter from content, returning just the body.
 */
export function stripFrontmatter(content: string): string {
  console.assert(typeof content === "string", "content must be string");
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return content;
  return content.slice(match[0].length);
}

/**
 * Check if content has frontmatter.
 */
export function hasFrontmatter(content: string): boolean {
  return FRONTMATTER_REGEX.test(content);
}

/**
 * Read metadata from a page file, returning the parsed frontmatter.
 * Returns empty object if no frontmatter or file doesn't exist.
 */
export function readFileMetadata(filePath: string): Record<string, any> {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { metadata } = parseFrontmatter(content);
    return metadata;
  } catch {
    return {};
  }
}

/**
 * Write metadata to a page file, preserving the body content.
 * If the file has frontmatter, update it. If not, add it.
 */
export function writeFileMetadata(filePath: string, metadata: Record<string, any>): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { metadata: existing, body } = parseFrontmatter(content);
    const merged = { ...existing, ...metadata };
    const updated = serializeFrontmatter(merged, body);
    fs.writeFileSync(filePath, updated, "utf-8");
  } catch {
    // File doesn't exist — can't write metadata
  }
}

// ============================================================================
// SIMPLE YAML PARSER
// ============================================================================

/**
 * Parse a simple YAML subset (key: value, key: [list]).
 * Does NOT handle nested objects, multi-line strings, or complex YAML features.
 * This is intentionally simple — we only need flat key-value pairs and arrays.
 */
function parseSimpleYaml(raw: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = raw.split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    // Array item: "  - value"
    if (trimmed.startsWith("- ") && currentKey !== null && currentArray !== null) {
      const value = trimmed.slice(2).trim();
      currentArray.push(parseYamlValue(value));
      continue;
    }

    // Flush previous array
    if (currentKey !== null && currentArray !== null) {
      result[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    // Empty value — start of an array
    if (value === "" || value === "[]") {
      currentKey = key;
      currentArray = [];
      if (value === "[]") {
        result[key] = [];
        currentKey = null;
        currentArray = null;
      }
      continue;
    }

    // Single value
    result[key] = parseYamlValue(value);
  }

  // Flush last array
  if (currentKey !== null && currentArray !== null) {
    result[currentKey] = currentArray;
  }

  return result;
}

/**
 * Parse a single YAML value.
 */
function parseYamlValue(value: string): any {
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;

  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Plain string
  return value;
}

/**
 * Serialize a single YAML value.
 * Simple strings (letters, digits, hyphens, underscores, dots, slashes) are
 * left unquoted. Everything else gets double-quoted.
 */
function serializeYamlValue(value: any): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Simple strings don't need quoting
    if (/^[a-zA-Z0-9/_.\\-]+$/.test(value)) return value;
    // Everything else gets double-quoted
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return String(value);
}