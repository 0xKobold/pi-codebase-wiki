/**
 * Dependency Extraction Module (Phase 2)
 *
 * Extracts import/require statements from source files to build
 * cross-reference links between wiki entities. Pure functions, no globals.
 */

import * as fs from "fs";
import * as path from "path";

// ============================================================================
// IMPORT PATTERN MATCHING
// ============================================================================

/** Patterns for various import/require styles */
const IMPORT_PATTERNS = [
  // ES module: import X from 'path'
  /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g,
  // ES module: import 'path'
  /import\s+['"]([^'"]+)['"]/g,
  // CommonJS: require('path')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Dynamic import: import('path')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Python: from X import Y / import X
  /(?:from|import)\s+([a-zA-Z_][\w.]*)/g,
  // Rust: use crate::X / use super::X
  /use\s+(crate::[\w:]+|super::[\w:]+|self::[\w:]+)/g,
  // Go: import "path"
  /import\s+(?:[\w]+\s+)?"([^"]+)"/g,
];

// ============================================================================
// PUBLIC API
// ============================================================================

export interface DependencyInfo {
  /** Source file path (relative to project root) */
  sourceFile: string;
  /** Import targets (relative paths or package names) */
  imports: string[];
  /** Export names from this file */
  exports: string[];
}

/**
 * Extract imports from a single source file
 */
export function extractImports(filePath: string, rootDir: string): string[] {
  console.assert(typeof filePath === "string", "filePath must be string");

  const fullPath = path.resolve(rootDir, filePath);
  let content: string;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return [];
  }

  const ext = path.extname(filePath);
  const imports: Set<string> = new Set();

  // Skip non-code files
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go"].includes(ext)) {
    return [];
  }

  // Apply regex patterns for the file type
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const importPath = match[1]!.trim();
      // Skip node built-ins and bare specifiers
      if (importPath && !importPath.startsWith("node:") && !importPath.startsWith("bun:")) {
        imports.add(importPath);
      }
    }
  }

  // For TS/JS, also extract re-exports
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    const reExportPattern = /export\s+(?:\{[^}]*\}\s+from\s+['"]([^'"]+)['"]|type\s+\w+\s+from\s+['"]([^'"]+)['"])/g;
    let match: RegExpExecArray | null;
    while ((match = reExportPattern.exec(content)) !== null) {
      const importPath = (match[1] ?? match[2] ?? "").trim();
      if (importPath && !importPath.startsWith("node:") && !importPath.startsWith("bun:")) {
        imports.add(importPath);
      }
    }
  }

  return [...imports].sort();
}

/**
 * Extract exports from a single source file
 */
export function extractExports(filePath: string, rootDir: string): string[] {
  console.assert(typeof filePath === "string", "filePath must be string");

  const fullPath = path.resolve(rootDir, filePath);
  let content: string;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return [];
  }

  const ext = path.extname(filePath);
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return [];
  }

  const exports: string[] = [];
  const patterns = [
    /export\s+(?:default\s+)?function\s+(\w+)/g,
    /export\s+(?:default\s+)?class\s+(\w+)/g,
    /export\s+(?:default\s+)?const\s+(\w+)/g,
    /export\s+(?:default\s+)?interface\s+(\w+)/g,
    /export\s+(?:default\s+)?type\s+(\w+)/g,
    /export\s+\{([^}]+)\}/g,
  ];

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (pattern.source.startsWith("export\\s+\\{")) {
        // Named re-exports: export { X, Y, Z }
        const names = match[1]!.split(",").map(n => n.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean);
        exports.push(...names);
      } else {
        const name = match[1]?.trim();
        if (name) exports.push(name);
      }
    }
  }

  return [...new Set(exports)].sort();
}

/**
 * Resolve an import path to a wiki entity slug
 * e.g., "../core/store" -> "src-core-store"
 * e.g., "pi-learn" -> "pi-learn"
 * e.g., "@mariozechner/pi-coding-agent" -> null (external dep)
 */
export function resolveImportToSlug(importPath: string, sourceFile: string, projectModules: string[]): string | null {
  console.assert(typeof importPath === "string", "importPath must be string");

  // Skip external dependencies (scoped packages, npm modules)
  if (importPath.startsWith("@") && !importPath.startsWith("@/")) {
    return null;
  }

  // Skip node built-ins
  if (importPath.startsWith("node:") || importPath.startsWith("bun:")) {
    return null;
  }

  // Skip CSS/style imports
  if (/\.(css|scss|less|svg|png|jpg)$/.test(importPath)) {
    return null;
  }

  // Skip deep relative paths (../../foo) — too ambiguous
  if (importPath.startsWith("../../") || importPath.startsWith("../..")) {
    return null;
  }

  // Collapse relative prefixes to a clean path
  const aliased = importPath
    .replace(/^@\//, "src/")
    .replace(/^~\//, "src/")
    .replace(/^#\//, "")
    .replace(/^(\.\.\/)+/, "")  // strip all leading ../
    .replace(/^\.\//, "");

  // If the import matches a known project module, return it directly
  for (const mod of projectModules) {
    if (importPath.includes(mod) || aliased.includes(mod)) {
      const slug = mod.replace(/[/.]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
      if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug)) return slug;
      return null;
    }
  }

  // For relative or src/ imports, derive entity slug
  if (importPath.startsWith(".") || importPath.startsWith("src/") || importPath.startsWith("/")) {
    const clean = aliased
      .replace(/^src\//, "src-")
      .replace(/\//g, "-")
      .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    // Validate slug format — must start with a letter
    if (clean.length === 0 || !/^[a-z]/.test(clean)) return null;
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(clean)) return null;
    return clean;
  }

  return null;
}

/**
 * Build cross-references from a list of dependency info
 */
export function buildCrossReferences(
  deps: DependencyInfo[],
  projectModules: string[]
): Map<string, Set<string>> {
  console.assert(Array.isArray(deps), "deps must be array");

  const refs = new Map<string, Set<string>>();

  for (const dep of deps) {
    // Derive source entity from file path
    const sourceEntity = inferEntityFromDep(dep.sourceFile);
    if (!sourceEntity) continue;

    if (!refs.has(sourceEntity)) {
      refs.set(sourceEntity, new Set());
    }

    for (const importPath of dep.imports) {
      const targetEntity = resolveImportToSlug(importPath, dep.sourceFile, projectModules);
      if (targetEntity && targetEntity !== sourceEntity) {
        refs.get(sourceEntity)!.add(targetEntity);
      }
    }
  }

  return refs;
}

/**
 * Infer entity name from a file path for cross-reference purposes
 */
function inferEntityFromDep(filePath: string): string | null {
  const parts = filePath.split("/");

  if (parts.length >= 2 && parts[0] === "packages") {
    return parts[1] ?? null;
  }

  if (parts.length >= 3 && parts[0] === "src") {
    return `src-${parts[1]}`;
  }

  if (parts.length >= 2) {
    return parts[0];
  }

  return null;
}