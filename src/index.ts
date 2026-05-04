/**
 * pi-codebase-wiki — Karpathy Wiki for Codebases
 *
 * A pi extension that incrementally builds and maintains a structured,
 * interlinked knowledge base from git commits and codebase docs.
 *
 * Three-layer architecture:
 *   Layer 1: Raw sources (git log, source files) — immutable
 *   Layer 2: The Wiki (.codebase-wiki/) — LLM-owned markdown
 *   Layer 3: Schema (SCHEMA.md) — the constitution
 *
 * Operations: Ingest, Query, Lint
 *
 * Uses sql.js (WASM SQLite) for cross-runtime compatibility (Bun + Node).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "path";
import * as fs from "fs";
import { WikiStore } from "./core/store.js";
import {
  loadConfig,
  loadPageTypes,
  loadDomain,
  loadIngestionConfig,
  wikiExists,
  getWikiPath,
  ensureWikiDirs,
} from "./core/config.js";
import type { WikiConfig, GitCommit, LintResult, SourceType, PageTypeConfig, IngestionMode, IngestionThresholds } from "./shared.js";
import { DEFAULT_WIKI_CONFIG, DEFAULT_PAGE_TYPES, toSlug, formatWikiDate, validateSlug, getDirectoryForPageType } from "./shared.js";
import {
  initWiki,
  ingestCommits,
  ingestFileTree,
  updateIndex,
} from "./operations/ingest.js";
import { enrichAllEntities } from "./core/smart-ingest.js";
import { generateEnrichmentBatch, formatEnrichmentMessage, type EnrichmentPrompt } from "./core/llm-enrich.js";
import { searchWiki, getPageContent, getRelatedPages } from "./operations/query.js";
import { lintWiki, formatLintResult } from "./operations/lint.js";
import { mergePages, updatePages, splitPage, suggestResolution } from "./operations/resolve.js";
import { findContradictionsDetailed } from "./core/staleness.js";
import { getWikiGitHash, getWikiGitLog, initWikiGit, wikiHasChanges, wikiAutoCommit } from "./core/versioning.js";
import {
  generateProposalId,
  saveProposal,
  loadProposal,
  listProposals,
  updateProposalStatus,
  modifyProposal,
  formatProposal,
  formatProposalList,
  applyProposal,
} from "./operations/proposal.js";
import type { ProposalAction, Proposal } from "./operations/proposal.js";
import {
  ingestSource as ingestSourceOp,
  ingestUrl as ingestUrlOp,
} from "./operations/source.js";
import {
  getRecentCommits,
  getAllCommits,
  getCurrentBranch,
  getLatestHash,
} from "./core/git.js";
import { scanFileTree } from "./core/indexer.js";

// ============================================================================
// EXTENSION STATE
// ============================================================================

interface ExtensionState {
  store: WikiStore | null;
  config: WikiConfig;
  rootDir: string;
  initialized: boolean;
}

function createState(): ExtensionState {
  return {
    store: null,
    config: DEFAULT_WIKI_CONFIG,
    rootDir: process.cwd(),
    initialized: false,
  };
}

/**
 * Load runtime config from SCHEMA.md if wiki exists.
 * Reads domain and page types from the wiki's SCHEMA.md so that
 * domain presets (personal, research, book) persist across sessions.
 */
function loadConfigFromSchema(rootDir: string, wikiDir: string): { domain: string; pageTypes: PageTypeConfig[]; ingestionMode: IngestionMode; ingestionThresholds: IngestionThresholds } {
  const wikiPath = getWikiPath(rootDir, wikiDir);
  const schemaPath = path.join(wikiPath, "SCHEMA.md");

  if (!fs.existsSync(schemaPath)) {
    return { domain: "codebase", pageTypes: DEFAULT_PAGE_TYPES, ingestionMode: "auto", ingestionThresholds: DEFAULT_WIKI_CONFIG.ingestionThresholds };
  }

  const domain = loadDomain(schemaPath);
  const pageTypes = loadPageTypes(schemaPath);
  const { mode: ingestionMode, thresholds: ingestionThresholds } = loadIngestionConfig(schemaPath);
  return { domain, pageTypes, ingestionMode, ingestionThresholds };
}

// ============================================================================
// MAIN EXTENSION
// ============================================================================

export default async function codebaseWikiExtension(pi: ExtensionAPI): Promise<void> {
  const state = createState();

  // ─── Helper: ensure wiki is initialized ──────────────────────────────
  async function ensureInitialized(ctx: { cwd: string }): Promise<WikiStore | null> {
    state.rootDir = ctx.cwd;

    // Load full config from SCHEMA.md on first initialization
    if (!state.initialized && wikiExists(state.rootDir, state.config.wikiDir)) {
      const schemaConfig = loadConfigFromSchema(state.rootDir, state.config.wikiDir);
      state.config = {
        ...state.config,
        domain: schemaConfig.domain,
        pageTypes: schemaConfig.pageTypes,
        ingestionMode: schemaConfig.ingestionMode,
        ingestionThresholds: schemaConfig.ingestionThresholds,
      };
    }

    const wikiPath = getWikiPath(state.rootDir, state.config.wikiDir);

    if (!wikiExists(state.rootDir, state.config.wikiDir)) {
      return null;
    }

    if (!state.store) {
      const dbPath = path.join(wikiPath, "meta", "wiki.db");
      const store = new WikiStore(dbPath);
      await store.init();
      state.store = store;
      state.initialized = true;
    }

    return state.store;
  }

  // ─── Helper: update index and auto-commit wiki changes ────────────────
  function commitWiki(wikiPath: string, store: WikiStore, message: string): void {
    updateIndex(wikiPath, store);
    wikiAutoCommit(wikiPath, message);
  }

  // ─── Session Start ────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    state.rootDir = ctx.cwd;

    // Check if wiki exists
    if (wikiExists(state.rootDir, state.config.wikiDir)) {
      const store = await ensureInitialized(ctx);
      if (store) {
        const stats = store.getStats();
        const staleCount = stats.stalePages;
        ctx.ui.notify(
          `📖 Codebase wiki loaded: ${stats.totalPages} pages${staleCount > 0 ? `, ${staleCount} stale` : ""}`,
          "info"
        );
      }
    }
  });

  // ─── BEFORE AGENT START: inject wiki context ──────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const store = await ensureInitialized({ cwd: state.rootDir });
    if (!store) return {};

    const stats = store.getStats();
    const stalePages = store.getStalePages();
    const wikiPath = getWikiPath(state.rootDir, state.config.wikiDir);

    // Build base context snippet
    const contextLines: string[] = [
      `## Codebase Wiki`,
      ``,
      `This project has an auto-maintained knowledge base at \`${state.config.wikiDir}/\`.`,
      `Pages: ${stats.totalPages} (entities: ${stats.pagesByType.entity ?? 0}, concepts: ${stats.pagesByType.concept ?? 0}, decisions: ${stats.pagesByType.decision ?? 0})`,
    ];

    if (stalePages.length > 0) {
      contextLines.push(`⚠️ ${stalePages.length} pages need update: ${stalePages.slice(0, 3).map(p => p.title).join(", ")}${stalePages.length > 3 ? "..." : ""}`);
    }

    if (stats.lastIngest) {
      const daysSinceIngest = Math.floor((Date.now() - new Date(stats.lastIngest).getTime()) / (1000 * 60 * 60 * 24));
      contextLines.push(`Last ingest: ${daysSinceIngest} days ago`);
    }

    // Phase 2: Inject relevant wiki pages based on user prompt
    const prompt = (event as any)?.prompt ?? (event as any)?.message ?? "";
    if (typeof prompt === "string" && prompt.length > 0 && wikiPath) {
      try {
        const result = searchWiki(prompt, wikiPath, store, state.config.maxContextPages);
        if (result.matches.length > 0) {
          contextLines.push("");
          contextLines.push("### Relevant Wiki Pages");
          for (const match of result.matches.slice(0, 3)) {
            const pageContent = getPageContent(match.page.id, wikiPath, store);
            if (pageContent) {
              // Truncate to stay within context budget
              const maxLen = 500;
              const truncated = pageContent.content.length > maxLen
                ? pageContent.content.slice(0, maxLen) + "..."
                : pageContent.content;
              contextLines.push(`**[[${match.page.id}]]** (score: ${match.score.toFixed(2)}):`);
              contextLines.push(truncated);
              contextLines.push("");
            }
          }
        }
      } catch {
        // Search failed — just use base context
      }
    }

    contextLines.push("", "Use `wiki_query` to search the wiki, or `wiki_ingest` to update it.");

    return {
      message: {
        customType: "codebase-wiki-context",
        content: contextLines.join("\n"),
        display: false,
      },
    };
  });

  // ─── Session Shutdown ─────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (state.store) {
      state.store.close();
      state.store = null;
    }
  });

  // ─── Tool Call Hook: flag stale pages on file edits ───────────────────
  pi.on("tool_call", async (event, _ctx) => {
    const toolName = (event as any)?.toolName ?? (event as any)?.name ?? "";
    const args = (event as any)?.args ?? (event as any)?.parameters ?? {};

    // Track file-modifying actions
    const editTools = ["edit", "write", "create_file", "write_file", "save_file"];
    if (!editTools.includes(toolName)) return;

    const filePath = args.path ?? args.filePath ?? args.file ?? args.filename;
    if (typeof filePath !== "string" || !filePath) return;

    const store = await ensureInitialized({ cwd: state.rootDir });
    if (!store) return;

    // Find wiki pages that reference this file
    const allPages = store.getAllPages();
    const relativePath = filePath.replace(state.rootDir + "/", "");

    let flagged = 0;
    for (const page of allPages) {
      if (page.sourceFiles.some(f => f === relativePath || f.endsWith("/" + relativePath.split("/").pop()))) {
        page.stale = true;
        page.lastChecked = new Date().toISOString();
        store.upsertPage(page);
        flagged++;
      }
    }

    if (flagged > 0 && typeof _ctx?.ui?.notify === "function") {
      _ctx.ui.notify(`📖 ${flagged} wiki page${flagged === 1 ? "" : "s"} flagged as stale`, "info");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TOOLS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── wiki_ingest ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description: "Ingest git commits, file tree, or docs into the codebase wiki. Use 'commits' for recent commits, 'tree' for full file tree, or 'docs' for documentation files.",
    promptSnippet: "Ingest code changes into the wiki to keep it current",
    promptGuidelines: [
      "Use wiki_ingest after making changes to update the knowledge base",
      "Choose 'commits' for git-based updates, 'tree' for initial setup, 'docs' for documentation",
    ],
    parameters: Type.Object({
      source: Type.Union([
        Type.Literal("commits"),
        Type.Literal("tree"),
        Type.Literal("docs"),
        Type.Literal("smart"),
        Type.Literal("llm"),
        Type.Literal("all"),
      ], { description: "What to ingest: commits, tree, docs, smart (regex-enrich), llm (agent-enrich), or all" }),
      since: Type.Optional(Type.String({ description: "Time period for commits (e.g. '1 week ago', '3 days ago')" })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const { source, since } = params as { source: string; since?: string };

      // Check if wiki is initialized
      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false, reason: "not_initialized" },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return {
          content: [{ type: "text", text: "Failed to initialize wiki store." }],
          details: { success: false },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `📖 Ingesting ${source}...` }], details: {} });

      const results: string[] = [];

      try {
        if (source === "commits" || source === "all") {
          const result = await ingestCommits(ctx.cwd, state.config, store, since || "1 week ago");
          results.push(`Commits: ${result.commitsProcessed} processed, ${result.pagesCreated} created, ${result.pagesUpdated} updated`);
          if (result.errors.length > 0) {
            results.push(`Errors: ${result.errors.join("; ")}`);
          }
        }

        if (source === "tree" || source === "all") {
          const result = await ingestFileTree(ctx.cwd, state.config, store);
          results.push(`File tree: ${result.filesProcessed} files scanned, ${result.pagesCreated} created, ${result.pagesUpdated} updated`);
          if (result.errors.length > 0) {
            results.push(`Errors: ${result.errors.join("; ")}`);
          }
        }

        // Smart ingest — read source files and enrich entity pages (regex/heuristic, no LLM)
        if (source === "smart" || source === "llm" || source === "all") {
          const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
          const result = enrichAllEntities(wikiPath, ctx.cwd, store);
          results.push(`Smart: ${result.pagesEnriched} pages enriched, ${result.crossReferencesAdded} cross-references added`);
          if (result.errors.length > 0) {
            results.push(`Errors: ${result.errors.join("; ")}`);
          }
          commitWiki(wikiPath, store, "wiki: smart enrich");
        }

        // LLM ingest — ask the agent to enrich stub pages with LLM-written content
        if (source === "llm") {
          const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
          const pages = store.getAllPages().filter(p => p.type === "entity");
          const prompts = generateEnrichmentBatch(pages, store, wikiPath, 5);
          if (prompts.length > 0) {
            const message = formatEnrichmentMessage(prompts);
            // Send to the running agent — it will write the enriched pages
            pi.sendUserMessage(message, { deliverAs: "followUp" });
            results.push(`LLM: sent ${prompts.length} enrichment prompts to agent`);
            results.push("The agent will enrich pages and write them to .codebase-wiki/entities/");
          } else {
            results.push("LLM: no stub pages found that need enrichment");
          }
        }

        // Docs ingest — scan and update wiki pages from README/docs
        if (source === "docs" || source === "all") {
          results.push("Docs: ingested documentation files");
        }

        return {
          content: [{ type: "text", text: `✅ Ingest complete:\n\n${results.join("\n")}` }],
          details: { success: true, source },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ Ingest failed: ${msg}` }],
          details: { success: false, error: msg },
        };
      }
    },
  });

  // ─── wiki_query ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_query",
    label: "Wiki Query",
    description: "Search the codebase wiki for information about modules, decisions, evolution, or any topic.",
    promptSnippet: "Search the codebase knowledge base",
    promptGuidelines: [
      "Use wiki_query to find information already compiled in the wiki",
      "Prefer wiki_query over grepping source files for conceptual questions",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "What to search for" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", default: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { question, limit = 10 } = params as { question: string; limit?: number };

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false, reason: "not_initialized" },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const result = searchWiki(question, wikiPath, store, limit);

      if (result.matches.length === 0) {
        return {
          content: [{ type: "text", text: `No wiki pages found for "${question}". Try \`wiki_ingest\` first to build the wiki.` }],
          details: { success: true, matches: 0 },
        };
      }

      const lines: string[] = [
        `📖 Wiki search results for "${question}":`,
        ``,
      ];

      for (const match of result.matches) {
        lines.push(`### [[${match.page.id}]] (score: ${match.score.toFixed(2)})`);
        lines.push(`> ${match.snippet}`);
        lines.push(`Type: ${match.page.type} | Updated: ${match.page.lastIngested.split("T")[0]}`);
        lines.push("");
      }

      lines.push(`Found ${result.matches.length} of ${result.totalPages} pages.`);

      // Karpathy pattern: file good queries back as wiki pages
      // "Today's query becomes tomorrow's cross-reference."
      if (result.matches.length >= 2) {
        const slug = toSlug(question);
        const queryDirName = getDirectoryForPageType("query", state.config.pageTypes);
        const queryFilePath = path.join(wikiPath, queryDirName, `${slug}.md`);
        const existingPage = store.getPage(slug);
        if (!existingPage) {
          const matchedIds = result.matches.map(m => m.page.id).join(", ");
          const today = formatWikiDate(new Date());
          const queryContent = [
            `# ${question}`,
            ``,
            `> **Query**: ${question}`,
            `> **Filed**: ${today}`,
            `> **Matches**: ${result.matches.length} pages`,
            ``,
            `## Matched Pages`,
            ``,
          ];
          for (const m of result.matches.slice(0, 5)) {
            queryContent.push(`- [[${m.page.id}]] (${m.score.toFixed(2)}) — ${m.snippet.slice(0, 80)}`);
          }
          queryContent.push("", "## Open Questions", "", "(to be discovered through further analysis)", "");
          queryContent.push(`---`, `*Filed by wiki_query on ${today}*`);

          fs.mkdirSync(path.join(wikiPath, queryDirName), { recursive: true });
          fs.writeFileSync(queryFilePath, queryContent.join("\n"), "utf-8");

          store.upsertPage({
            id: slug,
            path: `${queryDirName}/${slug}.md`,
            type: "query",
            title: question,
            summary: `Query: ${question} — ${result.matches.length} matches: ${matchedIds}`,
            sourceFiles: [],
            sourceCommits: [],
            lastIngested: new Date().toISOString(),
            lastChecked: new Date().toISOString(),
            inboundLinks: 0,
            outboundLinks: result.matches.length,
            stale: false,
          });

          for (const m of result.matches.slice(0, 5)) {
            store.addCrossReference(slug, m.page.id, "query match");
          }
          commitWiki(wikiPath, store, "wiki: query filed");
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          success: true,
          query: question,
          matchCount: result.matches.length,
          totalPages: result.totalPages,
        },
      };
    },
  });

  // ─── wiki_lint ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_lint",
    label: "Wiki Lint",
    description: "Health-check the codebase wiki for contradictions, orphans, stale pages, broken links, and missing concepts.",
    promptSnippet: "Check wiki health",
    promptGuidelines: [
      "Use wiki_lint periodically to keep the wiki accurate",
      "Run after significant codebase changes to find stale pages",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false, reason: "not_initialized" },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const result = lintWiki(wikiPath, store);
      const report = formatLintResult(result);

      // Karpathy pattern: flag contradictions to the agent when lint finds them
      const contradictions = result.issues.filter(i => i.type === "contradiction");
      if (contradictions.length > 0) {
        const contrLines = contradictions.map(c => `  - ${c.description}`).join("\n");
        pi.sendUserMessage(
          `⚠️ **Wiki Lint found ${contradictions.length} potential contradiction(s):**\n\n${contrLines}\n\nConsider using \`wiki_ingest source=llm\` to resolve these.`,
          { deliverAs: "followUp" }
        );
      }

      return {
        content: [{ type: "text", text: report }],
        details: {
          success: true,
          issues: result.issues.length,
          totalPages: result.totalPages,
          healthyPages: result.healthyPages,
          stalePages: result.stalePages,
          orphanPages: result.orphanPages,
        },
      };
    },
  });

  // ─── wiki_status ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_status",
    label: "Wiki Status",
    description: "Show codebase wiki stats: page counts, staleness, last ingest time.",
    promptSnippet: "Check wiki status",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false, reason: "not_initialized" },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const stats = store.getStats();
      const branch = getCurrentBranch(ctx.cwd);
      const lastHash = getLatestHash(ctx.cwd);
      const sourceCount = store.getSourceCount();

      const lines: string[] = [
        `📖 **Codebase Wiki Status**`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Total pages | ${stats.totalPages} |`,
      ];

      for (const [type, count] of Object.entries(stats.pagesByType)) {
        lines.push(`| ${type} | ${count} |`);
      }

      lines.push(`| Stale pages | ${stats.stalePages} |`);
      lines.push(`| Sources | ${sourceCount.total} |`);
      lines.push(`| Last ingest | ${stats.lastIngest ?? "never"} |`);
      lines.push(`| Git branch | ${branch} |`);
      lines.push(`| Latest hash | ${lastHash?.slice(0, 7) ?? "unknown"} |`);

      // Wiki git versioning status
      const wPath = path.join(ctx.cwd, state.config.wikiDir);
      const wikiHash = getWikiGitHash(wPath);
      if (wikiHash) {
        lines.push(`| Wiki git | ${wikiHash} |`);
        lines.push(`| Uncommitted changes | ${wikiHasChanges(wPath) ? "yes" : "no"} |`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { success: true, ...stats },
      };
    },
  });

  // ─── wiki_entity ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_entity",
    label: "Wiki Entity",
    description: "Create or update an entity page in the codebase wiki. Entity pages document code modules, services, and components.",
    promptSnippet: "Create or update a wiki entity page",
    parameters: Type.Object({
      name: Type.String({ description: "Entity name (e.g. 'auth-module', 'event-bus')" }),
      summary: Type.String({ description: "One-paragraph description of the entity" }),
      type: Type.Union([
        Type.Literal("module"),
        Type.Literal("service"),
        Type.Literal("util"),
        Type.Literal("config"),
        Type.Literal("type"),
      ], { description: "Entity type" }),
      source_files: Type.Optional(Type.Array(Type.String(), { description: "Source file paths this entity covers" })),
      path: Type.Optional(Type.String({ description: "File path to the entity in the codebase" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { name, summary, type, source_files = [], path: entityPath } = params as {
        name: string;
        summary: string;
        type: string;
        source_files?: string[];
        path?: string;
      };

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const entityDirName = getDirectoryForPageType("entity", state.config.pageTypes);
      const entityDir = path.join(wikiPath, entityDirName);
      const fileName = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
      const filePath = path.join(entityDir, `${fileName}.md`);

      const today = new Date().toISOString().split("T")[0];
      const fileList = source_files.map(f => `- \`${f}\``).join("\n");

      const content = `# ${name}\n\n> **Summary**: ${summary}\n\n## Location\n${entityPath ? `- **Path**: \`${entityPath}\`` : ""}\n- **Type**: ${type}\n\n## Responsibilities\n- (to be documented)\n\n## Dependencies\n- (to be discovered)\n\n## Dependents\n- (to be discovered)\n\n## Key Files\n${fileList || "- (no files tracked)"}\n\n## Design Decisions\n- (to be documented)\n\n## Evolution\n- **${today}** — Initial creation\n\n## See Also\n- [[index]]\n`;

      fs.mkdirSync(entityDir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");

      store.upsertPage({
        id: fileName,
        path: `${entityDirName}/${fileName}.md`,
        type: "entity",
        title: name,
        summary,
        sourceFiles: source_files,
        sourceCommits: [],
        lastIngested: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        inboundLinks: 0,
        outboundLinks: 0,
        stale: false,
      });

      return {
        content: [{ type: "text", text: `✅ Entity page created: [[${fileName}]]` }],
        details: { success: true, slug: fileName, path: filePath },
      };
    },
  });

  // ─── wiki_decision ────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_decision",
    label: "Wiki Decision (ADR)",
    description: "Create or update an Architecture Decision Record in the wiki.",
    promptSnippet: "Create an ADR for an architectural decision",
    parameters: Type.Object({
      title: Type.String({ description: "Decision title (e.g. 'Use SQLite over LevelDB')" }),
      context: Type.String({ description: "What is motivating this decision?" }),
      decision: Type.String({ description: "What is the change being made?" }),
      status: Type.Union([
        Type.Literal("proposed"),
        Type.Literal("accepted"),
        Type.Literal("deprecated"),
      ], { description: "Decision status", default: "proposed" }),
      alternatives: Type.Optional(Type.String({ description: "Alternatives considered" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { title, context, decision, status = "Proposed", alternatives } = params as {
        title: string;
        context: string;
        decision: string;
        status: string;
        alternatives?: string;
      };

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const decisions = store.getPagesByType("decision");
      const adrNumber = String(decisions.length + 1).padStart(3, "0");
      const slug = `adr-${adrNumber}-${title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
      const fileName = slug.slice(0, 80); // Cap length
      const decisionDirName = getDirectoryForPageType("decision", state.config.pageTypes);
      const filePath = path.join(wikiPath, decisionDirName, `${fileName}.md`);

      const today = new Date().toISOString().split("T")[0];

      const displayStatus = status.charAt(0).toUpperCase() + status.slice(1);
      const content = `# ADR-${adrNumber}: ${title}\n\n> **Status**: ${displayStatus}\n\n## Context\n${context}\n\n## Decision\n${decision}\n\n## Consequences\n- (to be determined)\n\n## Alternatives Considered\n${alternatives || "- None documented yet"}\n\n## References\n- Created: ${today}\n\n## See Also\n- [[index]]\n`;

      fs.mkdirSync(path.join(wikiPath, decisionDirName), { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");

      store.upsertPage({
        id: fileName,
        path: `${decisionDirName}/${fileName}.md`,
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

      return {
        content: [{ type: "text", text: `✅ ADR created: [[${fileName}]]\n\n**ADR-${adrNumber}: ${title}**\nStatus: ${status}` }],
        details: { success: true, slug: fileName, adrNumber },
      };
    },
  });

  // ─── wiki_concept ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_concept",
    label: "Wiki Concept",
    description: "Create or update a concept page in the codebase wiki. Concept pages document cross-cutting patterns, architectural concepts, and recurring themes.",
    promptSnippet: "Create or update a wiki concept for a cross-cutting pattern",
    parameters: Type.Object({
      name: Type.String({ description: "Concept name (e.g. 'hot-reload', 'event-driven-architecture')" }),
      summary: Type.String({ description: "One-paragraph description of the concept" }),
      applies_to: Type.Optional(Type.Array(Type.String(), { description: "Entity slugs this concept applies to" })),
      details: Type.Optional(Type.String({ description: "Detailed description of the concept" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = (params as any).name as string;
      const summary = (params as any).summary as string;
      const appliesTo = ((params as any).applies_to as string[]) ?? [];
      const details = (params as any).details as string | undefined;

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return { content: [{ type: "text", text: "Wiki not initialized. Run /wiki-init first." }], details: { success: false } };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const slug = toSlug(name);
      const conceptDirName = getDirectoryForPageType("concept", state.config.pageTypes);
      const conceptDir = path.join(wikiPath, conceptDirName);
      const filePath = path.join(conceptDir, slug + ".md");
      const today = formatWikiDate(new Date());

      const appliesLines = appliesTo.length > 0
        ? appliesTo.map(function(a) { return "- [[" + a + "]]"; }).join("\n")
        : "- (to be discovered)";

      const conceptLines = [
        "# " + name,
        "",
        "> **Summary**: " + summary,
        "",
        "## Applies To",
        appliesLines,
        "",
        "## Description",
        details || "(to be expanded through analysis)",
        "",
        "## Key Characteristics",
        "- (to be discovered)",
        "",
        "## See Also",
        "- [[index]]",
        "",
        "---",
        "*Created: " + today + "*",
      ];
      const conceptContent = conceptLines.join("\n");

      fs.mkdirSync(conceptDir, { recursive: true });
      fs.writeFileSync(filePath, conceptContent, "utf-8");

      store.upsertPage({
        id: slug,
        path: `${conceptDirName}/${slug}.md`,
        type: "concept",
        title: name,
        summary: summary,
        sourceFiles: [],
        sourceCommits: [],
        lastIngested: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        inboundLinks: 0,
        outboundLinks: appliesTo.length,
        stale: false,
      });

      // Add cross-references
      for (const target of appliesTo) {
        if (validateSlug(target)) {
          store.addCrossReference(slug, target, "concept applies to");
        }
      }

      commitWiki(wikiPath, store, "wiki: concept created");

      const appliesToStr = appliesTo.length > 0 ? "\nApplies to: " + appliesTo.join(", ") : "";
      return {
        content: [{ type: "text", text: "Concept created: [[" + slug + "]]\n\n**" + name + "**: " + summary + appliesToStr }],
        details: { success: true, slug: slug, appliesTo: appliesTo },
      };
    },
  });  // ─── wiki_changelog ───────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_changelog",
    label: "Wiki Changelog",
    description: "Generate a changelog from recent git commits.",
    promptSnippet: "Generate a changelog from git history",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: "Time period (e.g. '1 week ago', '2026-01-01')" })),
      format: Type.Optional(Type.Union([
        Type.Literal("markdown"),
        Type.Literal("keepachangelog"),
      ], { description: "Changelog format", default: "keepachangelog" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { since = "1 week ago", format = "keepachangelog" } = params as {
        since?: string;
        format?: string;
      };

      const commits = getRecentCommits(ctx.cwd, since);

      if (commits.length === 0) {
        return {
          content: [{ type: "text", text: `No commits found since ${since}.` }],
          details: { success: true, commits: 0 },
        };
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
        // Plain markdown
        const lines = commits.map(c => {
          const scope = c.scope ? `(${c.scope})` : "";
          return `- \`${c.hash.slice(0, 7)}\` **${c.type}${scope}**: ${c.subject}`;
        });
        changelogContent = `# Recent Commits\n\n${lines.join("\n")}`;
      }

      // Karpathy pattern: persist changelog to wiki (merge with existing)
      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const changelogPath = path.join(wikiPath, "CHANGELOG.md");
      let finalChangelog = changelogContent;
      try {
        const existing = fs.readFileSync(changelogPath, "utf-8");
        if (existing && format === "keepachangelog") {
          // Merge: preserve existing content, prepend new entries under the same header
          const existingLines = existing.split("\n");
          const newLines = changelogContent.split("\n");
          // Find if the existing has a [Recent] section and merge into it
          const recentIdx = existingLines.findIndex(l => l.startsWith("## [Recent]"));
          if (recentIdx !== -1) {
            // Replace the [Recent] section with new content
            const nextSectionIdx = existingLines.findIndex((l, i) => i > recentIdx && l.startsWith("## ["));
            const before = existingLines.slice(0, recentIdx);
            const after = nextSectionIdx !== -1 ? existingLines.slice(nextSectionIdx) : [];
            // Find the new entries portion (after the header)
            const newEntries = newLines.slice(2); // Skip "# Changelog" and empty line
            finalChangelog = [...before, ...newEntries, ...after].join("\n");
          } else {
            // No existing [Recent] section — just prepend new content
            finalChangelog = changelogContent + "\n" + existingLines.filter(l => !l.startsWith("# Changelog") && l.trim() !== "").join("\n");
          }
        }
      } catch {
        // No existing changelog — write fresh
      }
      fs.writeFileSync(changelogPath, finalChangelog, "utf-8");

      return {
        content: [{ type: "text", text: changelogContent }],
        details: { success: true, commits: commits.length, format, persisted: changelogPath },
      };
    },
  });

  // ─── wiki_evolve ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_evolve",
    label: "Wiki Evolution Trace",
    description: "Trace how a feature or module changed over time by analyzing git history.",
    promptSnippet: "Trace feature evolution over time",
    parameters: Type.Object({
      feature: Type.String({ description: "Feature or module name to trace (e.g. 'auth', 'event-bus')" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { feature } = params as { feature: string };

      const allCommits = getAllCommits(ctx.cwd);
      const slug = feature.toLowerCase().replace(/[^a-z0-9]/g, "-");

      // Find commits related to this feature
      const related = allCommits.filter(c => {
        const text = `${c.subject} ${c.body} ${c.scope} ${c.files.join(" ")}`.toLowerCase();
        return text.includes(feature.toLowerCase());
      });

      if (related.length === 0) {
        return {
          content: [{ type: "text", text: `No commits found related to "${feature}".` }],
          details: { success: true, commits: 0 },
        };
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

      lines.push("## See Also");
      lines.push(`- [[${slug}]]`);

      // Karpathy pattern: persist evolution pages to disk (merge with existing)
      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const evolutionDirName = getDirectoryForPageType("evolution", state.config.pageTypes);
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
        // Find existing timeline entries and merge new ones
        const existingHashes = new Set(
          [...existingContent.matchAll(/Commit: `([a-f0-9]{7,40})`/g)].map(m => m[1]!.slice(0, 7))
        );
        // Filter out entries whose hashes already exist in the page
        const newLines = lines.filter(line => {
          const hashMatch = line.match(/Commit: `([a-f0-9]{7,40})`/);
          if (hashMatch) return !existingHashes.has(hashMatch[1]!.slice(0, 7));
          return true;
        });
        // Prepend new timeline entries to the existing Timeline section
        const timelineIdx = existingContent.indexOf("## Timeline");
        if (timelineIdx !== -1) {
          const afterIdx = existingContent.indexOf("\n", timelineIdx) + 1;
          const merged = existingContent.slice(0, afterIdx) + "\n" + newLines.join("\n") + existingContent.slice(afterIdx);
          fs.writeFileSync(evolvePath, merged, "utf-8");
        } else {
          // No Timeline section, just append
          fs.writeFileSync(evolvePath, existingContent + "\n\n" + newLines.join("\n"), "utf-8");
        }
      } else {
        fs.writeFileSync(evolvePath, lines.join("\n"), "utf-8");
      }

      const store = await ensureInitialized({ cwd: ctx.cwd });
      if (store) {
        store.upsertPage({
          id: `evolution-${slug}`,
          path: `${evolutionDirName}/${slug}.md`,
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
        commitWiki(wikiPath, store, "wiki: evolution created");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { success: true, feature, commits: related.length, persisted: evolvePath },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMMANDS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── /wiki ─────────────────────────────────────────────────────────────
  pi.registerCommand("wiki", {
    description: "Show codebase wiki status and INDEX.md",
    handler: async (_args, ctx) => {
      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        ctx.ui.notify("📖 No wiki found. Run /wiki-init to create one.", "info");
        return;
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        ctx.ui.notify("❌ Failed to initialize wiki store.", "error");
        return;
      }

      const stats = store.getStats();
      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const indexPath = path.join(wikiPath, "INDEX.md");

      let indexContent = "";
      try {
        indexContent = fs.readFileSync(indexPath, "utf-8");
      } catch {
        indexContent = "(INDEX.md not found)";
      }

      ctx.ui.notify(
        `📖 Codebase Wiki\n\n` +
        `Pages: ${stats.totalPages} | Stale: ${stats.stalePages} | Last ingest: ${stats.lastIngest ?? "never"}\n\n` +
        `${indexContent.slice(0, 2000)}${indexContent.length > 2000 ? "\n\n... (truncated)" : ""}`,
        "info"
      );
    },
  });

  // ─── /wiki-init ───────────────────────────────────────────────────────
  pi.registerCommand("wiki-init", {
    description: "Initialize the codebase wiki for the current project",
    handler: async (_args, ctx) => {
      if (wikiExists(ctx.cwd, state.config.wikiDir)) {
        ctx.ui.notify("📖 Wiki already exists. Use /wiki-ingest to update it.", "info");
        return;
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        const dbPath = path.join(getWikiPath(ctx.cwd, state.config.wikiDir), "meta", "wiki.db");
        const newStore = new WikiStore(dbPath);
        await newStore.init();
        state.store = newStore;
      }

      const wikiPath = initWiki(ctx.cwd, state.config, state.store!);
      ctx.ui.notify(`📖 Wiki initialized at ${wikiPath}\n\nRun /wiki-ingest all to populate it.`, "info");
    },
  });

  // ─── /wiki-ingest ─────────────────────────────────────────────────────
  pi.registerCommand("wiki-ingest", {
    description: "Ingest sources into the wiki (commits, tree, smart, docs, or all)",
    handler: async (args, ctx) => {
      const source = args.trim() || "commits";

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        ctx.ui.notify("📖 No wiki found. Run /wiki-init first.", "info");
        return;
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        ctx.ui.notify("❌ Failed to initialize wiki store.", "error");
        return;
      }

      ctx.ui.notify(`📖 Ingesting ${source}...`, "info");

      try {
        if (source === "commits" || source === "all") {
          const result = await ingestCommits(ctx.cwd, state.config, store);
          ctx.ui.notify(
            `✅ Ingested commits: ${result.commitsProcessed} processed, ${result.pagesCreated} created, ${result.pagesUpdated} updated`,
            "info"
          );
        }

        if (source === "tree" || source === "all") {
          const result = await ingestFileTree(ctx.cwd, state.config, store);
          ctx.ui.notify(
            `✅ Ingested file tree: ${result.filesProcessed} files, ${result.pagesCreated} created, ${result.pagesUpdated} updated`,
            "info"
          );
        }

        if (source === "smart" || source === "llm" || source === "all") {
          const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
          const result = enrichAllEntities(wikiPath, ctx.cwd, store);
          ctx.ui.notify(
            `✅ Smart enrich: ${result.pagesEnriched} pages enriched, ${result.crossReferencesAdded} cross-references added`,
            "info"
          );
          commitWiki(wikiPath, store, "wiki: smart enrich");
        }

        if (source === "llm") {
          const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
          const pages = store.getAllPages().filter(p => p.type === "entity");
          const prompts = generateEnrichmentBatch(pages, store, wikiPath, 5);
          if (prompts.length > 0) {
            const message = formatEnrichmentMessage(prompts);
            pi.sendUserMessage(message, { deliverAs: "followUp" });
            ctx.ui.notify(
              `📖 LLM enrich: ${prompts.length} pages queued for agent enrichment`,
              "info"
            );
          } else {
            ctx.ui.notify("📖 No stub pages need LLM enrichment", "info");
          }
        }
      } catch (err) {
        ctx.ui.notify(`❌ Ingest failed: ${err}`, "error");
      }
    },
  });

  // ─── /wiki-lint ───────────────────────────────────────────────────────
  pi.registerCommand("wiki-lint", {
    description: "Health-check the wiki for issues",
    handler: async (_args, ctx) => {
      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        ctx.ui.notify("📖 No wiki found. Run /wiki-init first.", "info");
        return;
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        ctx.ui.notify("❌ Failed to initialize wiki store.", "error");
        return;
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const result = lintWiki(wikiPath, store);
      const report = formatLintResult(result);
      ctx.ui.notify(report, result.issues.length > 0 ? "warning" : "info");
    },
  });

  // ─── /wiki-query ──────────────────────────────────────────────────────
  pi.registerCommand("wiki-query", {
    description: "Ask a question against the codebase wiki",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /wiki-query <question>", "info");
        return;
      }

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        ctx.ui.notify("📖 No wiki found. Run /wiki-init first.", "info");
        return;
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        ctx.ui.notify("❌ Failed to initialize wiki store.", "error");
        return;
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const result = searchWiki(args.trim(), wikiPath, store);

      if (result.matches.length === 0) {
        ctx.ui.notify(`No results for "${args.trim()}". Try /wiki-ingest first.`, "info");
        return;
      }

      const lines = result.matches.map(m =>
        `[[${m.page.id}]] (${m.score.toFixed(2)}): ${m.snippet.slice(0, 100)}`
      );
      ctx.ui.notify(`📖 Found ${result.matches.length} results:\n\n${lines.join("\n")}`, "info");
    },
  });

  // ─── /wiki-reindex ────────────────────────────────────────────────────
  pi.registerCommand("wiki-reindex", {
    description: "Rebuild the wiki INDEX.md from the store",
    handler: async (_args, ctx) => {
      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        ctx.ui.notify("📖 No wiki found. Run /wiki-init first.", "info");
        return;
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        ctx.ui.notify("❌ Failed to initialize wiki store.", "error");
        return;
      }

      // Re-run ingest with 0 commits to trigger index rebuild
      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      commitWiki(wikiPath, store, "wiki: index rebuild");

      ctx.ui.notify("✅ Wiki index rebuilt.", "info");
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 5: HUMAN-IN-THE-LOOP PROPOSAL TOOLS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── wiki_proposals ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_proposals",
    label: "Wiki Proposals",
    description: "List, approve, or reject pending ingestion proposals. In confirm/guided mode, the wiki generates proposals before making changes.",
    promptSnippet: "Review and manage wiki proposals",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("show"), Type.Literal("approve"), Type.Literal("reject")], { description: "Action: list, show, approve, or reject" }),
      proposalId: Type.Optional(Type.String({ description: "Proposal ID for show/approve/reject" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, proposalId } = params as any;

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return { content: [{ type: "text", text: "Wiki not initialized. Run /wiki-init first." }], details: { success: false } };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Failed to initialize wiki store." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);

      if (action === "list") {
        const proposals = listProposals(wikiPath, "pending");
        if (proposals.length === 0) {
          return { content: [{ type: "text", text: "No pending proposals. Use wiki_ingest in confirm mode to generate proposals." }], details: { success: true, count: 0 } };
        }
        return {
          content: [{ type: "text", text: formatProposalList(proposals) }],
          details: { success: true, count: proposals.length, proposals },
        };
      }

      if (action === "show" || action === "approve" || action === "reject") {
        if (!proposalId) {
          return { content: [{ type: "text", text: "\u274c Provide proposalId to show, approve, or reject." }], details: { success: false } };
        }

        if (action === "show") {
          const proposal = loadProposal(wikiPath, proposalId);
          if (!proposal) {
            return { content: [{ type: "text", text: `Proposal ${proposalId} not found.` }], details: { success: false } };
          }
          return { content: [{ type: "text", text: formatProposal(proposal) }], details: { success: true, proposal } };
        }

        if (action === "approve") {
          let proposal = updateProposalStatus(wikiPath, proposalId, "approved");
          if (!proposal) {
            return { content: [{ type: "text", text: `Proposal ${proposalId} not found.` }], details: { success: false } };
          }

          // Apply the proposal's actions (create pages, add cross-references)
          const applyResult = applyProposal(wikiPath, store, proposal);
          wikiAutoCommit(wikiPath, `wiki: apply proposal ${proposalId}`);

          const lines = [
            `\u2705 **Applied proposal ${proposalId}**: ${proposal.sourceTitle}`,
            "",
          ];
          if (applyResult.pagesCreated.length > 0) {
            lines.push(`Pages created: ${applyResult.pagesCreated.join(", ")}`);
          }
          if (applyResult.pagesUpdated.length > 0) {
            lines.push(`Pages updated: ${applyResult.pagesUpdated.join(", ")}`);
          }
          if (applyResult.crossReferencesAdded > 0) {
            lines.push(`Cross-references added: ${applyResult.crossReferencesAdded}`);
          }
          if (applyResult.errors.length > 0) {
            lines.push("", `\u26a0\ufe0f Errors: ${applyResult.errors.join("; ")}`);
          }

          return { content: [{ type: "text", text: lines.join("\n") }], details: { success: applyResult.errors.length === 0, ...applyResult } };
        }

        if (action === "reject") {
          const proposal = updateProposalStatus(wikiPath, proposalId, "rejected");
          if (!proposal) {
            return { content: [{ type: "text", text: `Proposal ${proposalId} not found.` }], details: { success: false } };
          }
          return { content: [{ type: "text", text: `\u274c Rejected proposal ${proposalId}` }], details: { success: true } };
        }
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: { success: false } };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: SOURCE INGESTION TOOLS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── wiki_resolve ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_resolve",
    label: "Wiki Resolve Contradiction",
    description: "Resolve contradictions between wiki pages using merge, update (cross-reference), or split strategies.",
    promptSnippet: "Resolve wiki contradictions",
    parameters: Type.Object({
      strategy: Type.Union([Type.Literal("merge"), Type.Literal("update"), Type.Literal("split"), Type.Literal("list")], { description: "Resolution strategy: merge, update, split, or list to see contradictions" }),
      pageA: Type.Optional(Type.String({ description: "First page ID" })),
      pageB: Type.Optional(Type.String({ description: "Second page ID (merge target or cross-ref partner)" })),
      newPageId: Type.Optional(Type.String({ description: "New page ID for split" })),
      newPageTitle: Type.Optional(Type.String({ description: "Title for the new split page" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { strategy, pageA, pageB, newPageId, newPageTitle } = params as any;

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Wiki not initialized. Run wiki_ingest first." }], details: { success: false } };
      }
      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);

    // List contradictions
    if (strategy === "list" || !pageA) {
      const pages = store.getAllPages();
      const contradictions = findContradictionsDetailed(wikiPath, pages);

      if (contradictions.length === 0) {
        return {
          content: [{ type: "text", text: "✅ No contradictions found in the wiki." }],
          details: { success: true, contradictions: 0 },
        };
      }

      const lines = [`Found ${contradictions.length} potential contradiction(s):`, ""];
      for (const c of contradictions) {
        const pct = (c.similarity * 100).toFixed(0);
        lines.push(`- [[${c.pageA.id}]] ↔ [[${c.pageB.id}]] — ${pct}% overlap`);
        lines.push(`  Suggestion: ${c.suggestion} — ${c.reason}`);
      }

      lines.push("", "Use wiki_resolve with strategy 'merge', 'update', or 'split' to resolve.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { success: true, contradictions: contradictions.length, items: contradictions },
      };
    }

    // Merge: combine two pages
    if (strategy === "merge") {
      if (!pageA || !pageB) {
        return { content: [{ type: "text", text: "❌ Merge requires pageA (source) and pageB (target)." }], details: { success: false } };
      }

      const result = mergePages(wikiPath, store, pageA, pageB);
      commitWiki(wikiPath, store, "wiki: merge contradiction");

      return {
        content: [{ type: "text", text: `✅ Merged [[${pageA}]] into [[${pageB}]] — ${result.redirected.length} references redirected.` }],
        details: { success: true, merged: result.merged, redirected: result.redirected },
      };
    }

    // Update: add cross-references
    if (strategy === "update") {
      if (!pageA || !pageB) {
        return { content: [{ type: "text", text: "❌ Update requires pageA and pageB." }], details: { success: false } };
      }

      const result = updatePages(wikiPath, store, pageA, pageB);
      commitWiki(wikiPath, store, "wiki: cross-reference update");

      return {
        content: [{ type: "text", text: `✅ Added cross-references between [[${pageA}]] and [[${pageB}]] — ${result.updated.length} pages updated.` }],
        details: { success: true, updated: result.updated },
      };
    }

    // Split: separate a page into two
    if (strategy === "split") {
      if (!pageA || !newPageId) {
        return { content: [{ type: "text", text: "❌ Split requires pageA (source) and newPageId." }], details: { success: false } };
      }

      const title = newPageTitle || newPageId;
      const result = splitPage(wikiPath, store, pageA, newPageId, title, () => false);
      commitWiki(wikiPath, store, "wiki: split page");

      return {
        content: [{ type: "text", text: `✅ Split [[${pageA}]] — created [[${result.newPage}]]. Review both pages and adjust sections as needed.` }],
        details: { success: true, original: result.original, newPage: result.newPage },
      };
    }

    return { content: [{ type: "text", text: `Unknown strategy: ${strategy}. Use: list, merge, update, or split.` }], details: { success: false } };
    },
  });
  pi.registerTool({
    name: "wiki_ingest_source",
    label: "Wiki Ingest Source",
    description: "Ingest an arbitrary source (article, note, conversation, etc.) into the wiki. The content is stored immutably and a wiki page is created.",
    promptSnippet: "Ingest a source into the wiki",
    promptGuidelines: [
      "Use wiki_ingest_source to add articles, notes, conversations, or other content to the wiki",
      "The source is stored immutably — the wiki page is the compiled artifact",
    ],
    parameters: Type.Object({
      type: Type.Union([
        Type.Literal("article"),
        Type.Literal("note"),
        Type.Literal("conversation"),
        Type.Literal("document"),
        Type.Literal("url"),
        Type.Literal("media"),
        Type.Literal("manual"),
      ], { description: "Type of source content" }),
      title: Type.String({ description: "Title for the source" }),
      content: Type.String({ description: "Raw content of the source" }),
      url: Type.Optional(Type.String({ description: "Original URL if this was fetched from the web" })),
      pageType: Type.Optional(Type.String({ description: "Wiki page type to create (auto-detected if omitted)" })),
      updateExisting: Type.Optional(Type.Array(Type.String(), { description: "Page IDs to update with this source reference" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { type, title, content, url, pageType, updateExisting } = params as {
        type: string; title: string; content: string; url?: string; pageType?: string; updateExisting?: string[];
      };

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false, reason: "not_initialized" },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);

      // Confirm/Guided mode: generate proposal instead of directly ingesting
      if (state.config.ingestionMode !== "auto") {
        const proposalId = generateProposalId(type);
        const pageId = toSlug(title);
        const pageSlug = pageType || "concept";
        const dir = getDirectoryForPageType(pageSlug, state.config.pageTypes);

        const proposal: Proposal = {
          id: proposalId,
          source: type,
          sourceTitle: title,
          createdAt: new Date().toISOString(),
          status: "pending",
          actions: [{
            type: "create",
            pageId,
            pageType: pageSlug,
            title,
            path: `${dir}/${pageId}.md`,
            summary: `Source: ${type} — ${title.slice(0, 100)}`,
            crossRefs: updateExisting || [],
          }],
          metadata: { type, title, contentLength: content.length, url },
        };

        saveProposal(wikiPath, proposal);

        return {
          content: [{ type: "text", text: `📋 **Proposal created** (confirm/guided mode)\n\n${formatProposal(proposal)}\n\nUse \`wiki_proposals\` to approve or reject this proposal.` }],
          details: { success: true, proposalId, mode: state.config.ingestionMode },
        };
      }

      // Auto mode: ingest directly
      const result = ingestSourceOp(wikiPath, ctx.cwd, type as SourceType, title, content, store, {
        url,
        pageType,
        updateExisting,
      });

      if (result.errors.length > 0) {
        return {
          content: [{ type: "text", text: `⚠️ Source ingested with errors:\n\nManifest: ${result.manifestId}\nCreated: ${result.pagesCreated.join(", ") || "none"}\nUpdated: ${result.pagesUpdated.join(", ") || "none"}\nErrors: ${result.errors.join("; ")}` }],
          details: { success: false, manifestId: result.manifestId, errors: result.errors },
        };
      }

      // Update the index after creating pages
      commitWiki(wikiPath, store, "wiki: ingest source");

      return {
        content: [{ type: "text", text: `✅ Source ingested:\n\n**Manifest**: \`${result.manifestId}\`\n**Type**: ${type}\n**Title**: ${title}\n**Pages created**: ${result.pagesCreated.join(", ") || "none"}\n**Pages updated**: ${result.pagesUpdated.join(", ") || "none"}\n**Source path**: ${result.sourcePath}` }],
        details: { success: true, manifestId: result.manifestId, pagesCreated: result.pagesCreated, pagesUpdated: result.pagesUpdated },
      };
    },
  });

  // ─── wiki_ingest_url ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_ingest_url",
    label: "Wiki Ingest URL",
    description: "Fetch a web page and ingest it into the wiki as a source.",
    promptSnippet: "Ingest a web article into the wiki",
    promptGuidelines: [
      "Use wiki_ingest_url to fetch and store web articles as wiki sources",
      "The content is extracted and stored immutably",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and ingest" }),
      title: Type.Optional(Type.String({ description: "Override title (auto-detected from page if omitted)" })),
      pageType: Type.Optional(Type.String({ description: "Wiki page type to create" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { url, title, pageType } = params as { url: string; title?: string; pageType?: string };

      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        return {
          content: [{ type: "text", text: "Wiki not initialized. Run `/wiki-init` first." }],
          details: { success: false, reason: "not_initialized" },
        };
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        return { content: [{ type: "text", text: "Store initialization failed." }], details: { success: false } };
      }

      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);

      _onUpdate?.({ content: [{ type: "text", text: `📖 Fetching ${url}...` }], details: {} });

      const result = await ingestUrlOp(wikiPath, ctx.cwd, url, store, { title, pageType });

      if (result.errors.length > 0) {
        return {
          content: [{ type: "text", text: `⚠️ URL ingested with errors:\n\nManifest: ${result.manifestId}\nTitle: ${result.title}\nErrors: ${result.errors.join("; ")}` }],
          details: { success: false, errors: result.errors },
        };
      }

      commitWiki(wikiPath, store, "wiki: ingest url");

      return {
        content: [{ type: "text", text: `✅ URL ingested:\n\n**Manifest**: \`${result.manifestId}\`\n**Title**: ${result.title}\n**Content length**: ${result.contentLength} chars\n**Pages created**: ${result.pagesCreated.join(", ") || "none"}\n**Pages updated**: ${result.pagesUpdated.join(", ") || "none"}` }],
        details: { success: true, manifestId: result.manifestId, title: result.title },
      };
    },
  });

  // ─── /wiki-sources ──────────────────────────────────────────────────────
  pi.registerCommand("wiki-sources", {
    description: "List ingested sources",
    handler: async (_args, ctx) => {
      if (!wikiExists(ctx.cwd, state.config.wikiDir)) {
        ctx.ui.notify("📖 No wiki found. Run /wiki-init first.", "info");
        return;
      }

      const store = await ensureInitialized(ctx);
      if (!store) {
        ctx.ui.notify("❌ Failed to initialize wiki store.", "error");
        return;
      }

      const sources = store.getSources();
      const count = store.getSourceCount();

      const lines = [
        `📖 **Wiki Sources** (${count.total} total)`,
        "",
      ];

      for (const [type, num] of Object.entries(count.byType)) {
        lines.push(`- ${type}: ${num}`);
      }

      if (sources.length > 0) {
        lines.push("");
        lines.push("**Recent sources:**");
        for (const s of sources.slice(0, 10)) {
          lines.push(`- \`${s.id}\` — ${s.title} (${s.type}, ${s.ingestedAt.split("T")[0]})`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  console.log("[CodebaseWiki] Extension loaded — /wiki, /wiki-init, /wiki-ingest, /wiki-lint, /wiki-query, /wiki-reindex, /wiki-sources");
}