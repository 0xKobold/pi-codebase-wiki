/**
 * Smart Ingest Module (Phase 2)
 *
 * Reads source files and generates rich entity page content.
 * Uses local file analysis + heuristics to build detailed wiki pages.
 * No LLM calls — builds structured content from code analysis.
 *
 * NASA-10: small functions, validation, no globals.
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiPage } from "../shared.js";
import { toSlug, formatWikiDate } from "../shared.js";
import type { WikiStore } from "./store.js";
import { extractImports, extractExports, buildCrossReferences, resolveImportToSlug } from "./deps.js";
import type { DependencyInfo } from "./deps.js";

// ============================================================================
// TYPES
// ============================================================================

export interface SmartIngestResult {
  pagesEnriched: number;
  crossReferencesAdded: number;
  errors: string[];
}

export interface EntityContent {
  summary: string;
  responsibilities: string[];
  dependencies: string[];
  exports: string[];
  keyFiles: Array<{ path: string; description: string }>;
}

// ============================================================================
// SMART ENTITY INGEST
// ============================================================================

/**
 * Enrich all stub entity pages with real content derived from source analysis.
 * Replaces "(to be discovered)" and "(to be documented)" placeholders.
 */
export function enrichAllEntities(
  wikiPath: string,
  rootDir: string,
  store: WikiStore
): SmartIngestResult {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");
  console.assert(typeof rootDir === "string", "rootDir must be string");

  const result: SmartIngestResult = {
    pagesEnriched: 0,
    crossReferencesAdded: 0,
    errors: [],
  };

  const pages = store.getAllPages().filter(p => p.type === "entity");
  const allModules = pages.map(p => p.id);
  const allDeps: DependencyInfo[] = [];

  // Phase 1: Analyze dependencies for all entities
  for (const page of pages) {
    const entityDeps = analyzeEntityDeps(page, rootDir);
    allDeps.push(...entityDeps);
  }

  // Build cross-reference map (outbound: entity → targets it depends on)
  const crossRefs = buildCrossReferences(allDeps, allModules);

  // Build reverse map (inbound: entity → entities that depend on it)
  const inboundRefs = new Map<string, Set<string>>();
  for (const [from, targets] of crossRefs) {
    for (const to of targets) {
      if (!inboundRefs.has(to)) {
        inboundRefs.set(to, new Set());
      }
      inboundRefs.get(to)!.add(from);
    }
  }

  // Phase 2: Enrich each page
  for (const page of pages) {
    try {
      const entityPath = path.join(wikiPath, page.path);
      if (!fs.existsSync(entityPath)) continue;

      let content: string;
      try {
        content = fs.readFileSync(entityPath, "utf-8");
      } catch {
        continue;
      }

      // Skip if already enriched (has real content, not stubs)
      if (isEnriched(content)) continue;

      // Analyze source files for this entity
      const analysis = analyzeEntityContent(page, rootDir, allModules);

      // Generate enriched content
      // Dependencies = outbound (what this entity imports)
      // Dependents = inbound (what imports this entity)
      const enriched = generateEnrichedContent(page, analysis, inboundRefs.get(page.id), allModules);

      // Write only if content actually changed
      if (enriched !== content) {
        fs.writeFileSync(entityPath, enriched, "utf-8");
        result.pagesEnriched++;

        // Update store with new summary
        page.summary = analysis.summary;
        page.lastIngested = new Date().toISOString();
        store.upsertPage(page);
      }
    } catch (err) {
      result.errors.push(`Failed to enrich ${page.id}: ${err}`);
    }
  }

  // Phase 3: Add cross-references to store
  for (const [from, targets] of crossRefs) {
    for (const to of targets) {
      store.addCrossReference(from, to, `dependency`);
      result.crossReferencesAdded++;
    }
  }

  return result;
}

// ============================================================================
// CONTENT ANALYSIS
// ============================================================================

/**
 * Check if a page already has real content (not just stubs)
 */
function isEnriched(content: string): boolean {
  return !content.includes("(to be discovered)")
    && !content.includes("(to be documented)")
    && !content.includes("(no files tracked)");
}

/**
 * Analyze an entity's source files to extract content info
 */
function analyzeEntityContent(page: WikiPage, rootDir: string, allModules: string[]): EntityContent {
  const responsibilities: string[] = [];
  const dependencies: string[] = [];
  const exports: string[] = [];
  const keyFiles: Array<{ path: string; description: string }> = [];

  const sourceFiles = page.sourceFiles.slice(0, 20); // Cap at 20 files

  for (const file of sourceFiles) {
    const fullPath = path.resolve(rootDir, file);

    // Read file for analysis
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    // Extract imports
    const imports = extractImports(file, rootDir);
    dependencies.push(...imports.filter(i => i.startsWith(".") || i.startsWith("@0xkobold") || i.startsWith("pi-")));

    // Extract exports
    const fileExports = extractExports(file, rootDir);
    exports.push(...fileExports);

    // Infer key files (index.ts, main entry points)
    const basename = path.basename(file);
    if (basename === "index.ts" || basename === "index.tsx" || basename === "index.js") {
      keyFiles.push({ path: file, description: "Module entry point" });
    } else if (basename.endsWith(".test.ts") || basename.endsWith(".spec.ts")) {
      keyFiles.push({ path: file, description: "Test suite" });
    } else if (basename === "config.ts" || basename === "config.js") {
      keyFiles.push({ path: file, description: "Configuration" });
    } else if (basename.includes("store")) {
      keyFiles.push({ path: file, description: "Data store" });
    } else if (basename.includes("types") || basename.includes("shared")) {
      keyFiles.push({ path: file, description: "Type definitions" });
    }

    // Extract responsibilities from code patterns
    extractResponsibilities(file, fileContent, responsibilities);
  }

  // Deduplicate
  const uniqueDeps = [...new Set(dependencies)].sort();
  const uniqueExports = [...new Set(exports)].sort().slice(0, 20);

  // Generate summary from title + exports
  const title = page.title;
  const summary = generateSummary(title, uniqueExports, keyFiles, sourceFiles.length);

  return {
    summary,
    responsibilities: responsibilities.slice(0, 10),
    dependencies: uniqueDeps.slice(0, 15),
    exports: uniqueExports,
    keyFiles: keyFiles.slice(0, 10),
  };
}

/**
 * Filter to project-internal dependencies only
 */
function filterInternal(deps: string[]): string[] {
  return deps.filter(d => {
    if (d.startsWith(".") || d.startsWith("/")) return true;
    if (d.startsWith("@0xkobold/") || d.startsWith("pi-")) return true;
    if (d.startsWith("@mariozechner/")) return false;
    return false;
  });
}

/**
 * Extract responsibilities from code patterns in a file
 */
function extractResponsibilities(
  filePath: string,
  content: string,
  responsibilities: string[]
): void {
  const basename = path.basename(filePath, path.extname(filePath));

  // Pattern: exported function names → responsibilities
  const funcPattern = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(content)) !== null) {
    const name = match[1]!;
    const readableName = name
      .replace(/([A-Z])/g, " $1")
      .trim()
      .toLowerCase();
    responsibilities.push(`${readableName}`);
  }

  // Pattern: exported class names → responsibilities
  const classPattern = /export\s+(?:default\s+)?class\s+(\w+)/g;
  while ((match = classPattern.exec(content)) !== null) {
    const name = match[1]!;
    const readableName = name.replace(/([A-Z])/g, " $1").trim().toLowerCase();
    responsibilities.push(`${readableName} class`);
  }

  // Pattern: tool definitions → responsibilities
  const toolPattern = /name:\s*['"](\w+)['"]/g;
  while ((match = toolPattern.exec(content)) !== null) {
    // Only if in an extension context
    if (content.includes("registerTool") || content.includes("pi.registerTool")) {
      responsibilities.push(`${match[1]}! tool`);
    }
  }

  // Pattern: event handlers
  const eventPattern = /pi\.on\s*\(\s*['"](\w+)['"]/g;
  while ((match = eventPattern.exec(content)) !== null) {
    responsibilities.push(`handles ${match[1]} events`);
  }
}

/**
 * Generate a summary for an entity based on its code analysis
 */
function generateSummary(
  title: string,
  exports: string[],
  keyFiles: Array<{ path: string; description: string }>,
  fileCount: number
): string {
  const parts: string[] = [];

  parts.push(`${title} module`);

  if (fileCount > 0) {
    parts.push(`with ${fileCount} source file${fileCount !== 1 ? "s" : ""}`);
  }

  if (keyFiles.length > 0) {
    const entryPoint = keyFiles.find(f => f.description === "Module entry point");
    if (entryPoint) {
      parts.push(`entry point at \`${entryPoint.path}\``);
    }
  }

  if (exports.length > 0 && exports.length <= 5) {
    parts.push(`exports: ${exports.join(", ")}`);
  } else if (exports.length > 5) {
    parts.push(`exports ${exports.length} symbols`);
  }

  return parts.join(", ") + ".";
}

// ============================================================================
// DEPENDENCY ANALYSIS
// ============================================================================

/**
 * Analyze dependency info for a single entity's source files
 */
function analyzeEntityDeps(page: WikiPage, rootDir: string): DependencyInfo[] {
  const results: DependencyInfo[] = [];

  for (const file of page.sourceFiles) {
    try {
      const imports = extractImports(file, rootDir);
      const exps = extractExports(file, rootDir);
      results.push({
        sourceFile: file,
        imports,
        exports: exps,
      });
    } catch {
      // Skip files that can't be read
    }
  }

  return results;
}

// ============================================================================
// CONTENT GENERATION
// ============================================================================

/**
 * Generate enriched markdown content for an entity page
 * @param inboundRefs Set of entity IDs that depend on (import from) this entity
 */
function generateEnrichedContent(
  page: WikiPage,
  analysis: EntityContent,
  inboundRefs?: Set<string>,
  allModules: string[] = []
): string {
  const today = formatWikiDate(new Date());

  const lines: string[] = [
    `# ${page.title}`,
    "",
    `> **Summary**: ${analysis.summary}`,
    "",
    "## Location",
  ];

  if (page.sourceFiles.length > 0) {
    lines.push(`- **Files**: ${page.sourceFiles.length} source files`);
  }

  lines.push("", "## Responsibilities");
  if (analysis.responsibilities.length > 0) {
    for (const resp of analysis.responsibilities) {
      lines.push(`- ${resp}`);
    }
  } else {
    lines.push("- (to be discovered through code analysis)");
  }

  lines.push("", "## Dependencies");
  if (analysis.dependencies.length > 0) {
    for (const dep of analysis.dependencies) {
      const slug = resolveImportToSlug(dep, "", allModules);
      if (slug && allModules.includes(slug)) {
        lines.push(`- [[${slug}]] — \`${dep}\``);
      } else {
        lines.push(`- \`${dep}\``);
      }
    }
  } else {
    lines.push("- (no internal dependencies detected)");
  }

  lines.push("", "## Dependents");
  if (inboundRefs && inboundRefs.size > 0) {
    // Inbound refs — only link to pages that actually exist
    for (const ref of inboundRefs) {
      if (allModules.includes(ref)) {
        lines.push(`- [[${ref}]]`);
      }
    }
    // If all refs were filtered out, show as inline
    const linked = [...inboundRefs].filter(r => allModules.includes(r));
    if (linked.length === 0 && inboundRefs.size > 0) {
      for (const ref of inboundRefs) {
        lines.push(`- \`${ref}\``);
      }
    }
  } else {
    lines.push("- (to be discovered through cross-reference analysis)");
  }

  if (analysis.exports.length > 0) {
    lines.push("", "## Exports");
    for (const exp of analysis.exports.slice(0, 15)) {
      lines.push(`- \`${exp}\``);
    }
    if (analysis.exports.length > 15) {
      lines.push(`- ... and ${analysis.exports.length - 15} more`);
    }
  }

  if (analysis.keyFiles.length > 0) {
    lines.push("", "## Key Files");
    for (const kf of analysis.keyFiles) {
      lines.push(`- \`${kf.path}\` — ${kf.description}`);
    }
  }

  lines.push("", "## Design Decisions");
  lines.push("- (to be documented through ADRs)");
  lines.push("", "## Evolution");
  lines.push(`- **${today}** — Initial enrichment from source analysis`, "");
  lines.push("---");
  lines.push(`*Last updated: ${today}*`);

  return lines.join("\n");
}