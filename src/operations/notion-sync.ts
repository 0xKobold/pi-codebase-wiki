/**
 * Notion Sync — Export wiki pages to Notion databases.
 *
 * Creates per-project databases under a root page with Kanban-ready schema.
 * Uses Notion SDK v5 API (data sources for querying, search for discovering databases).
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "@notionhq/client";
import type { WikiPage, NotionSyncConfig } from "../shared.js";
import { markdownToBlocks } from "./notion-mapping.js";

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

// ─── NotionSyncer ───────────────────────────────────────────────

export class NotionSyncer {
  private client: Client;
  private config: NotionSyncConfig;
  private configPath: string;
  private dryRun: boolean;

  constructor(notionToken: string, config: NotionSyncConfig, configPath: string, dryRun = false) {
    this.client = new Client({ auth: notionToken });
    this.config = config;
    this.configPath = configPath;
    this.dryRun = dryRun;
  }

  async findOrCreateDatabase(): Promise<{ id: string; url: string; created: boolean }> {
    const rootId = this.config.rootPageId;

    // 1. Check existing database ID
    if (this.config.databaseId) {
      try {
        const existing = await this.client.databases.retrieve({ database_id: this.config.databaseId });
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
        this.config.databaseId = existing.id;
        this.saveConfig();
        return { id: existing.id, url: `https://notion.so/${existing.id.replace(/-/g, "")}`, created: false };
      }
    } catch { /* search might fail, fall through */ }

    if (this.dryRun) {
      return { id: "[dry-run]", url: "[dry-run]", created: true };
    }

    // 3. Create new database with initial_data_source (Notion API v5)
    const newDb = await this.client.databases.create({
      parent: { type: "page_id", page_id: rootId },
      title: [{ type: "text", text: { content: this.config.databaseName } }],
      initial_data_source: {
        properties: buildDatabaseProperties(),
      },
    } as any);

    this.config.databaseId = newDb.id;
    this.saveConfig();
    return { id: newDb.id, url: `https://notion.so/${newDb.id.replace(/-/g, "")}`, created: true };
  }

  async exportPages(pages: WikiPage[], pageContents: Map<string, string>, databaseId?: string): Promise<NotionSyncResult> {
    const db = await this.findOrCreateDatabase();
    const targetDbId = databaseId || db.id;
    const result: NotionSyncResult = { synced: 0, created: 0, updated: 0, skipped: 0, errors: [], databaseId: targetDbId, databaseUrl: db.url };

    for (const page of pages) {
      try {
        const content = pageContents.get(page.id) ?? "";
        const existingPageId = await this.findExistingPage(targetDbId, page);
        if (this.dryRun) { result.skipped++; continue; }

        if (existingPageId) {
          await this.updateNotionPage(existingPageId, page, content);
          result.updated++;
        } else {
          await this.createNotionPage(targetDbId, page, content);
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

  private async findExistingPage(databaseId: string, page: WikiPage): Promise<string | null> {
    // Use search API (works across API versions) to find pages in this database
    try {
      const response = await this.client.search({
        query: page.title,
        filter: { property: "object", value: "page" },
        page_size: 5,
      });
      // Find a page that belongs to our database and matches the title or wiki path
      for (const result of response.results) {
        if (!("properties" in result)) continue;
        const props = (result as any).properties;
        const titleText = props?.Name?.title?.[0]?.plain_text ?? props?.title?.title?.[0]?.plain_text;
        const wikiPath = props?.["Wiki Path"]?.url;
        if (titleText === page.title || wikiPath === page.id || wikiPath === page.path) {
          return result.id;
        }
      }
    } catch { /* search might fail for new databases */ }
    return null;
  }

  private async createNotionPage(databaseId: string, page: WikiPage, content: string): Promise<string> {
    const properties = this.buildNotionProperties(page);
    const blocks = markdownToBlocks(content);
    const response = await this.client.pages.create({
      parent: { type: "database_id", database_id: databaseId },
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
    return {
      Name: { title: [{ text: { content: page.title } }] },
      Type: { select: { name: typeLabel } },
      Status: { status: { name: page.stale ? "Stale" : "Active" } },
      Summary: { rich_text: [{ text: { content: (page.summary ?? "").slice(0, 2000) } }] },
      "Source Files": { rich_text: [{ text: { content: (page.sourceFiles ?? []).join(", ").slice(0, 2000) } }] },
      "Inbound Links": { number: page.inboundLinks ?? 0 },
      "Outbound Links": { number: page.outboundLinks ?? 0 },
      Stale: { checkbox: page.stale ?? false },
      "Last Synced": { date: { start: new Date().toISOString().split("T")[0] } },
      "Wiki Path": { url: page.path ?? page.id },
      "Ingest Status": { select: { name: this.mapIngestStatus(page) } },
      ...(page.metadata?.tags ? { Tags: { multi_select: (Array.isArray(page.metadata.tags) ? page.metadata.tags : [page.metadata.tags]).slice(0, 5).map((t: any) => ({ name: String(t).slice(0, 100) })) } } : {}),
      ...(page.metadata?.priority ? { Priority: { select: { name: String(page.metadata.priority) } } } : {}),
      ...(page.type === "decision" ? {
        ...(page.metadata?.status ? { "ADR Status": { select: { name: String(page.metadata.status) } } } : {}),
        ...(page.metadata?.decision ? { Decision: { rich_text: [{ text: { content: String(page.metadata.decision).slice(0, 2000) } }] } } : {}),
        ...(page.metadata?.alternatives ? { Alternatives: { rich_text: [{ text: { content: String(page.metadata.alternatives).slice(0, 2000) } }] } } : {}),
      } : {}),
    };
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

// ─── Database Schema ────────────────────────────────────────────

const STATUS_GROUPS = [
  { name: "Draft", color: "default" as const },
  { name: "Active", color: "green" as const },
  { name: "Stale", color: "yellow" as const },
  { name: "Archived", color: "gray" as const },
];

const PRIORITY_OPTIONS = [
  { name: "Critical", color: "red" as const },
  { name: "High", color: "orange" as const },
  { name: "Medium", color: "yellow" as const },
  { name: "Low", color: "gray" as const },
];

const INGEST_OPTIONS = [
  { name: "Unprocessed", color: "default" as const },
  { name: "Ingested", color: "green" as const },
  { name: "Needs Review", color: "yellow" as const },
  { name: "Stale", color: "red" as const },
];

const ADR_OPTIONS = [
  { name: "Proposed", color: "default" as const },
  { name: "Accepted", color: "green" as const },
  { name: "Deprecated", color: "yellow" as const },
  { name: "Superseded", color: "gray" as const },
];

export function buildDatabaseProperties(): Record<string, any> {
  return {
    Name: { title: {} },
    Type: { select: { options: Object.values(PAGE_TYPE_COLORS).map(({ name, color }) => ({ name, color })) } },
    Status: { status: { groups: STATUS_GROUPS.map(({ name, color }) => ({ name, color })) } },
    Summary: { rich_text: {} },
    "Source Files": { rich_text: {} },
    "Inbound Links": { number: { format: "number" } },
    "Outbound Links": { number: { format: "number" } },
    Stale: { checkbox: {} },
    "Last Synced": { date: {} },
    "Wiki Path": { url: {} },
    Tags: { multi_select: { options: [] } },
    Priority: { select: { options: PRIORITY_OPTIONS.map(({ name, color }) => ({ name, color })) } },
    "Ingest Status": { select: { options: INGEST_OPTIONS.map(({ name, color }) => ({ name, color })) } },
    "ADR Status": { select: { options: ADR_OPTIONS.map(({ name, color }) => ({ name, color })) } },
    Decision: { rich_text: {} },
    Alternatives: { rich_text: {} },
  };
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