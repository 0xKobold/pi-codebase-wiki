/**
 * Ingest Pipeline — reads raw sources and updates the wiki
 *
 * The core Karpathy Wiki operation: read source → extract → update wiki pages.
 * Uses file system for wiki content, SQLite for metadata.
 */

import * as fs from "fs";
import * as path from "path";
import type { GitCommit } from "../shared.js";
import { toSlug, formatWikiDate, getDirectoryForPageType, DEFAULT_PAGE_TYPES } from "../shared.js";
import type { PageTypeConfig } from "../shared.js";
import type { WikiStore } from "../core/store.js";
import type { ModuleInfo } from "../core/indexer.js";
import {
  getRecentCommits,
  getAllCommits,
  getCommitsSince,
  filterIngestibleCommits,
  groupCommitsByScope,
  extractChangedFiles,
  inferEntityFromPath,
} from "../core/git.js";
import {
  scanFileTree,
  inferModules,
  readReadme,
  readPackageJson,
} from "../core/indexer.js";
import type { WikiConfig, IngestConfig } from "../shared.js";
import { DEFAULT_INGEST_CONFIG } from "../shared.js";
import { createGitSourceManifest } from "./source.js";
import {
  ensureWikiDirs,
  generateSchemaMD,
  generateIndexMD,
  generateLogMD,
  generateEntityTemplate,
  generateDecisionTemplate,
  generateEvolutionTemplate,
  generateConceptTemplate,
  generateComparisonTemplate,
} from "../core/config.js";

// ============================================================================
// INGEST OPERATIONS
// ============================================================================

export interface IngestResult {
  pagesCreated: number;
  pagesUpdated: number;
  commitsProcessed: number;
  filesProcessed: number;
  errors: string[];
}

/**
 * Initialize a new wiki for the project
 */
export function initWiki(
  rootDir: string,
  config: WikiConfig,
  store: WikiStore
): string {
  console.assert(typeof rootDir === "string", "rootDir must be string");

  const wikiPath = ensureWikiDirs(rootDir, config.wikiDir);
  const schemaPath = path.join(wikiPath, "SCHEMA.md");
  const indexPath = path.join(wikiPath, "INDEX.md");
  const logPath = path.join(wikiPath, "meta", "LOG.md");

  // Read project name from package.json or directory name
  const pkg = readPackageJson(rootDir);
  const projectName = (pkg?.name as string) || path.basename(rootDir);

  // Create SCHEMA.md
  if (!fs.existsSync(schemaPath)) {
    fs.writeFileSync(schemaPath, generateSchemaMD(projectName), "utf-8");
  }

  // Create INDEX.md
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, generateIndexMD(projectName), "utf-8");
  }

  // Create LOG.md
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, generateLogMD(), "utf-8");
  }

  // Create templates
  const templatesDir = path.join(wikiPath, "templates");
  const templates: Record<string, string> = {
    "entity.md": generateEntityTemplate(),
    "concept.md": generateConceptTemplate(),
    "decision.md": generateDecisionTemplate(),
    "evolution.md": generateEvolutionTemplate(),
    "comparison.md": generateComparisonTemplate(),
  };

  for (const [filename, content] of Object.entries(templates)) {
    const templatePath = path.join(templatesDir, filename);
    if (!fs.existsSync(templatePath)) {
      fs.writeFileSync(templatePath, content, "utf-8");
    }
  }

  // Register index page in store
  store.upsertPage({
    id: "index",
    path: "INDEX.md",
    type: "index",
    title: `${projectName} — Codebase Wiki Index`,
    summary: `Auto-maintained knowledge base for ${projectName}`,
    sourceFiles: [],
    sourceCommits: [],
    lastIngested: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    inboundLinks: 0,
    outboundLinks: 0,
    stale: false,
  });

  // Add .codebase-wiki/ to project .gitignore if not already there
  const gitignorePath = path.join(rootDir, ".gitignore");
  const wikiIgnoreEntry = config.wikiDir + "/";  // e.g. ".codebase-wiki/"
  try {
    let gitignore = "";
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, "utf-8");
    }
    if (!gitignore.includes(wikiIgnoreEntry)) {
      const lines = gitignore.split("\n");
      const hasBlankLine = lines[lines.length - 1] === "";
      const addition = (hasBlankLine ? "" : "\n") + "\n# Codebase wiki — compiled artifact, regenerated from source\n" + wikiIgnoreEntry + "\n";
      fs.appendFileSync(gitignorePath, addition, "utf-8");
    }
  } catch {
    // Can't write .gitignore — not fatal, just skip
  }

  return wikiPath;
}

/**
 * Ingest recent git commits into the wiki
 */
export async function ingestCommits(
  rootDir: string,
  config: WikiConfig,
  store: WikiStore,
  since: string = "1 week ago",
  ingestConfig: IngestConfig = DEFAULT_INGEST_CONFIG
): Promise<IngestResult> {
  console.assert(typeof rootDir === "string", "rootDir must be string");

  const result: IngestResult = {
    pagesCreated: 0,
    pagesUpdated: 0,
    commitsProcessed: 0,
    filesProcessed: 0,
    errors: [],
  };

  const wikiPath = path.join(rootDir, config.wikiDir);

  // Get commits since last ingest or specified period
  const lastIngest = store.getLastIngest();
  let commits: GitCommit[];

  if (lastIngest) {
    // Get commits since last ingest hash
    commits = getCommitsSince(rootDir, lastIngest.sourceRef);
  } else {
    // First ingest — get recent commits
    commits = getRecentCommits(rootDir, since);
  }

  // Filter noise commits
  const ingestibleCommits = filterIngestibleCommits(commits, ingestConfig);
  result.commitsProcessed = ingestibleCommits.length;

  if (ingestibleCommits.length === 0) {
    return result;
  }

  // Group by scope for entity-based processing
  const byScope = groupCommitsByScope(ingestibleCommits);

  for (const [scope, scopeCommits] of byScope) {
    try {
      const slug = toSlug(scope === "_root" ? "root" : scope);
      const entityDir = path.join(wikiPath, "entities");
      const entityPath = path.join(entityDir, `${slug}.md`);

      const allFiles = extractChangedFiles(scopeCommits);
      result.filesProcessed += allFiles.length;

      if (fs.existsSync(entityPath)) {
        // Update existing entity page
        updateEntityPage(entityPath, slug, scope, scopeCommits, allFiles, store);
        result.pagesUpdated++;
      } else {
        // Create new entity page
        createEntityPage(entityPath, slug, scope, scopeCommits, allFiles, store);
        result.pagesCreated++;
      }

      // Add cross-references
      const commitHashes = scopeCommits.map(c => c.hash);
      store.addCrossReference("index", slug, `Main entity: ${scope}`);
      store.upsertPage({
        ...store.getPage(slug) ?? {
          id: slug,
          path: `entities/${slug}.md`,
          type: "entity",
          title: scope,
          summary: "",
          sourceFiles: allFiles,
          sourceCommits: commitHashes,
          lastIngested: new Date().toISOString(),
          lastChecked: new Date().toISOString(),
          inboundLinks: 0,
          outboundLinks: 0,
          stale: false,
        },
        sourceCommits: [...new Set([...(store.getPage(slug)?.sourceCommits ?? []), ...commitHashes])],
        sourceFiles: [...new Set([...(store.getPage(slug)?.sourceFiles ?? []), ...allFiles])],
        lastIngested: new Date().toISOString(),
      });
    } catch (err) {
      result.errors.push(`Failed to process scope ${scope}: ${err}`);
    }
  }

  // Log the ingest
  store.logIngest({
    sourceType: "commit",
    sourceRef: ingestibleCommits[0]?.hash ?? "unknown",
    pagesCreated: result.pagesCreated,
    pagesUpdated: result.pagesUpdated,
    timestamp: new Date().toISOString(),
  });

  // Update INDEX.md
  updateIndex(wikiPath, store);

  // Update LOG.md (structured format)
  appendToLog(wikiPath, result);

  // Create source manifest for this ingest
  if (result.commitsProcessed > 0) {
    const lastCommit = ingestibleCommits[ingestibleCommits.length - 1];
    const firstCommit = ingestibleCommits[0];
    const range = firstCommit && lastCommit
      ? `${firstCommit.hash.slice(0, 7)}..${lastCommit.hash.slice(0, 7)}`
      : since;
    // Note: ingestResult tracks counts, not specific page IDs
    // We pass empty arrays here; individual page IDs are tracked via store.upsertPage
    createGitSourceManifest(wikiPath, store, range, [], []);
  }

  return result;
}

/**
 * Ingest the full file tree (initial setup)
 */
export async function ingestFileTree(
  rootDir: string,
  config: WikiConfig,
  store: WikiStore,
  ingestConfig: IngestConfig = DEFAULT_INGEST_CONFIG
): Promise<IngestResult> {
  const result: IngestResult = {
    pagesCreated: 0,
    pagesUpdated: 0,
    commitsProcessed: 0,
    filesProcessed: 0,
    errors: [],
  };

  const wikiPath = path.join(rootDir, config.wikiDir);

  // Scan file tree
  const files = scanFileTree(rootDir, ingestConfig.excludePatterns);
  result.filesProcessed = files.length;

  // Infer modules
  const modules = inferModules(files);

  for (const module of modules) {
    try {
      const slug = module.slug;
      const entityDir = path.join(wikiPath, "entities");
      const entityPath = path.join(entityDir, `${slug}.md`);

      if (fs.existsSync(entityPath)) {
        updateEntityPage(entityPath, slug, module.name, [], module.sourceFiles, store);
        result.pagesUpdated++;
      } else {
        createEntityPage(entityPath, slug, module.name, [], module.sourceFiles, store);
        result.pagesCreated++;
      }
    } catch (err) {
      result.errors.push(`Failed to process module ${module.name}: ${err}`);
    }
  }

  // Also ingest README if it exists
  const readme = readReadme(rootDir);
  if (readme) {
    const readmeSlug = "readme";
    const conceptDir = path.join(wikiPath, "concepts");
    const readmePath = path.join(conceptDir, `${readmeSlug}.md`);

    const content = `# README Summary\n\n> **Summary**: Project README documentation.\n\n${readme.slice(0, 2000)}${readme.length > 2000 ? "\n\n... (truncated)" : ""}\n\n## See Also\n- [[index]]\n`;

    fs.mkdirSync(conceptDir, { recursive: true });
    fs.writeFileSync(readmePath, content, "utf-8");
    result.pagesCreated++;
  }

  // Log the ingest
  store.logIngest({
    sourceType: "full-tree",
    sourceRef: "initial-ingest",
    pagesCreated: result.pagesCreated,
    pagesUpdated: result.pagesUpdated,
    timestamp: new Date().toISOString(),
  });

  // Update INDEX.md
  updateIndex(wikiPath, store);

  return result;
}

// ============================================================================
// PAGE GENERATORS (pure functions that produce markdown)
// ============================================================================

function createEntityPage(
  filePath: string,
  slug: string,
  name: string,
  commits: GitCommit[],
  sourceFiles: string[],
  store: WikiStore
): void {
  const today = formatWikiDate(new Date());
  const recentCommits = commits.slice(0, 10).map(c =>
    `- **${c.type}${c.scope ? `(${c.scope})` : ""}**: ${c.subject} ([${c.hash.slice(0, 7)}]})`
  ).join("\n");

  const fileList = sourceFiles.slice(0, 20).map(f => `- \`${f}\``).join("\n");

  const content = `# ${name}

> **Summary**: ${name} module in the codebase.

## Location
- **Files**: ${sourceFiles.length} source files

## Key Files
${fileList || "- (no files tracked)"}

## Dependencies
- (to be discovered)

## Dependents
- (to be discovered)

## Design Decisions
- (to be documented)

## Evolution
${recentCommits ? `### Recent Changes\n${recentCommits}` : "- (no commits tracked yet)"}

---
*Last updated: ${today}*
`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");

  store.upsertPage({
    id: slug,
    path: `entities/${slug}.md`,
    type: "entity",
    title: name,
    summary: `${name} module in the codebase`,
    sourceFiles,
    sourceCommits: commits.map(c => c.hash),
    lastIngested: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    inboundLinks: 0,
    outboundLinks: 0,
    stale: false,
  });
}

function updateEntityPage(
  filePath: string,
  slug: string,
  name: string,
  newCommits: GitCommit[],
  newFiles: string[],
  store: WikiStore
): void {
  const existing = store.getPage(slug);
  if (!existing) {
    createEntityPage(filePath, slug, name, newCommits, newFiles, store);
    return;
  }

  // Read existing content
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    createEntityPage(filePath, slug, name, newCommits, newFiles, store);
    return;
  }

  // Check if content has been hand-edited or enriched (not a stub)
  // Preserve hand-edited content — don't overwrite with stubs
  const isEnriched = !content.includes("(to be discovered)")
    && !content.includes("(to be documented)")
    && !content.includes("(no files tracked)");

  // Backup existing file before overwriting (preserves hand-edited content)
  const backupDir = path.join(path.dirname(filePath), "..", "meta", "backups");
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${slug}-${Date.now()}.md`);
    fs.writeFileSync(backupPath, content, "utf-8");
  } catch {
    // Backup failure is non-fatal — log but continue
  }

  const today = formatWikiDate(new Date());

  // Always update timestamp
  content = content.replace(
    /\*Last updated:.*\*/,
    `*Last updated: ${today}*`
  );

  // Append commits to Evolution section using proper section boundary parsing
  if (newCommits.length > 0) {
    const commitLines = newCommits.slice(0, 5).map(c =>
      `- **${c.type}${c.scope ? `(${c.scope})` : ""}**: ${c.subject} ([${c.hash.slice(0, 7)}])`
    ).join("\n");

    if (content.includes("## Evolution")) {
      // Insert new evolution entries right after the ## Evolution header,
      // before any existing content. Use non-greedy match up to next ## header.
      content = content.replace(
        /## Evolution\n/,
        `## Evolution\n\n### ${today}\n${commitLines}\n`
      );
    } else {
      // No Evolution section yet — append one before the See Also or end
      const seeAlsoIdx = content.indexOf("## See Also");
      const newSection = `\n## Evolution\n\n### ${today}\n${commitLines}\n`;
      if (seeAlsoIdx !== -1) {
        content = content.slice(0, seeAlsoIdx) + newSection + content.slice(seeAlsoIdx);
      } else {
        content += newSection;
      }
    }
  }

  // Update Key Files section — only on stub pages, with safe section boundary
  if (!isEnriched && newFiles.length > 0) {
    const fileList = newFiles.slice(0, 20).map(f => `- \`${f}\``).join("\n");
    // Use non-greedy match up to the next ## header (section boundary)
    content = content.replace(
      /## Key Files\n([\s\S]*?)(?=\n## )/,
      `## Key Files\n${fileList}\n\n`
    );
  }

  fs.writeFileSync(filePath, content, "utf-8");

  // Update store — merge source data, don't replace
  existing.sourceCommits = [...new Set([...existing.sourceCommits, ...newCommits.map(c => c.hash)])];
  existing.sourceFiles = [...new Set([...existing.sourceFiles, ...newFiles])];
  existing.lastIngested = new Date().toISOString();
  existing.stale = false;  // Fresh ingest clears stale flag
  store.upsertPage(existing);
}

// ============================================================================
// INDEX & LOG UPDATES
// ============================================================================

export function updateIndex(wikiPath: string, store: WikiStore): void {
  const pages = store.getAllPages();
  const entities = pages.filter(p => p.type === "entity").sort((a, b) => a.title.localeCompare(b.title));
  const concepts = pages.filter(p => p.type === "concept").sort((a, b) => a.title.localeCompare(b.title));
  const decisions = pages.filter(p => p.type === "decision").sort((a, b) => a.title.localeCompare(b.title));
  const evolutions = pages.filter(p => p.type === "evolution").sort((a, b) => a.title.localeCompare(b.title));
  const comparisons = pages.filter(p => p.type === "comparison").sort((a, b) => a.title.localeCompare(b.title));

  const today = formatWikiDate(new Date());

  const lines: string[] = [
    `# Codebase Wiki Index`,
    ``,
    `> Auto-maintained knowledge base. Use \`/wiki-query <question>\` to search.`,
    ``,
    `## Entities`,
    ...entities.map(p => `- [[${p.id}]] — ${p.summary || p.title}`),
    ``,
    `## Concepts`,
    ...concepts.map(p => `- [[${p.id}]] — ${p.summary || p.title}`),
    ``,
    `## Decisions (ADRs)`,
    ...decisions.map(p => `- [[${p.id}]] — ${p.summary || p.title}`),
    ``,
    `## Evolution`,
    ...evolutions.map(p => `- [[${p.id}]] — ${p.summary || p.title}`),
    ``,
    `## Comparisons`,
    ...comparisons.map(p => `- [[${p.id}]] — ${p.summary || p.title}`),
    ``,
    `---`,
    ``,
    `*Last updated: ${today} • ${pages.length} pages total*`,
  ];

  const indexPath = path.join(wikiPath, "INDEX.md");
  fs.writeFileSync(indexPath, lines.join("\n") + "\n", "utf-8");
}

function appendToLog(wikiPath: string, result: IngestResult): void {
  const logPath = path.join(wikiPath, "meta", "LOG.md");
  const today = formatWikiDate(new Date());

  const entry = `| ${today} | commit | ${result.commitsProcessed} commits | ${result.pagesCreated} | ${result.pagesUpdated} |`;

  try {
    let content = fs.readFileSync(logPath, "utf-8");
    // Find the first data row after the separator line (| - | - | ...)
    // The log table has: header row, separator row, then data rows
    // Insert new entries after the separator line
    const lines = content.split("\n");
    let insertIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      // Find the separator row (contains only |, -, and spaces)
      if (/^\|\s*[\-\s|]+\|\s*$/.test(lines[i]!)) {
        insertIdx = i + 1; // Insert after separator
        break;
      }
    }

    if (insertIdx > 0 && insertIdx < lines.length) {
      lines.splice(insertIdx, 0, entry);
      content = lines.join("\n");
      fs.writeFileSync(logPath, content, "utf-8");
    } else {
      // Fallback: append at end before the trailing marker
      const markerIdx = content.lastIndexOf("---");
      if (markerIdx > 0) {
        content = content.slice(0, markerIdx) + entry + "\n\n" + content.slice(markerIdx);
      } else {
        content += entry + "\n";
      }
      fs.writeFileSync(logPath, content, "utf-8");
    }
  } catch {
    // If log doesn't exist, create it
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, generateLogMD(), "utf-8");
  }
}