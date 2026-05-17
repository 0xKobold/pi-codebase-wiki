/**
 * Notion database creation utilities.
 *
 * Uses Notion SDK v5 which uses data_source_id for queries.
 * Falls back to top-level search API for database discovery.
 */

import { Client } from "@notionhq/client";
import type { PageTypeConfig } from "../shared.js";
import { buildDatabaseProperties } from "./notion-sync.js";

export interface CreateDatabaseResult {
  id: string;
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
  // 1. Check existing database ID first
  if (existingDatabaseId) {
    try {
      const existing = await client.databases.retrieve({ database_id: existingDatabaseId });
      return {
        id: existing.id,
        url: `https://notion.so/${existing.id.replace(/-/g, "")}`,
        created: false,
      };
    } catch {
      // Database no longer exists, fall through to create
    }
  }

  // 2. Search for existing database using top-level search
  try {
    const searchResult = await client.search({
      query: databaseName,
      filter: { property: "object", value: "data_source" },
    });

    const existing = searchResult.results.find((obj: any) => {
      if (!("parent" in obj) || obj.parent.type !== "page_id") return false;
      return (obj.parent as { page_id: string }).page_id === rootPageId;
    });

    if (existing) {
      const db = existing as { id: string };
      return {
        id: db.id,
        url: `https://notion.so/${db.id.replace(/-/g, "")}`,
        created: false,
      };
    }
  } catch {
    // Search might fail, fall through to create
  }

    // 3. Create new database with Kanban-ready properties
  const properties = buildDatabaseProperties();

  const newDb = await client.databases.create({
    parent: { type: "page_id", page_id: rootPageId },
    title: [{ type: "text", text: { content: databaseName } }],
    properties,
  } as any);

  return {
    id: newDb.id,
    url: `https://notion.so/${newDb.id.replace(/-/g, "")}`,
    created: true,
  };
}