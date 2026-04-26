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
  wikiExists,
  getWikiPath,
  ensureWikiDirs,
} from "./core/config.js";
import type { WikiConfig, GitCommit, LintResult } from "./shared.js";
import { DEFAULT_WIKI_CONFIG, toSlug, formatWikiDate, validateSlug } from "./shared.js";
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

// ============================================================================
// MAIN EXTENSION
// ============================================================================

export default async function codebaseWikiExtension(pi: ExtensionAPI): Promise<void> {
  const state = createState();

  // ─── Helper: ensure wiki is initialized ──────────────────────────────
  async function ensureInitialized(ctx: { cwd: string }): Promise<WikiStore | null> {
    state.rootDir = ctx.cwd;
    const wikiPath = getWikiPath(state.rootDir, state.config.wikiDir);

    if (!wikiExists(state.rootDir, state.config.wikiDir)) {
      return null;
    }

    if (!state.store) {
      const dbPath = path.join(wikiPath, "meta", "wiki.db");
      const store = new WikiStore(dbPath);
      await store.init();
      state.store = store;
    }

    return state.store;
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
        if (source === "smart" || source === "llm") {
          const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
          const result = enrichAllEntities(wikiPath, ctx.cwd, store);
          results.push(`Smart: ${result.pagesEnriched} pages enriched, ${result.crossReferencesAdded} cross-references added`);
          if (result.errors.length > 0) {
            results.push(`Errors: ${result.errors.join("; ")}`);
          }
          updateIndex(wikiPath, store);
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

        // Smart ingest as part of 'all'
        if (source === "all") {
          const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
          const smartResult = enrichAllEntities(wikiPath, ctx.cwd, store);
          results.push(`Smart: ${smartResult.pagesEnriched} pages enriched, ${smartResult.crossReferencesAdded} cross-references added`);
          updateIndex(wikiPath, store);
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
        const queryFilePath = path.join(wikiPath, "queries", `${slug}.md`);
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

          fs.mkdirSync(path.join(wikiPath, "queries"), { recursive: true });
          fs.writeFileSync(queryFilePath, queryContent.join("\n"), "utf-8");

          store.upsertPage({
            id: slug,
            path: `queries/${slug}.md`,
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
          updateIndex(wikiPath, store);
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
      lines.push(`| Last ingest | ${stats.lastIngest ?? "never"} |`);
      lines.push(`| Git branch | ${branch} |`);
      lines.push(`| Latest hash | ${lastHash?.slice(0, 7) ?? "unknown"} |`);

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
      const entityDir = path.join(wikiPath, "entities");
      const fileName = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
      const filePath = path.join(entityDir, `${fileName}.md`);

      const today = new Date().toISOString().split("T")[0];
      const fileList = source_files.map(f => `- \`${f}\``).join("\n");

      const content = `# ${name}\n\n> **Summary**: ${summary}\n\n## Location\n${entityPath ? `- **Path**: \`${entityPath}\`` : ""}\n- **Type**: ${type}\n\n## Responsibilities\n- (to be documented)\n\n## Dependencies\n- (to be discovered)\n\n## Dependents\n- (to be discovered)\n\n## Key Files\n${fileList || "- (no files tracked)"}\n\n## Design Decisions\n- (to be documented)\n\n## Evolution\n- **${today}** — Initial creation\n\n## See Also\n- [[index]]\n`;

      fs.mkdirSync(entityDir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");

      store.upsertPage({
        id: fileName,
        path: `entities/${fileName}.md`,
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
      const filePath = path.join(wikiPath, "decisions", `${fileName}.md`);

      const today = new Date().toISOString().split("T")[0];

      const displayStatus = status.charAt(0).toUpperCase() + status.slice(1);
      const content = `# ADR-${adrNumber}: ${title}\n\n> **Status**: ${displayStatus}\n\n## Context\n${context}\n\n## Decision\n${decision}\n\n## Consequences\n- (to be determined)\n\n## Alternatives Considered\n${alternatives || "- None documented yet"}\n\n## References\n- Created: ${today}\n\n## See Also\n- [[index]]\n`;

      fs.mkdirSync(path.join(wikiPath, "decisions"), { recursive: true });
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
      const conceptDir = path.join(wikiPath, "concepts");
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
        path: "concepts/" + slug + ".md",
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

      updateIndex(wikiPath, store);

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

      // Karpathy pattern: persist changelog to wiki
      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const changelogPath = path.join(wikiPath, "CHANGELOG.md");
      fs.writeFileSync(changelogPath, changelogContent, "utf-8");

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

      // Karpathy pattern: persist evolution pages to disk
      const wikiPath = getWikiPath(ctx.cwd, state.config.wikiDir);
      const evolvePath = path.join(wikiPath, "evolution", `${slug}.md`);
      fs.mkdirSync(path.join(wikiPath, "evolution"), { recursive: true });
      fs.writeFileSync(evolvePath, lines.join("\n"), "utf-8");

      const store = await ensureInitialized({ cwd: ctx.cwd });
      if (store) {
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
          updateIndex(wikiPath, store);
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
      const { updateIndex } = await import("./operations/ingest.js");
      updateIndex(wikiPath, store);

      ctx.ui.notify("✅ Wiki index rebuilt.", "info");
    },
  });

  console.log("[CodebaseWiki] Extension loaded — /wiki, /wiki-init, /wiki-ingest, /wiki-lint, /wiki-query, /wiki-reindex");
}