/**
 * Web server for wiki serve command.
 *
 * Serves a local web UI with page browser, search, and graph visualization.
 * Uses Bun's built-in HTTP server. No external dependencies.
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiConfig } from "../shared.js";
import { WikiStore } from "../core/store.js";
import { loadConfig, wikiExists, getWikiPath } from "../core/config.js";
import { searchWiki } from "../operations/query.js";
import { renderPage } from "./template.js";

export interface ServeOptions {
  port: number;
  open: boolean;
}

export async function serveWiki(rootDir: string, config: WikiConfig, options: ServeOptions): Promise<void> {
  if (!wikiExists(rootDir, config.wikiDir)) {
    console.error("❌ Wiki not initialized. Run `wiki init` first.");
    process.exit(1);
  }

  const wikiPath = getWikiPath(rootDir, config.wikiDir);
  const dbPath = path.join(wikiPath, "meta", "wiki.db");
  const store = new WikiStore(dbPath);
  await store.init();

  const server = Bun.serve({
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);

      // ─── API Routes ──────────────────────────────────────────────
      if (url.pathname.startsWith("/api/")) {
        return handleApi(url, wikiPath, store);
      }

      // ─── Static Files ────────────────────────────────────────────
      if (url.pathname.startsWith("/pages/")) {
        const filePath = path.join(wikiPath, url.pathname.slice(1));
        if (fs.existsSync(filePath)) {
          return new Response(new Uint8Array(fs.readFileSync(filePath)), {
            headers: { "Content-Type": getContentType(filePath) },
          });
        }
        return new Response("Not found", { status: 404 });
      }

      // ─── Index ───────────────────────────────────────────────────
      return new Response(renderPage(wikiPath, store, options.port), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  console.log(`\n📖 Wiki UI: http://localhost:${options.port}`);
  console.log("Press Ctrl+C to stop.\n");

  if (options.open) {
    try {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      Bun.spawn([cmd, `http://localhost:${options.port}`]);
    } catch {
      // Could not open browser, that's fine
    }
  }
}

function handleApi(url: URL, wikiPath: string, store: WikiStore): Response {
  const route = url.pathname;

  // GET /api/pages - list all pages
  if (route === "/api/pages") {
    const pages = store.getAllPages();
    const result = pages.map(p => ({
      id: p.id,
      title: p.title,
      type: p.type,
      summary: p.summary,
      lastIngested: p.lastIngested,
      stale: p.stale,
    }));
    return Response.json(result);
  }

  // GET /api/pages/:id - get page content
  const pageMatch = route.match(/^\/api\/pages\/(.+)$/);
  if (pageMatch) {
    const pageId = decodeURIComponent(pageMatch[1]);
    const page = store.getPage(pageId);
    if (!page) {
      return new Response(JSON.stringify({ error: "Page not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const filePath = path.join(wikiPath, page.path);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      content = `# ${page.title}\n\n> Page file not found.`;
    }
    // Get inbound and outbound links
    const inRefs = store.getInboundLinks(pageId);
    const outRefs = store.getOutboundLinks(pageId);
    return Response.json({
      ...page,
      content,
      inboundLinks: inRefs.length,
      outboundLinks: outRefs.length,
      linksTo: outRefs.map((r: any) => r.toPage),
      linkedFrom: inRefs.map((r: any) => r.fromPage),
    });
  }

  // GET /api/graph - graph data for visualization
  if (route === "/api/graph") {
    const pages = store.getAllPages();
    const allXrefs = store.getAllCrossReferences?.() ?? [];
    const nodes = pages.map(p => ({
      id: p.id,
      title: p.title,
      type: p.type,
      stale: p.stale,
    }));
    const edges = allXrefs.map((r: any) => ({
      from: r.fromPage,
      to: r.toPage,
      context: r.context,
    }));
    return Response.json({ nodes, edges });
  }

  // GET /api/search?q=... - search
  if (route === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    if (!q) return Response.json([]);
    const result = searchWiki(q, wikiPath, store, 10);
    return Response.json(result.matches.map(m => ({
      id: m.page.id,
      title: m.page.title,
      type: m.page.type,
      score: m.score,
      snippet: m.snippet,
    })));
  }

  // GET /api/stats - wiki stats
  if (route === "/api/stats") {
    return Response.json(store.getStats());
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath);
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  return types[ext] ?? "application/octet-stream";
}