/**
 * Notion database creation utility — v5 API compatible.
 * Uses initial_data_source for property schema and data_source_id for page creation.
 */

import { Client } from "@notionhq/client";
import type { PageTypeConfig } from "../shared.js";
import { buildDatabaseProperties } from "./notion-sync.js";

export interface CreateDatabaseResult {
  id: string;
  dataSourceId: string | null;
  url: string;
  created: boolean;
}

export async function findOrCreateDatabase(
  client: Client,
  rootPageId: string,
  databaseName: string,
  existingDatabaseId?: string | null,
  _pageTypes?: PageTypeConfig[]
): Promise<CreateDatabaseResult> {
  // 1. Check existing database ID
  if (existingDatabaseId) {
    try {
      const existing = await client.databases.retrieve({ database_id: existingDatabaseId });
      const ds = (existing as any).data_sources?.[0];
      return {
        id: existing.id,
        dataSourceId: ds?.id ?? null,
        url: `https://notion.so/${existing.id.replace(/-/g, "")}`,
        created: false,
      };
    } catch {
      // Database was deleted, fall through to create
    }
  }

  // 2. Search for existing database by name
  try {
    const searchResult = await client.search({
      query: databaseName,
      filter: { property: "object", value: "data_source" },
    });
    const existing = searchResult.results.find((obj: any) => {
      if (!("parent" in obj) || obj.parent.type !== "page_id") return false;
      return obj.parent.page_id === rootPageId;
    });
    if (existing) {
      const db = existing as any;
      return {
        id: db.id,
        dataSourceId: db.data_sources?.[0]?.id ?? null,
        url: `https://notion.so/${db.id.replace(/-/g, "")}`,
        created: false,
      };
    }
  } catch { /* search might fail, fall through */ }

  // 3. Create new database with initial_data_source (v5)
  const properties = buildDatabaseProperties();
  const newDb = await client.databases.create({
    parent: { type: "page_id", page_id: rootPageId },
    title: [{ type: "text", text: { content: databaseName } }],
    initial_data_source: { properties },
  } as any);

  const ds = (newDb as any).data_sources?.[0];
  return {
    id: newDb.id,
    dataSourceId: ds?.id ?? null,
    url: `https://notion.so/${newDb.id.replace(/-/g, "")}`,
    created: true,
  };
}