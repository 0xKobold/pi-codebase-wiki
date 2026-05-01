/**
 * Wiki Store Module - SQLite metadata for wiki pages, cross-references, and ingest logs
 *
 * Uses sql.js (WASM SQLite) for cross-runtime compatibility (Bun + Node).
 * Follows NASA-10: small functions, validation, no globals, fixed allocations.
 */

import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type {
  WikiPage,
  IngestLog,
  CrossReference,
  StalenessCheck,
  PageType,
  SourceManifest,
  SourceType,
} from "../shared.js";
import { generateId } from "../shared.js";

// ============================================================================
// TYPES
// ============================================================================

type IngestSourceType = "commit" | "file" | "docs" | "manual" | "full-tree";

// ============================================================================
// STORE CLASS
// ============================================================================

export class WikiStore {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DELAY_MS = 500;

  constructor(dbPath: string) {
    console.assert(typeof dbPath === "string", "dbPath must be string");
    console.assert(dbPath.length > 0, "dbPath must not be empty");
    this.dbPath = dbPath;
  }

  /**
   * Initialize the database. Loads existing or creates new.
   * sql.js WASM binary is located automatically via the package.
   * Also registers a process exit handler to ensure data is saved.
   */
  async init(): Promise<void> {
    console.assert(this.db === null, "db should not be initialized twice");

    // sql.js auto-locates its WASM binary from node_modules
    const SQL = await initSqlJs();
    console.assert(SQL !== null, "SQL.js initialization failed");

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      console.assert(buffer.length > 0, "database file is empty");
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
      console.assert(this.db !== null, "failed to create new database");
      this.createTables();
    }

    this.runMigrations();

    // Ensure data is saved on process exit to prevent data loss
    const self = this;
    const exitHandler = () => {
      if (self.db) {
        self.save();
      }
    };
    process.on("exit", exitHandler);
    process.on("SIGINT", exitHandler);
    process.on("SIGTERM", exitHandler);
  }

  private createTables(): void {
    console.assert(this.db !== null, "db must be initialized");

    this.db!.run(`
      CREATE TABLE IF NOT EXISTS wiki_pages (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT DEFAULT '',
        source_files TEXT DEFAULT '[]',
        source_commits TEXT DEFAULT '[]',
        source_ids TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        last_ingested TEXT NOT NULL,
        last_checked TEXT NOT NULL,
        inbound_links INTEGER DEFAULT 0,
        outbound_links INTEGER DEFAULT 0,
        stale INTEGER DEFAULT 0
      );
    `);

    this.db!.run(`
      CREATE TABLE IF NOT EXISTS ingest_log (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        pages_created INTEGER DEFAULT 0,
        pages_updated INTEGER DEFAULT 0,
        timestamp TEXT NOT NULL
      );
    `);

    this.db!.run(`
      CREATE TABLE IF NOT EXISTS cross_references (
        from_page TEXT NOT NULL,
        to_page TEXT NOT NULL,
        context TEXT DEFAULT '',
        PRIMARY KEY (from_page, to_page)
      );
    `);

    this.db!.run(`
      CREATE TABLE IF NOT EXISTS staleness_checks (
        page_id TEXT PRIMARY KEY,
        check_time TEXT NOT NULL,
        stale_files TEXT DEFAULT '[]',
        staleness_score REAL DEFAULT 0.0
      );
    `);

    // Indexes for common queries
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_pages_type ON wiki_pages(type)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_pages_stale ON wiki_pages(stale)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_ingest_timestamp ON ingest_log(timestamp)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_crossref_from ON cross_references(from_page)");
    // source_manifests table + indexes created in runMigrations() for backward compat
  }

  private runMigrations(): void {
    // v0.7: Add source_ids and metadata columns to wiki_pages
    try {
      this.db!.run("ALTER TABLE wiki_pages ADD COLUMN source_ids TEXT DEFAULT '[]'");
    } catch { /* column already exists */ }
    try {
      this.db!.run("ALTER TABLE wiki_pages ADD COLUMN metadata TEXT DEFAULT '{}'");
    } catch { /* column already exists */ }

    // v0.7: Add source_manifests table
    try {
      this.db!.run(`
        CREATE TABLE IF NOT EXISTS source_manifests (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          path TEXT NOT NULL,
          hash TEXT NOT NULL,
          ingested_at TEXT NOT NULL,
          pages_created TEXT DEFAULT '[]',
          metadata TEXT DEFAULT '{}'
        )
      `);
      this.db!.run("CREATE INDEX IF NOT EXISTS idx_sources_type ON source_manifests(type)");
      this.db!.run("CREATE INDEX IF NOT EXISTS idx_sources_ingested ON source_manifests(ingested_at)");
    } catch { /* table already exists */ }
  }

  // ============================================================================
  // PERSISTENCE
  // ============================================================================

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.save(), WikiStore.SAVE_DELAY_MS);
  }

  save(): void {
    console.assert(this.db !== null, "db must be initialized for save");

    const data = this.db!.export();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.dbPath, new Uint8Array(data));
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
    // Remove exit handlers to prevent double-save
    process.removeAllListeners("exit");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }

  // ============================================================================
  // PAGE CRUD
  // ============================================================================

  upsertPage(page: WikiPage): void {
    console.assert(page !== null, "page must not be null");
    // Gracefully skip invalid slugs instead of crashing
    if (!validateSlug(page.id)) return;

    this.db!.run(
      `INSERT INTO wiki_pages (id, path, type, title, summary, source_files, source_commits,
        source_ids, metadata, last_ingested, last_checked, inbound_links, outbound_links, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        path=excluded.path, type=excluded.type, title=excluded.title, summary=excluded.summary,
        source_files=excluded.source_files, source_commits=excluded.source_commits,
        source_ids=excluded.source_ids, metadata=excluded.metadata,
        last_ingested=excluded.last_ingested, last_checked=excluded.last_checked,
        inbound_links=excluded.inbound_links, outbound_links=excluded.outbound_links, stale=excluded.stale`,
      [
        page.id,
        page.path,
        page.type,
        page.title,
        page.summary ?? "",
        JSON.stringify(page.sourceFiles ?? []),
        JSON.stringify(page.sourceCommits ?? []),
        JSON.stringify(page.sourceIds ?? []),
        JSON.stringify(page.metadata ?? {}),
        page.lastIngested,
        page.lastChecked,
        page.inboundLinks ?? 0,
        page.outboundLinks ?? 0,
        page.stale ? 1 : 0,
      ]
    );
    this.scheduleSave();
  }

  // Explicit column list for wiki_pages — avoids column-ordering bugs with migrations.
  // ALTER TABLE ADD COLUMN appends columns at the end, so SELECT * would return
  // different column order on fresh vs migrated databases. Always use explicit columns.
  private static readonly PAGE_COLUMNS = [
    "id", "path", "type", "title", "summary", "source_files", "source_commits",
    "source_ids", "metadata", "last_ingested", "last_checked",
    "inbound_links", "outbound_links", "stale"
  ].join(", ");

  getPage(id: string): WikiPage | null {
    console.assert(typeof id === "string", "id must be string");

    const result = this.db!.exec(
      `SELECT ${WikiStore.PAGE_COLUMNS} FROM wiki_pages WHERE id = ?`, [id]
    );
    if (result.length === 0 || result[0]!.values.length === 0) return null;

    return rowToPage(result[0]!.values[0]!);
  }

  getPageByPath(path: string): WikiPage | null {
    console.assert(typeof path === "string", "path must be string");

    const result = this.db!.exec(
      `SELECT ${WikiStore.PAGE_COLUMNS} FROM wiki_pages WHERE path = ?`, [path]
    );
    if (result.length === 0 || result[0]!.values.length === 0) return null;

    return rowToPage(result[0]!.values[0]!);
  }

  getAllPages(): WikiPage[] {
    const result = this.db!.exec(
      `SELECT ${WikiStore.PAGE_COLUMNS} FROM wiki_pages ORDER BY title`
    );
    if (result.length === 0) return [];
    return result[0]!.values.map(row => rowToPage(row));
  }

  getPagesByType(type: PageType): WikiPage[] {
    const result = this.db!.exec(
      `SELECT ${WikiStore.PAGE_COLUMNS} FROM wiki_pages WHERE type = ? ORDER BY title`,
      [type]
    );
    if (result.length === 0) return [];
    return result[0]!.values.map(row => rowToPage(row));
  }

  getStalePages(): WikiPage[] {
    const result = this.db!.exec(
      `SELECT ${WikiStore.PAGE_COLUMNS} FROM wiki_pages WHERE stale = 1 ORDER BY last_ingested ASC`
    );
    if (result.length === 0) return [];
    return result[0]!.values.map(row => rowToPage(row));
  }

  getOrphanPages(): WikiPage[] {
    const result = this.db!.exec(
      `SELECT ${WikiStore.PAGE_COLUMNS} FROM wiki_pages
       WHERE inbound_links = 0
       AND type NOT IN ('index', 'schema', 'changelog')`
    );
    if (result.length === 0) return [];
    return result[0]!.values.map(row => rowToPage(row));
  }

  deletePage(id: string): void {
    console.assert(typeof id === "string", "id must be string");

    this.db!.run("DELETE FROM cross_references WHERE from_page = ? OR to_page = ?", [id, id]);
    this.db!.run("DELETE FROM staleness_checks WHERE page_id = ?", [id]);
    this.db!.run("DELETE FROM wiki_pages WHERE id = ?", [id]);
    this.scheduleSave();
  }

  // ============================================================================
  // CROSS-REFERENCES
  // ============================================================================

  addCrossReference(fromPage: string, toPage: string, context: string): void {
    // Gracefully skip invalid slugs instead of asserting
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(fromPage)) return;
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(toPage)) return;

    this.db!.run(
      `INSERT INTO cross_references (from_page, to_page, context)
       VALUES (?, ?, ?)
       ON CONFLICT(from_page, to_page) DO UPDATE SET context=excluded.context`,
      [fromPage, toPage, context]
    );
    this.scheduleSave();
  }

  removeCrossReference(fromPage: string, toPage: string): void {
    this.db!.run(
      "DELETE FROM cross_references WHERE from_page = ? AND to_page = ?",
      [fromPage, toPage]
    );
    this.scheduleSave();
  }

  getOutboundLinks(pageId: string): CrossReference[] {
    const result = this.db!.exec(
      "SELECT * FROM cross_references WHERE from_page = ?",
      [pageId]
    );
    if (result.length === 0) return [];
    return result[0]!.values.map(row => ({
      fromPage: row[0] as string,
      toPage: row[1] as string,
      context: row[2] as string,
    }));
  }

  getInboundLinks(pageId: string): CrossReference[] {
    const result = this.db!.exec(
      "SELECT * FROM cross_references WHERE to_page = ?",
      [pageId]
    );
    if (result.length === 0) return [];
    return result[0]!.values.map(row => ({
      fromPage: row[0] as string,
      toPage: row[1] as string,
      context: row[2] as string,
    }));
  }

  getCrossReferences(pageId: string): CrossReference[] {
    return this.getOutboundLinks(pageId);
  }

  getAllCrossReferences(): CrossReference[] {
    const result = this.db!.exec("SELECT * FROM cross_references");
    if (result.length === 0) return [];
    return result[0]!.values.map(row => ({
      fromPage: row[0] as string,
      toPage: row[1] as string,
      context: row[2] as string,
    }));
  }

  // ============================================================================
  // INGEST LOG
  // ============================================================================

  logIngest(entry: Omit<IngestLog, "id">): string {
    console.assert(entry !== null, "entry must not be null");

    const id = generateId("ingest_");
    this.db!.run(
      `INSERT INTO ingest_log (id, source_type, source_ref, pages_created, pages_updated, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, entry.sourceType, entry.sourceRef, entry.pagesCreated, entry.pagesUpdated, entry.timestamp]
    );
    this.scheduleSave();
    return id;
  }

  getLastIngest(): IngestLog | null {
    const result = this.db!.exec(
      "SELECT * FROM ingest_log ORDER BY timestamp DESC LIMIT 1"
    );
    if (result.length === 0 || result[0]!.values.length === 0) return null;

    return rowToIngestLog(result[0]!.values[0]!);
  }

  getIngestHistory(limit: number = 20): IngestLog[] {
    console.assert(limit > 0, "limit must be positive");

    const result = this.db!.exec(
      "SELECT * FROM ingest_log ORDER BY timestamp DESC LIMIT ?",
      [limit]
    );
    if (result.length === 0) return [];
    return result[0]!.values.map(row => rowToIngestLog(row));
  }

  // ============================================================================
  // STALENESS
  // ============================================================================

  upsertStalenessCheck(check: StalenessCheck): void {
    this.db!.run(
      `INSERT INTO staleness_checks (page_id, check_time, stale_files, staleness_score)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET
        check_time=excluded.check_time, stale_files=excluded.stale_files,
        staleness_score=excluded.staleness_score`,
      [check.pageId, check.checkTime, JSON.stringify(check.staleFiles), check.stalenessScore]
    );
    this.scheduleSave();
  }

  getStalenessCheck(pageId: string): StalenessCheck | null {
    const result = this.db!.exec(
      "SELECT * FROM staleness_checks WHERE page_id = ?",
      [pageId]
    );
    if (result.length === 0 || result[0]!.values.length === 0) return null;

    const row = result[0]!.values[0]!;
    return {
      pageId: row[0] as string,
      checkTime: row[1] as string,
      staleFiles: JSON.parse(row[2] as string || "[]"),
      stalenessScore: row[3] as number,
    };
  }

  // ============================================================================
  // SOURCE MANIFESTS
  // ============================================================================

  addSource(manifest: SourceManifest): void {
    console.assert(manifest !== null, "manifest must not be null");
    console.assert(manifest.id.length > 0, "manifest id must not be empty");

    this.db!.run(
      `INSERT INTO source_manifests (id, type, title, path, hash, ingested_at, pages_created, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        type=excluded.type, title=excluded.title, path=excluded.path,
        hash=excluded.hash, pages_created=excluded.pages_created, metadata=excluded.metadata`,
      [
        manifest.id,
        manifest.type,
        manifest.title,
        manifest.path,
        manifest.hash,
        manifest.ingestedAt,
        JSON.stringify(manifest.pagesCreated),
        JSON.stringify(manifest.metadata),
      ]
    );
    this.scheduleSave();
  }

  getSource(id: string): SourceManifest | null {
    console.assert(typeof id === "string", "id must be string");

    const result = this.db!.exec("SELECT * FROM source_manifests WHERE id = ?", [id]);
    if (result.length === 0 || result[0]!.values.length === 0) return null;

    return rowToSourceManifest(result[0]!.values[0]!);
  }

  getSources(type?: string): SourceManifest[] {
    let sql = "SELECT * FROM source_manifests ORDER BY ingested_at DESC";
    let params: any[] = [];

    if (type) {
      sql = "SELECT * FROM source_manifests WHERE type = ? ORDER BY ingested_at DESC";
      params = [type];
    }

    const result = this.db!.exec(sql, params);
    if (result.length === 0) return [];
    return result[0]!.values.map(row => rowToSourceManifest(row));
  }

  getSourceCount(): { total: number; byType: Record<string, number> } {
    const totalResult = this.db!.exec("SELECT COUNT(*) FROM source_manifests");
    const total = totalResult.length > 0 ? (totalResult[0]!.values[0]![0] as number) : 0;

    const typeResult = this.db!.exec("SELECT type, COUNT(*) FROM source_manifests GROUP BY type");
    const byType: Record<string, number> = {};
    if (typeResult.length > 0) {
      for (const row of typeResult[0]!.values) {
        byType[row[0] as string] = row[1] as number;
      }
    }

    return { total, byType };
  }

  // ============================================================================
  // STATS
  // ============================================================================

  getStats(): { totalPages: number; pagesByType: Record<string, number>; stalePages: number; lastIngest: string | null } {
    const totalResult = this.db!.exec("SELECT COUNT(*) FROM wiki_pages");
    const totalPages = totalResult.length > 0 ? (totalResult[0]!.values[0]![0] as number) : 0;

    const typeResult = this.db!.exec("SELECT type, COUNT(*) FROM wiki_pages GROUP BY type");
    const pagesByType: Record<string, number> = {};
    if (typeResult.length > 0) {
      for (const row of typeResult[0]!.values) {
        pagesByType[row[0] as string] = row[1] as number;
      }
    }

    const staleResult = this.db!.exec("SELECT COUNT(*) FROM wiki_pages WHERE stale = 1");
    const stalePages = staleResult.length > 0 ? (staleResult[0]!.values[0]![0] as number) : 0;

    const lastIngest = this.getLastIngest();

    return {
      totalPages,
      pagesByType,
      stalePages,
      lastIngest: lastIngest?.timestamp ?? null,
    };
  }
}

// ============================================================================
// ROW PARSERS (pure functions)
// ============================================================================

function validateSlug(slug: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug);
}

function rowToPage(row: (string | number | null | Uint8Array)[]): WikiPage {
  return {
    id: row[0] as string,
    path: row[1] as string,
    type: row[2] as string,
    title: row[3] as string,
    summary: (row[4] as string) ?? "",
    sourceFiles: JSON.parse((row[5] as string) || "[]"),
    sourceCommits: JSON.parse((row[6] as string) || "[]"),
    sourceIds: JSON.parse((row[7] as string) || "[]"),
    metadata: JSON.parse((row[8] as string) || "{}"),
    lastIngested: row[9] as string,
    lastChecked: row[10] as string,
    inboundLinks: (row[11] as number) ?? 0,
    outboundLinks: (row[12] as number) ?? 0,
    stale: (row[13] as number) === 1,
  };
}

function rowToIngestLog(row: (string | number | null | Uint8Array)[]): IngestLog {
  return {
    id: row[0] as string,
    sourceType: row[1] as IngestSourceType,
    sourceRef: row[2] as string,
    pagesCreated: row[3] as number,
    pagesUpdated: row[4] as number,
    timestamp: row[5] as string,
  };
}

function rowToSourceManifest(row: (string | number | null | Uint8Array)[]): SourceManifest {
  return {
    id: row[0] as string,
    type: row[1] as SourceType,
    title: row[2] as string,
    path: row[3] as string,
    hash: row[4] as string,
    ingestedAt: row[5] as string,
    pagesCreated: JSON.parse((row[6] as string) || "[]"),
    metadata: JSON.parse((row[7] as string) || "{}"),
  };
}