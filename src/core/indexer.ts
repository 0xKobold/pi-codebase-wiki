/**
 * File Indexer Module
 *
 * Scans the project file tree and builds an index of modules, their
 * dependencies, and relationships. Pure functions, no globals.
 */

import * as fs from "fs";
import * as path from "path";
import type { FileEntry } from "../shared.js";

// ============================================================================
// FILE TREE SCANNING
// ============================================================================

const DEFAULT_EXCLUDE = [
  "node_modules", "dist", ".git", "coverage", ".codebase-wiki",
  "__pycache__", ".next", ".nuxt", "build", ".cache", ".turbo",
  ".0xkobold", ".pi", ".agents", ".cursor", ".claude",
  ".vscode", ".idea", "tests", "test", "test-packages",
  "deprecated", "dead-code-backup", "TEMPLATES", "templates",
];

/**
 * Scan directory tree and return all files
 */
export function scanFileTree(rootDir: string, excludeDirs: string[] = DEFAULT_EXCLUDE): FileEntry[] {
  console.assert(typeof rootDir === "string", "rootDir must be string");
  console.assert(rootDir.length > 0, "rootDir must not be empty");

  const entries: FileEntry[] = [];

  function walk(dir: string): void {
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      return; // Permission denied or other error
    }

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relativePath = path.relative(rootDir, fullPath);

      // Skip excluded directories
      if (excludeDirs.some(excl => relativePath.startsWith(excl) || item === excl)) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          extension: path.extname(item).slice(1) || undefined,
          size: stat.size,
        });
      }
    }
  }

  walk(rootDir);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Infer module structure from file tree
 */
export function inferModules(files: FileEntry[]): ModuleInfo[] {
  console.assert(Array.isArray(files), "files must be array");

  const moduleMap = new Map<string, string[]>();

  for (const file of files) {
    const parts = file.path.split("/");
    let moduleName: string;

    if (parts.length >= 2 && parts[0] === "packages") {
      // packages/pi-learn/src/index.ts → pi-learn
      moduleName = parts[1]!;
    } else if (parts.length >= 2 && parts[0] === "src") {
      // src/core/store.ts → src/core
      moduleName = `src/${parts[1]}`;
    } else if (parts.length >= 2 && parts[0]!.startsWith(".")) {
      // Skip hidden directories like .git, .0xkobold, .next
      continue;
    } else if (parts.length >= 2) {
      moduleName = parts[0]!;
    } else {
      continue; // Skip root-level files with no clear module
    }

    const existing = moduleMap.get(moduleName) || [];
    existing.push(file.path);
    moduleMap.set(moduleName, existing);
  }

  const modules: ModuleInfo[] = [];
  for (const [name, moduleFiles] of moduleMap) {
    const sourceFiles = moduleFiles.filter(f => {
      const ext = path.extname(f);
      return [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"].includes(ext);
    });

    const docFiles = moduleFiles.filter(f => {
      const ext = path.extname(f);
      return [".md", ".txt", ".rst"].includes(ext);
    });

    const configFiles = moduleFiles.filter(f => {
      const base = path.basename(f);
      return [".json", ".yaml", ".yml", ".toml", ".env"].includes(path.extname(f))
        || base.startsWith(".") || base === "Dockerfile" || base === "Makefile";
    });

    modules.push({
      name,
      slug: name.replace(/[/.]/g, "-").replace(/-+/g, "-"),
      allFiles: moduleFiles,
      sourceFiles,
      docFiles,
      configFiles,
    });
  }

  return modules.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read README content if it exists
 */
export function readReadme(rootDir: string): string | null {
  const candidates = ["README.md", "README.txt", "README.rst", "readme.md"];
  for (const candidate of candidates) {
    const fullPath = path.join(rootDir, candidate);
    try {
      if (fs.existsSync(fullPath)) {
        return fs.readFileSync(fullPath, "utf-8");
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read package.json if it exists
 */
export function readPackageJson(rootDir: string): Record<string, unknown> | null {
  const fullPath = path.join(rootDir, "package.json");
  try {
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Find all documentation files
 */
export function findDocFiles(rootDir: string, excludeDirs: string[] = DEFAULT_EXCLUDE): string[] {
  const docDirs = ["docs", "doc", "documentation", "wiki"];
  const docFiles: string[] = [];

  // Check common doc directories
  for (const docDir of docDirs) {
    const fullDir = path.join(rootDir, docDir);
    if (fs.existsSync(fullDir)) {
      try {
        const entries = scanFileTree(fullDir, excludeDirs);
        docFiles.push(...entries.filter(e => e.extension === "md").map(e => e.path));
      } catch {
        continue;
      }
    }
  }

  // Also check root-level .md files
  try {
    const rootFiles = fs.readdirSync(rootDir);
    for (const file of rootFiles) {
      if (file.endsWith(".md") && file !== "README.md") {
        docFiles.push(file);
      }
    }
  } catch {
    // Ignore
  }

  return docFiles;
}

// ============================================================================
// TYPES
// ============================================================================

export interface ModuleInfo {
  name: string;
  slug: string;
  allFiles: string[];
  sourceFiles: string[];
  docFiles: string[];
  configFiles: string[];
}