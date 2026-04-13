/**
 * Web UI template — reads the HTML file and injects dynamic stats.
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiStore } from "../core/store.js";

export function renderPage(wikiPath: string, store: WikiStore, port: number): string {
  const stats = store.getStats();
  const htmlPath = path.join(__dirname, "ui.html");
  let html: string;
  try {
    html = fs.readFileSync(htmlPath, "utf-8");
  } catch {
    // Fallback: try src path (development)
    const srcPath = path.join(__dirname, "..", "web", "ui.html");
    html = fs.readFileSync(srcPath, "utf-8");
  }

  // Inject stats into the header
  html = html.replace(
    'id="stats"></div>',
    `id="stats">${stats.totalPages} pages · ${stats.stalePages} stale</div>`
  );

  return html;
}