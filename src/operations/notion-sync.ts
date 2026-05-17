/**
 * Notion Sync — Export wiki pages to Notion databases.
 *
 * Uses Notion API v5 which splits databases from data sources.
 * Pages are created under data_source_id, not database_id.
 * Status properties use `select` type (not `status`) for simpler API compatibility
 * while still enabling Kanban board views.
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "@notionhq/client";
import type { WikiPage, NotionSyncConfig } from "../shared.js";
import { markdownToBlocks } from "./notion-mapping.js";

// ─── Fetch polyfill ─────────────────────────────────────────────────────────
// Notion SDK uses globalThis.fetch. If unavailable (older Node, custom runtimes),
// fall back to built-in https module. We also accept an explicit fetch override.

// ─── Types ─────────────────────────────────────────────────────

export interface NotionSyncResult {
  synced: number;
  created: number;
  updated: number;
  skipped: number;
  errors: NotionSyncError[];
  databaseId: string;
  databaseUrl: string;
}

export interface NotionSyncError {
  pageId: string;
  error: string;
}

// ─── Constants ──────────────────────────────────────────────────

const RATE_LIMIT_MS = 350;

const PAGE_TYPE_COLORS: Record<string, { name: string; color: string }> = {
  entity: { name: "Entity", color: "blue" },
  concept: { name: "Concept", color: "purple" },
  decision: { name: "Decision", color: "orange" },
  evolution: { name: "Evolution", color: "green" },
  comparison: { name: "Comparison", color: "pink" },
  query: { name: "Query", color: "gray" },
};

const DEFAULT_NOTION_CONFIG: NotionSyncConfig = {
  version: 1,
  rootPageId: "",
  databaseId: null,
  databaseName: "",
  syncDirection: "export",
  conflictResolution: "wiki-wins",
  pageTypes: {
    entity: { notionIcon: "📦", notionStatus: "Active" },
    concept: { notionIcon: "💡", notionStatus: "Active" },
    decision: { notionIcon: "⚖️", notionStatus: "Proposed" },
    evolution: { notionIcon: "📈", notionStatus: "Active" },
    comparison: { notionIcon: "📊", notionStatus: "Active" },
  },
  fieldMapping: {
    summary: "Summary",
    sourceFiles: "Source Files",
    stale: "Stale",
    inboundLinks: "Inbound Links",
    outboundLinks: "Outbound Links",
  },
  lastSyncAt: null,
  lastSyncHash: null,
  pagesSynced: 0,
  pagesCreated: 0,
  pagesUpdated: 0,
};

// ─── Database Schema (v5: properties go in initial_data_source) ──

export function buildDatabaseProperties(): Record<string, any> {
  return {
    Name: { title: {} },
    Type: { select: { options: Object.values(PAGE_TYPE_COLORS).map(({ name, color }) => ({ name, color })) } },
    // Use select instead of status for simpler API compatibility
    // Select still enables Kanban board views in Notion
    Status: { select: { options: [
      { name: "Draft", color: "default" },
      { name: "Active", color: "green" },
      { name: "Stale", color: "yellow" },
      { name: "Archived", color: "gray" },
    ] } },
    Summary: { rich_text: {} },
    "Source Files": { rich_text: {} },
    "Inbound Links": { number: { format: "number" } },
    "Outbound Links": { number: { format: "number" } },
    Stale: { checkbox: {} },
    "Last Synced": { date: {} },
    "Wiki Path": { url: {} },
    Tags: { multi_select: { options: [] } },
    Priority: { select: { options: [
      { name: "Critical", color: "red" },
      { name: "High", color: "orange" },
      { name: "Medium", color: "yellow" },
      { name: "Low", color: "gray" },
    ] } },
    "Ingest Status": { select: { options: [
      { name: "Unprocessed", color: "default" },
      { name: "Ingested", color: "green" },
      { name: "Needs Review", color: "yellow" },
      { name: "Stale", color: "red" },
    ] } },
    "ADR Status": { select: { options: [
      { name: "Proposed", color: "default" },
      { name: "Accepted", color: "green" },
      { name: "Deprecated", color: "yellow" },
      { name: "Superseded", color: "gray" },
    ] } },
    Decision: { rich_text: {} },
    Alternatives: { rich_text: {} },
  };
}

// ─── NotionSyncer ───────────────────────────────────────────────

export class NotionSyncer {
  private client: Client;
  private config: NotionSyncConfig;
  private configPath: string;
  private dryRun: boolean;
  private dataSourceId: string | null = null;

  constructor(notionToken: string, config: NotionSyncConfig, configPath: string, dryRun = false) {
    // Ensure fetch is available for the Notion SDK
    // Pi extension context may not have globalThis.fetch in all cases
    const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
    const clientOptions: Record<string, any> = { auth: notionToken };
    if (fetchFn) clientOptions.fetch = fetchFn;
    this.client = new Client(clientOptions as any);
    this.config = config;
    this.configPath = configPath;
    this.dryRun = dryRun;
  }

  async findOrCreateDatabase(): Promise<{ id: string; url: string; created: boolean }> {
    const rootId = this.config.rootPageId;

    // Quick connectivity test — fail fast with a clear message if the token is bad
    try {
      await this.client.search({ query: "", page_size: 1 });
    } catch (err: any) {
      throw new Error(`Notion API connection failed: ${err.message || err}. Check NOTION_API_TOKEN.`);
    }

    // 1. Check existing database ID — also get the data_source_id
    if (this.config.databaseId) {
      try {
        const existing = await this.client.databases.retrieve({ database_id: this.config.databaseId });
        // v5: get data_source_id from data_sources array
        const ds = (existing as any).data_sources?.[0];
        if (ds) this.dataSourceId = ds.id;
        return {
          id: existing.id,
          url: `https://notion.so/${existing.id.replace(/-/g, "")}`,
          created: false,
        };
      } catch {
        // Database was deleted, recreate
      }
    }

    // 2. Search for existing database by name
    try {
      const searchResult = await this.client.search({
        query: this.config.databaseName,
        filter: { property: "object", value: "data_source" },
      });
      const existing = searchResult.results.find((obj: any) => {
        if (!("parent" in obj) || obj.parent.type !== "page_id") return false;
        return obj.parent.page_id === rootId;
      });
      if (existing) {
        const db = existing as any;
        this.config.databaseId = db.id;
        // Try to get data_source_id
        try {
          const full = await this.client.databases.retrieve({ database_id: db.id });
          const ds = (full as any).data_sources?.[0];
          if (ds) this.dataSourceId = ds.id;
        } catch { /* ignore */ }
        this.saveConfig();
        return { id: db.id, url: `https://notion.so/${db.id.replace(/-/g, "")}`, created: false };
      }
    } catch { /* search might fail, fall through */ }

    if (this.dryRun) {
      return { id: "[dry-run]", url: "[dry-run]", created: true };
    }

    // 3. Create new database with initial_data_source (v5 API)
    const newDb = await this.client.databases.create({
      parent: { type: "page_id", page_id: rootId },
      title: [{ type: "text", text: { content: this.config.databaseName } }],
      initial_data_source: {
        properties: buildDatabaseProperties(),
      },
    } as any);

    this.config.databaseId = newDb.id;
    // Get the data_source_id from the response
    const ds = (newDb as any).data_sources?.[0];
    if (ds) this.dataSourceId = ds.id;
    this.saveConfig();

    return { id: newDb.id, url: `https://notion.so/${newDb.id.replace(/-/g, "")}`, created: true };
  }

  async exportPages(pages: WikiPage[], pageContents: Map<string, string>, databaseId?: string): Promise<NotionSyncResult> {
    const db = await this.findOrCreateDatabase();
    const targetDbId = databaseId || db.id;
    const result: NotionSyncResult = { synced: 0, created: 0, updated: 0, skipped: 0, errors: [], databaseId: targetDbId, databaseUrl: db.url };

    // If we don't have a data_source_id yet, try to get it
    if (!this.dataSourceId && this.config.databaseId) {
      try {
        const dbInfo = await this.client.databases.retrieve({ database_id: this.config.databaseId });
        const ds = (dbInfo as any).data_sources?.[0];
        if (ds) this.dataSourceId = ds.id;
      } catch { /* ignore */ }
    }

    for (const page of pages) {
      try {
        const content = pageContents.get(page.id) ?? "";
        const existingPageId = await this.findExistingPage(page);
        if (this.dryRun) { result.skipped++; continue; }

        if (existingPageId) {
          await this.updateNotionPage(existingPageId, page, content);
          result.updated++;
        } else {
          await this.createNotionPage(page, content);
          result.created++;
        }
        result.synced++;
        await this.rateLimitDelay();
      } catch (error) {
        result.errors.push({ pageId: page.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    this.config.lastSyncAt = new Date().toISOString();
    this.config.pagesSynced += result.synced;
    this.config.pagesCreated += result.created;
    this.config.pagesUpdated += result.updated;
    this.saveConfig();
    return result;
  }

  private async findExistingPage(page: WikiPage): Promise<string | null> {
    try {
      const response = await this.client.search({
        query: page.title,
        filter: { property: "object", value: "page" },
        page_size: 10,
      });
      for (const result of response.results) {
        if (!("properties" in result)) continue;
        const props = (result as any).properties;
        const titleText = props?.Name?.title?.[0]?.plain_text;
        const wikiPath = props?.["Wiki Path"]?.url;
        if (titleText === page.title || wikiPath === page.id || wikiPath === page.path) {
          return result.id;
        }
      }
    } catch { /* search might fail for new databases */ }
    return null;
  }

  private async createNotionPage(page: WikiPage, content: string): Promise<string> {
    const properties = this.buildNotionProperties(page);
    const blocks = markdownToBlocks(content);

    // v5: use data_source_id if available, fallback to database_id
    const parent = this.dataSourceId
      ? { data_source_id: this.dataSourceId }
      : { type: "database_id", database_id: this.config.databaseId! };

    const response = await this.client.pages.create({
      parent,
      properties,
      children: blocks as any[],
    } as any);
    return response.id;
  }

  private async updateNotionPage(pageId: string, page: WikiPage, content: string): Promise<void> {
    await this.client.pages.update({ page_id: pageId, properties: this.buildNotionProperties(page) as any });

    // Delete old blocks
    const existing = await this.client.blocks.children.list({ block_id: pageId, page_size: 100 });
    for (const block of existing.results) {
      await this.client.blocks.delete({ block_id: block.id });
      await this.rateLimitDelay();
    }

    // Append new content
    if (content.trim()) {
      const blocks = markdownToBlocks(content);
      for (let i = 0; i < blocks.length; i += 100) {
        await this.client.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) as any[] } as any);
        await this.rateLimitDelay();
      }
    }
  }

  private buildNotionProperties(page: WikiPage): Record<string, any> {
    const typeLabel = PAGE_TYPE_COLORS[page.type]?.name ?? page.type;
    const ingestStatus = this.mapIngestStatus(page);

    const props: Record<string, any> = {
      Name: { title: [{ text: { content: page.title } }] },
      Type: { select: { name: typeLabel } },
      // Use select instead of status for API compatibility
      Status: { select: { name: page.stale ? "Stale" : "Active" } },
      Summary: { rich_text: [{ text: { content: (page.summary ?? "").slice(0, 2000) } }] },
      "Source Files": { rich_text: [{ text: { content: (page.sourceFiles ?? []).join(", ").slice(0, 2000) } }] },
      "Inbound Links": { number: page.inboundLinks ?? 0 },
      "Outbound Links": { number: page.outboundLinks ?? 0 },
      Stale: { checkbox: page.stale ?? false },
      "Last Synced": { date: { start: new Date().toISOString().split("T")[0] } },
      "Wiki Path": { url: page.path ?? page.id },
      "Ingest Status": { select: { name: ingestStatus } },
    };

    if (page.metadata?.tags) {
      const tags = Array.isArray(page.metadata.tags) ? page.metadata.tags : [page.metadata.tags];
      props.Tags = { multi_select: tags.slice(0, 5).map((tag: any) => ({ name: String(tag).slice(0, 100) })) };
    }
    if (page.metadata?.priority) {
      props.Priority = { select: { name: String(page.metadata.priority) } };
    }
    if (page.type === "decision") {
      if (page.metadata?.status) props["ADR Status"] = { select: { name: String(page.metadata.status) } };
      if (page.metadata?.decision) props.Decision = { rich_text: [{ text: { content: String(page.metadata.decision).slice(0, 2000) } }] };
      if (page.metadata?.alternatives) props.Alternatives = { rich_text: [{ text: { content: String(page.metadata.alternatives).slice(0, 2000) } }] };
    }
    return props;
  }

  private mapIngestStatus(page: WikiPage): string {
    if (page.stale) return "Stale";
    if (page.inboundLinks === 0 && page.type !== "entity") return "Needs Review";
    if (page.lastIngested) return "Ingested";
    return "Unprocessed";
  }

  private saveConfig() {
    if (this.dryRun) return;
    saveSyncConfig(this.configPath, this.config);
  }

  private async rateLimitDelay() {
    return new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS));
  }
}

// ─── Config Helpers ─────────────────────────────────────────────

export function loadSyncConfig(configPath: string): NotionSyncConfig {
  if (fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return { ...DEFAULT_NOTION_CONFIG, ...raw };
  }
  return { ...DEFAULT_NOTION_CONFIG };
}

export function saveSyncConfig(configPath: string, config: NotionSyncConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}