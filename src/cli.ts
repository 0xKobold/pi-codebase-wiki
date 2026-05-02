#!/usr/bin/env bun
/**
 * wiki CLI — Agent-first command-line interface for pi-codebase-wiki.
 *
 * Powered by kapy 🐹
 *
 * Usage:
 *   wiki init                    Initialize .codebase-wiki/
 *   wiki ingest [commits|tree|smart|llm|all]  Ingest sources
 *   wiki query "why did we..."       Search the wiki
 *   wiki lint                        Health check
 *   wiki status                      Show stats
 *   wiki entity <name>               Create entity page
 *   wiki decision <title>            Create ADR
 *   wiki concept <name>              Create concept page
 *   wiki changelog                   Generate changelog
 *   wiki evolve <feature>            Trace feature evolution
 *   wiki reindex                     Rebuild INDEX.md
 *
 * All commands support --json for machine-readable output and --no-input
 * for non-interactive agent use.
 */

import { kapy } from "@moikapy/kapy";
import * as fs from "fs";
import * as path from "path";
import { WikiStore } from "./core/store.js";
import {
  loadConfig,
  wikiExists,
  getWikiPath,
  ensureWikiDirs,
  initWiki,
  ingestCommits,
  ingestFileTree,
  updateIndex,
  searchWiki,
  lintWiki,
  formatLintResult,
  enrichAllEntities,
  getRecentCommits,
  getAllCommits,
  getCurrentBranch,
  getLatestHash,
} from "./core/index.js";
import { toSlug, validateSlug, formatWikiDate, getDirectoryForPageType, DOMAIN_PRESETS, DEFAULT_PAGE_TYPES } from "./shared.js";
import type { PageType } from "./shared.js";
import type { WikiConfig, GitCommit } from "./shared.js";
import { mergePages, updatePages, splitPage, suggestResolution } from "./operations/resolve.js";
import { findContradictionsDetailed } from "./core/staleness.js";

// ============================================================================
// SHARED HELPERS
// ============================================================================

const DEFAULT_CONFIG: WikiConfig = loadConfig();

async function getStore(rootDir: string): Promise<WikiStore | null> {
  if (!wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
    console.error("❌ Wiki not initialized. Run `wiki init` first.");
    process.exit(1);
  }
  const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
  const dbPath = path.join(wikiPath, "meta", "wiki.db");
  const store = new WikiStore(dbPath);
  await store.init();
  return store;
}

function posArg(ctx: any, index: number, fallback?: string): string {
  const rest = (ctx.args?.rest ?? []) as string[];
  return rest[index] ?? fallback ?? "";
}

function closeStore(store: WikiStore | null): void {
  if (store) store.close();
}

// ============================================================================
// CLI
// ============================================================================

kapy()
  // ─── init ────────────────────────────────────────────────────────────
  .command("init", {
    description: "Initialize the wiki for the current project",
    args: [],
    flags: {
      dir: {
        type: "string",
        alias: "d",
        description: "Wiki directory name (default: .codebase-wiki)",
      },
      domain: {
        type: "string",
        alias: "D",
        description: "Wiki domain preset: codebase (default), personal, research, book",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const wikiDir = (ctx.args.dir as string) || ".codebase-wiki";
    const domain = (ctx.args.domain as string) || "codebase";

    // Resolve domain preset
    const preset = DOMAIN_PRESETS[domain];
    if (domain !== "codebase" && !preset) {
      ctx.error(`Unknown domain preset: ${domain}. Available: ${Object.keys(DOMAIN_PRESETS).join(", ")}`);
      process.exit(1);
    }

    if (wikiExists(rootDir, wikiDir)) {
      ctx.log(`📖 Wiki already exists at ${wikiDir}`);
      if (ctx.args.json) {
        console.log(JSON.stringify({ exists: true, path: wikiDir }));
      }
      return;
    }

    const pageTypes = preset?.pageTypes ?? DEFAULT_PAGE_TYPES;
    const config = { ...DEFAULT_CONFIG, wikiDir, domain, pageTypes };
    const wikiPath = ensureWikiDirs(rootDir, wikiDir, pageTypes);
    const dbPath = path.join(wikiPath, "meta", "wiki.db");
    const store = new WikiStore(dbPath);
    await store.init();

    initWiki(rootDir, config, store);
    store.close();

    ctx.log(`📖 ${preset?.name ?? "Codebase"} wiki initialized at ${wikiDir}`);
    ctx.log(`Domain: ${domain} — ${pageTypes.length} page types configured`);
    ctx.log(`Run \`wiki ingest all\` to populate it.`);

    if (ctx.args.json) {
      console.log(JSON.stringify({ initialized: true, path: wikiDir, domain, pageTypes: pageTypes.map(pt => pt.id) }));
    }
  })


  // ─── ingest ───────────────────────────────────────────────────────────
  .command("ingest", {
    description: "Ingest git commits, file tree, or docs into the wiki",
    args: [
      { name: "source", description: "What to ingest: commits, tree, smart, llm, or all", default: "commits" },
    ],
    flags: {
      since: {
        type: "string",
        alias: "s",
        description: "Time period for commits (e.g. '1 week ago', '3 days ago')",
        default: "1 week ago",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const source = posArg(ctx, 0, "commits");
    const since = (ctx.args.since as string) || "1 week ago";

    const store = await getStore(rootDir);
    if (!store) return;

    const spinner = ctx.spinner(`Ingesting ${source}...`);
    spinner.start();

    const results: string[] = [];
    let success = true;

    try {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);

      if (source === "commits" || source === "all") {
        const result = await ingestCommits(rootDir, DEFAULT_CONFIG, store, since);
        results.push(`Commits: ${result.commitsProcessed} processed, ${result.pagesCreated} created, ${result.pagesUpdated} updated`);
        if (result.errors.length > 0) results.push(`Errors: ${result.errors.join("; ")}`);
      }

      if (source === "tree" || source === "all") {
        const result = await ingestFileTree(rootDir, DEFAULT_CONFIG, store);
        results.push(`File tree: ${result.filesProcessed} files, ${result.pagesCreated} created, ${result.pagesUpdated} updated`);
        if (result.errors.length > 0) results.push(`Errors: ${result.errors.join("; ")}`);
      }

      if (source === "smart" || source === "all") {
        const result = enrichAllEntities(wikiPath, rootDir, store);
        results.push(`Smart: ${result.pagesEnriched} pages enriched, ${result.crossReferencesAdded} cross-references added`);
        updateIndex(wikiPath, store);
      }

      spinner.succeed(`Ingest complete`);

      for (const line of results) {
        console.log(`  ${line}`);
      }

      if (ctx.args.json) {
        console.log(JSON.stringify({ success: true, source, results }));
      }
    } catch (err) {
      spinner.fail(`Ingest failed`);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ ${msg}`);
      success = false;

      if (ctx.args.json) {
        console.log(JSON.stringify({ success: false, error: msg }));
      }
    } finally {
      closeStore(store);
    }
  })

  // ─── query ────────────────────────────────────────────────────────────
  .command("query", {
    description: "Search the codebase wiki for information",
    args: [
      { name: "question", required: true, description: "What to search for" },
    ],
    flags: {
      limit: {
        type: "number",
        alias: "l",
        description: "Max results (default 10)",
        default: 10,
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const question = posArg(ctx, 0);
    const limit = (ctx.args.limit as number) || 10;

    const store = await getStore(rootDir);
    if (!store) return;

    try {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
      const result = searchWiki(question, wikiPath, store, limit);

      if (result.matches.length === 0) {
        ctx.warn(`No results for "${question}". Try \`wiki ingest\` first.`);
        if (ctx.args.json) {
          console.log(JSON.stringify({ matches: 0, question }));
        }
        return;
      }

      console.log(`\n📖 Wiki search results for "${question}":\n`);

      for (const match of result.matches) {
        console.log(`  [[${match.page.id}]] (score: ${match.score.toFixed(2)})`);
        console.log(`  > ${match.snippet.slice(0, 120)}`);
        console.log(`  Type: ${match.page.type} | Updated: ${match.page.lastIngested.split("T")[0]}`);
        console.log();
      }

      console.log(`Found ${result.matches.length} of ${result.totalPages} pages.`);

      if (ctx.args.json) {
        console.log(JSON.stringify({
          question,
          matchCount: result.matches.length,
          totalPages: result.totalPages,
          matches: result.matches.map(m => ({
            id: m.page.id,
            score: m.score,
            snippet: m.snippet,
            type: m.page.type,
          })),
        }));
      }
    } finally {
      closeStore(store);
    }
  })

  // ─── lint ─────────────────────────────────────────────────────────────
  .command("lint", {
    description: "Health-check the wiki for contradictions, orphans, stale pages, broken links",
    args: [],
    flags: {},
  }, async (ctx) => {
    const rootDir = process.cwd();
    const store = await getStore(rootDir);
    if (!store) return;

    try {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
      const result = lintWiki(wikiPath, store);
      const report = formatLintResult(result);

      console.log(report);

      if (ctx.args.json) {
        console.log(JSON.stringify({
          issues: result.issues.length,
          totalPages: result.totalPages,
          healthyPages: result.healthyPages,
          stalePages: result.stalePages,
          orphanPages: result.orphanPages,
          details: result.issues,
        }));
      }
    } finally {
      closeStore(store);
    }
  })

  // ─── status ───────────────────────────────────────────────────────────
  .command("status", {
    description: "Show wiki stats: page counts, staleness, last ingest time",
    args: [],
    flags: {},
  }, async (ctx) => {
    const rootDir = process.cwd();
    const store = await getStore(rootDir);
    if (!store) return;

    try {
      const stats = store.getStats();
      const branch = getCurrentBranch(rootDir);
      const lastHash = getLatestHash(rootDir);
      const sourceCount = store.getSourceCount();

      console.log(`📖 Codebase Wiki Status\n`);
      console.log(`  Total pages:  ${stats.totalPages}`);
      for (const [type, count] of Object.entries(stats.pagesByType)) {
        console.log(`  ${type}:         ${count}`);
      }
      console.log(`  Stale pages:  ${stats.stalePages}`);
      console.log(`  Sources:       ${sourceCount.total}`);
      if (Object.keys(sourceCount.byType).length > 0) {
        for (const [type, count] of Object.entries(sourceCount.byType)) {
          console.log(`    ${type}: ${count}`);
        }
      }
      console.log(`  Last ingest:  ${stats.lastIngest ?? "never"}`);
      console.log(`  Git branch:   ${branch}`);
      console.log(`  Latest hash:  ${lastHash?.slice(0, 7) ?? "unknown"}`);

      if (ctx.args.json) {
        console.log(JSON.stringify({
          ...stats,
          branch,
          lastHash: lastHash?.slice(0, 7),
        }));
      }
    } finally {
      closeStore(store);
    }
  })

  // ─── entity ───────────────────────────────────────────────────────────
  .command("entity", {
    description: "Create or update an entity page in the wiki",
    args: [
      { name: "name", required: true, description: "Entity name (e.g. 'auth-module')" },
    ],
    flags: {
      summary: {
        type: "string",
        alias: "s",
        description: "One-paragraph description",
        required: true,
      },
      type: {
        type: "string",
        alias: "t",
        description: "Entity type: module, service, util, config, type",
        default: "module",
      },
      files: {
        type: "string",
        alias: "f",
        description: "Comma-separated source file paths",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const name = posArg(ctx, 0);
    const summary = ctx.args.summary as string;
    const type = (ctx.args.type as string) || "module";
    const files = ctx.args.files ? String(ctx.args.files).split(",").map(f => f.trim()) : [];

    const store = await getStore(rootDir);
    if (!store) return;

    try {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
      const entityDirName = getDirectoryForPageType("entity", DEFAULT_CONFIG.pageTypes);
      const entityDir = path.join(wikiPath, entityDirName);
      const fileName = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
      const filePath = path.join(entityDir, `${fileName}.md`);
      const today = new Date().toISOString().split("T")[0];
      const fileList = files.map(f => `- \`${f}\``).join("\n");

      const content = `# ${name}\n\n> **Summary**: ${summary}\n\n## Location\n- **Type**: ${type}\n\n## Key Files\n${fileList || "- (no files tracked)"}\n\n## Responsibilities\n- (to be documented)\n\n## Dependencies\n- (to be discovered)\n\n## Dependents\n- (to be discovered)\n\n## Design Decisions\n- (to be documented)\n\n## Evolution\n- **${today}** — Initial creation\n\n## See Also\n- [[index]]\n`;

      fs.mkdirSync(entityDir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");

      store.upsertPage({
        id: fileName,
        path: `${entityDirName}/${fileName}.md`,
        type: type as PageType,
        title: name,
        summary,
        sourceFiles: files,
        sourceCommits: [],
        lastIngested: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        inboundLinks: 0,
        outboundLinks: 0,
        stale: false,
      });

      ctx.log(`Entity created: [[${fileName}]]`);

      if (ctx.args.json) {
        console.log(JSON.stringify({ success: true, slug: fileName, path: filePath }));
      }
    } finally {
      closeStore(store);
    }
  })

  // ─── decision ─────────────────────────────────────────────────────────
  .command("decision", {
    description: "Create an Architecture Decision Record (ADR) in the wiki",
    args: [
      { name: "title", required: true, description: "Decision title (e.g. 'Use SQLite over LevelDB')" },
    ],
    flags: {
      context: {
        type: "string",
        alias: "c",
        description: "What is motivating this decision?",
        required: true,
      },
      choice: {
        type: "string",
        description: "What is the change being made?",
        required: true,
      },
      status: {
        type: "string",
        alias: "s",
        description: "Decision status: Proposed, Accepted, Deprecated",
        default: "Proposed",
      },
      alternatives: {
        type: "string",
        alias: "a",
        description: "Alternatives considered",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const title = posArg(ctx, 0);
    const context = ctx.args.context as string;
    const decision = String(ctx.args.choice ?? ctx.args.d ?? "");
    const status = (ctx.args.status as string) || "Proposed";
    const alternatives = ctx.args.alternatives as string | undefined;

    const store = await getStore(rootDir);
    if (!store) return;

    try {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
      const decisions = store.getPagesByType("decision");
      const adrNumber = String(decisions.length + 1).padStart(3, "0");
      const slug = `adr-${adrNumber}-${title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
      const fileName = slug.slice(0, 80);
      const decisionDirName = getDirectoryForPageType("decision", DEFAULT_CONFIG.pageTypes);
      const filePath = path.join(wikiPath, decisionDirName, `${fileName}.md`);
      const today = new Date().toISOString().split("T")[0];

      const content = `# ADR-${adrNumber}: ${title}\n\n> **Status**: ${status}\n\n## Context\n${context}\n\n## Decision\n${decision}\n\n## Consequences\n- (to be determined)\n\n## Alternatives Considered\n${alternatives || "- None documented yet"}\n\n## References\n- Created: ${today}\n\n## See Also\n- [[index]]\n`;

      fs.mkdirSync(path.join(wikiPath, decisionDirName), { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");

      store.upsertPage({
        id: fileName,
        path: `decisions/${fileName}.md`,
        type: "decision",
        title: `ADR-${adrNumber}: ${title}`,
        summary: decision.slice(0, 200),
        sourceFiles: [],
        sourceCommits: [],
        lastIngested: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        inboundLinks: 0,
        outboundLinks: 0,
        stale: false,
      });

      ctx.log(`ADR created: [[${fileName}]] — ADR-${adrNumber}: ${title}`);
      ctx.log(`Status: ${status}`);

      if (ctx.args.json) {
        console.log(JSON.stringify({ success: true, slug: fileName, adrNumber }));
      }
    } finally {
      closeStore(store);
    }
  })

  // ─── concept ──────────────────────────────────────────────────────────
  .command("concept", {
    description: "Create or update a concept page in the wiki",
    args: [
      { name: "name", required: true, description: "Concept name (e.g. 'hot-reload')" },
    ],
    flags: {
      summary: {
        type: "string",
        alias: "s",
        description: "One-paragraph description",
        required: true,
      },
      applies: {
        type: "string",
        alias: "a",
        description: "Comma-separated entity slugs this concept applies to",
      },
      details: {
        type: "string",
        alias: "d",
        description: "Detailed description",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const name = posArg(ctx, 0);
    const summary = ctx.args.summary as string;
    const appliesTo = ctx.args.applies ? String(ctx.args.applies).split(",").map(s => s.trim()) : [];
    const details = ctx.args.details as string | undefined;

    const store = await getStore(rootDir);
    if (!store) return;

    try {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
      const slug = toSlug(name);
      const conceptDirName = getDirectoryForPageType("concept", DEFAULT_CONFIG.pageTypes);
      const conceptDir = path.join(wikiPath, conceptDirName);
      const filePath = path.join(conceptDir, `${slug}.md`);
      const today = formatWikiDate(new Date());

      const appliesLines = appliesTo.length > 0
        ? appliesTo.map(a => `- [[${a}]]`).join("\n")
        : "- (to be discovered)";

      const content = `# ${name}\n\n> **Summary**: ${summary}\n\n## Applies To\n${appliesLines}\n\n## Description\n${details || "(to be expanded through analysis)"}\n\n## Key Characteristics\n- (to be discovered)\n\n## See Also\n- [[index]]\n\n---\n*Created: ${today}*\n`;

      fs.mkdirSync(conceptDir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");

      store.upsertPage({
        id: slug,
        path: `concepts/${slug}.md`,
        type: "concept",
        title: name,
        summary,
        sourceFiles: [],
        sourceCommits: [],
        lastIngested: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        inboundLinks: 0,
        outboundLinks: appliesTo.length,
        stale: false,
      });

      for (const target of appliesTo) {
        if (validateSlug(target)) {
          store.addCrossReference(slug, target, "concept applies to");
        }
      }

      updateIndex(wikiPath, store);

      ctx.log(`Concept created: [[${slug}]]`);

      if (ctx.args.json) {
        console.log(JSON.stringify({ success: true, slug, appliesTo }));
      }
    } finally {
      closeStore(store);
    }
  })

  // ─── changelog ────────────────────────────────────────────────────────
  .command("changelog", {
    description: "Generate a changelog from recent git commits",
    args: [],
    flags: {
      since: {
        type: "string",
        alias: "s",
        description: "Time period (e.g. '1 week ago', '2026-01-01')",
        default: "1 week ago",
      },
      format: {
        type: "string",
        alias: "f",
        description: "Output format: markdown or keepachangelog",
        default: "keepachangelog",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const since = (ctx.args.since as string) || "1 week ago";
    const format = (ctx.args.format as string) || "keepachangelog";

    const commits = getRecentCommits(rootDir, since);

    if (commits.length === 0) {
      ctx.warn(`No commits found since ${since}.`);
      if (ctx.args.json) {
        console.log(JSON.stringify({ commits: 0, since }));
      }
      return;
    }

    let changelogContent: string;

    if (format === "keepachangelog") {
      const lines: string[] = [
        `# Changelog`,
        ``,
        `## [Recent] - ${new Date().toISOString().split("T")[0]}`,
        ``,
      ];

      const byType: Record<string, GitCommit[]> = {};
      for (const commit of commits) {
        const type = commit.type || "other";
        if (!byType[type]) byType[type] = [];
        byType[type].push(commit);
      }

      const typeLabels: Record<string, string> = {
        feat: "### Added",
        fix: "### Fixed",
        refactor: "### Changed",
        perf: "### Performance",
        docs: "### Documentation",
        test: "### Tests",
        breaking: "### Breaking Changes",
      };

      for (const [type, typeCommits] of Object.entries(byType)) {
        const label = typeLabels[type] ?? "### Other";
        lines.push(label);
        for (const c of typeCommits) {
          const scope = c.scope ? `**${c.scope}**: ` : "";
          lines.push(`- ${scope}${c.subject} ([${c.hash.slice(0, 7)}])`);
        }
        lines.push("");
      }

      changelogContent = lines.join("\n");
    } else {
      const lines = commits.map(c => {
        const scope = c.scope ? `(${c.scope})` : "";
        return `- \`${c.hash.slice(0, 7)}\` **${c.type}${scope}**: ${c.subject}`;
      });
      changelogContent = `# Recent Commits\n\n${lines.join("\n")}`;
    }

    // Persist to wiki (merge with existing)
    const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
    if (wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
      const changelogPath = path.join(wikiPath, "CHANGELOG.md");
      let finalChangelog = changelogContent;
      try {
        const existing = fs.readFileSync(changelogPath, "utf-8");
        if (existing && format === "keepachangelog") {
          // For keepachangelog format, merge new entries into existing
          // Simply overwrite — changelog is regenerated from git each time
          // and should reflect the current state. This is intentional.
        }
      } catch {
        // No existing changelog
      }
      fs.writeFileSync(changelogPath, finalChangelog, "utf-8");
    }

    console.log(changelogContent);

    if (ctx.args.json) {
      console.log(JSON.stringify({ commits: commits.length, since, format }));
    }
  })

  // ─── evolve ───────────────────────────────────────────────────────────
  .command("evolve", {
    description: "Trace how a feature or module changed over time",
    args: [
      { name: "feature", required: true, description: "Feature or module name to trace" },
    ],
    flags: {},
  }, async (ctx) => {
    const rootDir = process.cwd();
    const feature = posArg(ctx, 0);
    const allCommits = getAllCommits(rootDir);
    const slug = feature.toLowerCase().replace(/[^a-z0-9]/g, "-");

    const related = allCommits.filter(c => {
      const text = `${c.subject} ${c.body} ${c.scope} ${c.files.join(" ")}`.toLowerCase();
      return text.includes(feature.toLowerCase());
    });

    if (related.length === 0) {
      ctx.warn(`No commits found related to "${feature}".`);
      if (ctx.args.json) {
        console.log(JSON.stringify({ feature, commits: 0 }));
      }
      return;
    }

    const lines: string[] = [
      `# Evolution of ${feature}`,
      ``,
      `> **Summary**: ${related.length} commits touch this feature.`,
      ``,
      `## Timeline`,
      ``,
    ];

    for (const c of related.reverse()) {
      const date = c.date.split(" ")[0] ?? c.date;
      const scope = c.scope ? `(${c.scope})` : "";
      lines.push(`### ${date} — ${c.type}${scope}: ${c.subject}`);
      lines.push(`Commit: \`${c.hash.slice(0, 7)}\` | Files: ${c.files.length}`);
      if (c.body) lines.push(`> ${c.body.slice(0, 200)}`);
      lines.push("");
    }

    // Persist to wiki if initialized (merge with existing evolution page)
    if (wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
      const evolutionDirName = getDirectoryForPageType("evolution", DEFAULT_CONFIG.pageTypes);
      const evolvePath = path.join(wikiPath, evolutionDirName, `${slug}.md`);
      fs.mkdirSync(path.join(wikiPath, evolutionDirName), { recursive: true });

      // Merge new timeline entries with existing evolution page
      let existingContent: string | null = null;
      try {
        existingContent = fs.readFileSync(evolvePath, "utf-8");
      } catch {
        // No existing page — write fresh
      }

      if (existingContent) {
        const existingHashes = new Set(
          [...existingContent.matchAll(/Commit: `([a-f0-9]{7,40})`/g)].map(m => m[1]!.slice(0, 7))
        );
        const newLines = lines.filter(line => {
          const hashMatch = line.match(/Commit: `([a-f0-9]{7,40})`/);
          if (hashMatch) return !existingHashes.has(hashMatch[1]!.slice(0, 7));
          return true;
        });
        const timelineIdx = existingContent.indexOf("## Timeline");
        if (timelineIdx !== -1) {
          const afterIdx = existingContent.indexOf("\n", timelineIdx) + 1;
          const merged = existingContent.slice(0, afterIdx) + "\n" + newLines.join("\n") + existingContent.slice(afterIdx);
          fs.writeFileSync(evolvePath, merged, "utf-8");
        } else {
          fs.writeFileSync(evolvePath, existingContent + "\n\n" + newLines.join("\n"), "utf-8");
        }
      } else {
        fs.writeFileSync(evolvePath, lines.join("\n"), "utf-8");
      }

      const store = await getStore(rootDir);
      if (store) {
        try {
          store.upsertPage({
            id: `evolution-${slug}`,
            path: `evolution/${slug}.md`,
            type: "evolution",
            title: `Evolution of ${feature}`,
            summary: `${related.length} commits touch ${feature} over its history`,
            sourceFiles: related.slice(0, 10).map(c => c.files[0] ?? ""),
            sourceCommits: related.slice(0, 10).map(c => c.hash),
            lastIngested: new Date().toISOString(),
            lastChecked: new Date().toISOString(),
            inboundLinks: 0,
            outboundLinks: 0,
            stale: false,
          });
          updateIndex(wikiPath, store);
        } finally {
          closeStore(store);
        }
      }
    }

    console.log(lines.join("\n"));

    if (ctx.args.json) {
      console.log(JSON.stringify({ feature, commits: related.length }));
    }
  })

  // ─── reindex ──────────────────────────────────────────────────────────
  .command("reindex", {
    description: "Rebuild the wiki INDEX.md from the store",
    args: [],
    flags: {},
  }, async (ctx) => {
    const rootDir = process.cwd();
    const store = await getStore(rootDir);
    if (!store) return;

    try {
      const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
      updateIndex(wikiPath, store);
      ctx.log("Wiki index rebuilt.");
    } finally {
      closeStore(store);
    }
  })

  // ─── serve ───────────────────────────────────────────────────────────
  .command("serve", {
    description: "Start local web UI with page browser and graph visualization",
    args: [],
    flags: {
      port: {
        type: "number",
        alias: "p",
        description: "Port to serve on (default 3000)",
        default: 3000,
      },
      open: {
        type: "boolean",
        alias: "o",
        description: "Open browser automatically",
        default: false,
      },
    },
  }, async (ctx) => {
    const { serveWiki } = await import("./web/server.js");
    const port = (ctx.args.port as number) || 3000;
    const shouldOpen = ctx.args.open as boolean;
    await serveWiki(process.cwd(), DEFAULT_CONFIG, { port, open: shouldOpen });
  })

  // ─── ingest-source ──────────────────────────────────────────────────────
  .command("ingest-source", {
    description: "Ingest an arbitrary source (article, note, conversation, etc.) into the wiki",
    args: [
      { name: "type", description: "Source type: article, note, conversation, document, url, media, manual", required: true },
      { name: "title", description: "Title for the source", required: true },
    ],
    flags: {
      content: {
        type: "string",
        alias: "c",
        description: "Content of the source (use @file to read from a file)",
      },
      file: {
        type: "string",
        alias: "f",
        description: "Path to a file to ingest as content",
      },
      url: {
        type: "string",
        alias: "u",
        description: "Original URL for this source",
      },
      "page-type": {
        type: "string",
        description: "Wiki page type to create (auto-detected if omitted)",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const sourceType = posArg(ctx, 0);
    const title = posArg(ctx, 1);
    const contentFlag = ctx.args.content as string | undefined;
    const filePath = ctx.args.file as string | undefined;
    const url = ctx.args.url as string | undefined;
    const pageType = ctx.args["page-type"] as string | undefined;

    if (!wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
      console.error("❌ Wiki not initialized. Run `wiki init` first.");
      process.exit(1);
    }

    let content = "";
    if (filePath) {
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        console.error(`❌ Could not read file: ${filePath}`);
        process.exit(1);
      }
    } else if (contentFlag) {
      content = contentFlag;
    } else {
      // Read from stdin
      console.error("📖 Reading from stdin... (pass --content or --file for direct input)");
      content = fs.readFileSync("/dev/stdin", "utf-8");
    }

    if (!content.trim()) {
      console.error("❌ No content provided. Use --content, --file, or pipe content via stdin.");
      process.exit(1);
    }

    const store = await getStore(rootDir);
    if (!store) return;

    const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
    const { ingestSource } = await import("./operations/source.js");

    const result = ingestSource(wikiPath, rootDir, sourceType as any, title, content, store, {
      url,
      pageType,
    });

    const { updateIndex } = await import("./operations/ingest.js");
    updateIndex(wikiPath, store);

    if (result.errors.length > 0) {
      console.error(`⚠️ Source ingested with errors:`);
      for (const err of result.errors) console.error(`  ${err}`);
    } else {
      console.log(`✅ Source ingested:`);
    }

    console.log(`  Manifest: ${result.manifestId}`);
    console.log(`  Pages created: ${result.pagesCreated.join(", ") || "none"}`);
    console.log(`  Pages updated: ${result.pagesUpdated.join(", ") || "none"}`);
    console.log(`  Source path: ${result.sourcePath}`);

    if (ctx.args.json) {
      console.log(JSON.stringify({ success: true, manifestId: result.manifestId, pagesCreated: result.pagesCreated, pagesUpdated: result.pagesUpdated }));
    }

    closeStore(store);
  })

  // ─── ingest-url ────────────────────────────────────────────────────────
  .command("ingest-url", {
    description: "Fetch a web page and ingest it into the wiki",
    args: [
      { name: "url", description: "URL to fetch and ingest", required: true },
    ],
    flags: {
      title: {
        type: "string",
        alias: "t",
        description: "Override title (auto-detected if omitted)",
      },
      "page-type": {
        type: "string",
        description: "Wiki page type to create",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const url = posArg(ctx, 0);
    const title = ctx.args.title as string | undefined;
    const pageType = ctx.args["page-type"] as string | undefined;

    if (!wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
      console.error("❌ Wiki not initialized. Run `wiki init` first.");
      process.exit(1);
    }

    const store = await getStore(rootDir);
    if (!store) return;

    const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
    console.log(`📖 Fetching ${url}...`);

    const { ingestUrl } = await import("./operations/source.js");
    const result = await ingestUrl(wikiPath, rootDir, url, store, { title, pageType });

    const { updateIndex } = await import("./operations/ingest.js");
    updateIndex(wikiPath, store);

    if (result.errors.length > 0) {
      console.error(`⚠️ URL ingested with errors:`);
      for (const err of result.errors) console.error(`  ${err}`);
    } else {
      console.log(`✅ URL ingested:`);
    }

    console.log(`  Title: ${result.title}`);
    console.log(`  Content length: ${result.contentLength} chars`);
    console.log(`  Pages created: ${result.pagesCreated.join(", ") || "none"}`);

    if (ctx.args.json) {
      console.log(JSON.stringify({ success: true, manifestId: result.manifestId, title: result.title, contentLength: result.contentLength }));
    }

    closeStore(store);
  })

  // ─── sources ────────────────────────────────────────────────────────────
  .command("sources", {
    description: "List all ingested sources",
    args: [],
    flags: {
      type: {
        type: "string",
        alias: "t",
        description: "Filter by source type (article, note, url, git-commits, etc.)",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const typeFilter = ctx.args.type as string | undefined;

    if (!wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
      console.error("❌ Wiki not initialized. Run `wiki init` first.");
      process.exit(1);
    }

    const store = await getStore(rootDir);
    if (!store) return;

    const sources = typeFilter ? store.getSources(typeFilter) : store.getSources();
    const count = store.getSourceCount();

    console.log(`\n📖 Wiki Sources (${count.total} total)\n`);

    for (const [type, num] of Object.entries(count.byType)) {
      console.log(`  ${type}: ${num}`);
    }

    if (sources.length > 0) {
      console.log(`\nRecent sources:`);
      for (const s of sources.slice(0, 20)) {
        const date = s.ingestedAt.split("T")[0];
        console.log(`  [${date}] ${s.type}: ${s.title} (${s.id})`);
      }
    }

    if (ctx.args.json) {
      console.log(JSON.stringify({ total: count.total, byType: count.byType, sources: sources.map(s => ({ id: s.id, type: s.type, title: s.title, ingestedAt: s.ingestedAt, pagesCreated: s.pagesCreated })) }));
    }

    closeStore(store);
  })

  // ─── log ───────────────────────────────────────────────────────────────────
  .command("log", {
    description: "Show structured wiki log entries",
    args: [],
    flags: {
      last: {
        type: "number",
        alias: "n",
        description: "Number of recent entries to show (default 10)",
        default: 10,
      },
      type: {
        type: "string",
        alias: "t",
        description: "Filter by type (ingest, query, lint, resolve, manual)",
      },
      since: {
        type: "string",
        alias: "s",
        description: "Show entries since this date (e.g. '2026-04-01')",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const lastN = (ctx.args.last as number) || 10;
    const typeFilter = ctx.args.type as string | undefined;
    const since = ctx.args.since as string | undefined;

    if (!wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
      console.error("\u274c Wiki not initialized. Run `wiki init` first.");
      process.exit(1);
    }

    const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
    const { parseLog, getRecentLog, getLogByType, getLogSince } = await import("./operations/log.js");

    let entries;
    if (typeFilter) {
      entries = getLogByType(wikiPath, typeFilter);
    } else if (since) {
      entries = getLogSince(wikiPath, since);
    } else {
      entries = getRecentLog(wikiPath, lastN);
    }

    if (entries.length === 0) {
      ctx.warn("No log entries found.");
      return;
    }

    console.log(`\n📖 Wiki Log (showing ${entries.length} entries)\n`);

    for (const entry of entries) {
      const date = entry.timestamp.split("T")[0] ?? entry.timestamp;
      const time = entry.timestamp.split("T")[1]?.slice(0, 5) ?? "";
      console.log(`  ## [${date} ${time}] ${entry.type} | ${entry.source} | ${entry.title}`);
      if (entry.pagesCreated.length > 0) {
        console.log(`     Created: ${entry.pagesCreated.join(", ")}`);
      }
      if (entry.pagesUpdated.length > 0) {
        console.log(`     Updated: ${entry.pagesUpdated.join(", ")}`);
      }
      if (entry.sourceManifestId) {
        console.log(`     Source: ${entry.sourceManifestId}`);
      }
      if (entry.details) {
        console.log(`     ${entry.details}`);
      }
      console.log();
    }

    if (ctx.args.json) {
      console.log(JSON.stringify(entries));
    }
  })

  // ─── resolve ────────────────────────────────────────────────────────────────
  .command("resolve", {
    description: "Resolve contradictions between wiki pages",
    args: [{ name: "strategy", description: "Resolution strategy: merge, update, or split" }],
    flags: {
      target: {
        type: "string",
        alias: "t",
        description: "Target page for merge (merge: target retains content)",
      },
      into: {
        type: "string",
        alias: "i",
        description: "New page ID for split (comma-separated for multiple)",
      },
      titles: {
        type: "string",
        description: "New page titles for split (comma-separated)",
      },
      json: {
        type: "boolean",
        alias: "j",
        description: "Output as JSON",
      },
    },
  }, async (ctx) => {
    const rootDir = process.cwd();
    const strategy = ctx.args.strategy as string;
    const pageArgs = (ctx.args._ as string[]).filter(a => !a.startsWith("-"));

    if (!wikiExists(rootDir, DEFAULT_CONFIG.wikiDir)) {
      ctx.error("❌ Wiki not initialized. Run `wiki init` first.");
      process.exit(1);
    }

    const wikiPath = getWikiPath(rootDir, DEFAULT_CONFIG.wikiDir);
    const store = new WikiStore(path.join(wikiPath, "meta", "wiki.db"));
    await store.init();

    try {
      // No strategy → list contradictions
      if (!strategy || strategy === "list") {
        const pages = store.getAllPages();
        const contradictions = findContradictionsDetailed(wikiPath, pages);

        if (contradictions.length === 0) {
          ctx.log("✅ No contradictions found.");
          return;
        }

        ctx.log(`\n🔍 Found ${contradictions.length} potential contradiction(s):\n`);
        for (const c of contradictions) {
          const pct = (c.similarity * 100).toFixed(0);
          ctx.log(`  [[${c.pageA.id}]] ↔ [[${c.pageB.id}]] — ${pct}% overlap`);
          ctx.log(`    Suggestion: ${c.suggestion} — ${c.reason}`);
          ctx.log("");
        }

        if (ctx.args.json) {
          console.log(JSON.stringify(contradictions));
        }
        return;
      }

      // Resolve strategies require page IDs
      if (strategy === "merge") {
        const sourceId = pageArgs[0];
        const targetId = ctx.args.target as string || pageArgs[1];
        if (!sourceId || !targetId) {
          ctx.error("Usage: wiki resolve merge <source> --target <target>");
          process.exit(1);
        }

        const result = mergePages(wikiPath, store, sourceId, targetId);
        ctx.log(`✅ Merged [[${sourceId}]] into [[${targetId}]]`);
        ctx.log(`   Redirected ${result.redirected.length} references`);
      } else if (strategy === "update") {
        const pageAId = pageArgs[0];
        const pageBId = pageArgs[1];
        if (!pageAId || !pageBId) {
          ctx.error("Usage: wiki resolve update <page-a> <page-b>");
          process.exit(1);
        }

        const result = updatePages(wikiPath, store, pageAId, pageBId);
        ctx.log(`✅ Added cross-references between [[${pageAId}]] and [[${pageBId}]]`);
        ctx.log(`   Updated ${result.updated.length} pages`);
      } else if (strategy === "split") {
        const sourceId = pageArgs[0];
        const intoStr = ctx.args.into as string;
        const titlesStr = ctx.args.titles as string;
        if (!sourceId || !intoStr) {
          ctx.error("Usage: wiki resolve split <source> --into <new-id> --titles <new-title>");
          process.exit(1);
        }
        const newId = intoStr.split(",")[0]!.trim();
        const newTitle = (titlesStr?.split(",")[0]?.trim()) || newId;

        // Split: move sections starting with certain keywords to new page
        const result = splitPage(wikiPath, store, sourceId, newId, newTitle, (sectionTitle) => {
          // Default: move sections after the first 3 to the new page
          // This is a simple heuristic; users can edit after splitting
          return false; // Will need interactive input or flags for section selection
        });
        ctx.log(`✅ Split [[${sourceId}]] — created [[${result.newPage}]]`);
      } else {
        ctx.error(`Unknown strategy: ${strategy}. Use: merge, update, split, or list`);
        process.exit(1);
      }
    } finally {
      closeStore(store);
    }
  })

  .run();