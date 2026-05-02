/**
 * Resolve Module — Contradiction resolution strategies for the wiki.
 *
 * Provides three resolution strategies:
 * - merge: Combine two pages into one, redirect the other
 * - update: Keep both, add cross-reference notes
 * - split: Separate a merged page into two focused pages
 */

import * as fs from "fs";
import * as path from "path";
import type { WikiStore } from "../core/store.js";
import type { ResolutionStrategy, ContradictionIssue } from "../shared.js";

// ============================================================================
// SUGGEST RESOLUTION
// ============================================================================

/**
 * Suggest a resolution strategy for a contradiction.
 *
 * Rules:
 * - Same type + high overlap → merge
 * - Same type + moderate overlap → update
 * - Different type + overlap → update (cross-ref)
 * - Very long page → split candidate
 */
export function suggestResolution(
  pageA: { id: string; type: string },
  pageB: { id: string; type: string },
  similarity: number
): { strategy: ResolutionStrategy; reason: string } {
  console.assert(typeof pageA === "object", "pageA must be object");
  console.assert(typeof pageB === "object", "pageB must be object");

  const sameType = pageA.type === pageB.type;

  if (sameType && similarity > 0.75) {
    return {
      strategy: "merge",
      reason: `Same type "${pageA.type}" with ${(similarity * 100).toFixed(0)}% overlap — likely duplicates`,
    };
  }

  if (sameType && similarity > 0.4) {
    return {
      strategy: "update",
      reason: `Same type "${pageA.type}" with moderate overlap — add cross-references`,
    };
  }

  if (!sameType && similarity > 0.3) {
    return {
      strategy: "update",
      reason: `Different types with overlap — cross-reference recommended`,
    };
  }

  return {
    strategy: "update",
    reason: `Low overlap — add cross-references to clarify distinction`,
  };
}

// ============================================================================
// MERGE RESOLUTION
// ============================================================================

/**
 * Merge two pages: combine content into target, redirect source.
 *
 * - Concatenates unique sections from both pages
 * - Updates cross-references pointing to source → target
 * - Deletes source page and its file
 * - Logs the merge operation
 */
export function mergePages(
  wikiPath: string,
  store: WikiStore,
  sourceId: string,
  targetId: string
): { merged: string; redirected: string[] } {
  console.assert(typeof sourceId === "string", "sourceId must be string");
  console.assert(typeof targetId === "string", "targetId must be string");
  console.assert(sourceId !== targetId, "source and target must be different");

  const sourcePage = store.getPage(sourceId);
  const targetPage = store.getPage(targetId);

  if (!sourcePage) throw new Error(`Source page "${sourceId}" not found`);
  if (!targetPage) throw new Error(`Target page "${targetId}" not found`);

  // Read both page contents
  const sourcePath = path.join(wikiPath, sourcePage.path);
  const targetPath = path.join(wikiPath, targetPage.path);
  const sourceContent = fs.readFileSync(sourcePath, "utf-8");
  const targetContent = fs.readFileSync(targetPath, "utf-8");

  // Merge: append unique sections from source to target
  const merged = mergeContent(targetContent, sourceContent, targetId, sourceId);
  fs.writeFileSync(targetPath, merged, "utf-8");

  // Update all pages that reference the source to point to the target instead
  const allPages = store.getAllPages();
  const redirected: string[] = [];

  for (const page of allPages) {
    if (page.id === targetId || page.id === sourceId) continue;

    const pagePath = path.join(wikiPath, page.path);
    if (!fs.existsSync(pagePath)) continue;

    let content = fs.readFileSync(pagePath, "utf-8");
    const updated = content.replace(
      new RegExp(`\\[\\[${sourceId}\\]\\]`, "g"),
      `[[${targetId}]]`
    );

    if (updated !== content) {
      fs.writeFileSync(pagePath, updated, "utf-8");
      redirected.push(page.id);
    }
  }

  // Add cross-reference from target to source (redirect note)
  const redirectNote = `\n> **Merged**: This page now includes content from [[${sourceId}]] (merged on ${new Date().toISOString().split("T")[0]}).\n`;

  const finalTarget = fs.readFileSync(targetPath, "utf-8");
  if (!finalTarget.includes(`[[${sourceId}]]`)) {
    fs.writeFileSync(targetPath, finalTarget + redirectNote, "utf-8");
  }

  // Remove source page from store
  store.deletePage(sourceId);

  // Delete source file
  if (fs.existsSync(sourcePath)) {
    fs.unlinkSync(sourcePath);
  }

  // Update target page metadata
  store.upsertPage({
    ...targetPage,
    lastChecked: new Date().toISOString(),
  });

  // Remove old cross-reference and add merged reference
  store.removeCrossReference(sourceId, targetId);
  store.removeCrossReference(targetId, sourceId);

  return { merged: targetId, redirected };
}

/**
 * Merge content from two wiki pages.
 * Appends unique sections from source to target.
 */
function mergeContent(
  targetContent: string,
  sourceContent: string,
  targetId: string,
  sourceId: string
): string {
  // Extract sections from both pages
  const targetSections = extractSections(targetContent);
  const sourceSections = extractSections(sourceContent);

  const merged = [...targetContent];

  // Find sections in source that aren't in target
  const targetSectionTitles = new Set(targetSections.map(s => s.title.toLowerCase()));
  const uniqueSourceSections = sourceSections.filter(
    s => !targetSectionTitles.has(s.title.toLowerCase())
  );

  // Append unique source sections
  let result = targetContent.trimEnd();

  if (uniqueSourceSections.length > 0) {
    result += `\n\n---\n\n> **Content merged from** [[${sourceId}]]\n\n`;
    for (const section of uniqueSourceSections) {
      result += section.content + "\n\n";
    }
  }

  return result;
}

// ============================================================================
// UPDATE RESOLUTION (cross-references)
// ============================================================================

/**
 * Update resolution: add cross-reference notes to both pages.
 *
 * Both pages remain, each gets a note pointing to the other.
 */
export function updatePages(
  wikiPath: string,
  store: WikiStore,
  pageAId: string,
  pageBId: string
): { updated: string[] } {
  console.assert(typeof pageAId === "string", "pageAId must be string");
  console.assert(typeof pageBId === "string", "pageBId must be string");

  const pageA = store.getPage(pageAId);
  const pageB = store.getPage(pageBId);

  if (!pageA) throw new Error(`Page "${pageAId}" not found`);
  if (!pageB) throw new Error(`Page "${pageBId}" not found`);

  const updated: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  // Add cross-reference note to page A
  const pathA = path.join(wikiPath, pageA.path);
  if (fs.existsSync(pathA)) {
    let content = fs.readFileSync(pathA, "utf-8");
    const noteA = `\n> **Related**: This topic overlaps with [[${pageBId}]]. See that page for details. (${today})\n`;
    if (!content.includes(`[[${pageBId}]]`)) {
      content = content.trimEnd() + noteA;
      fs.writeFileSync(pathA, content, "utf-8");
      updated.push(pageAId);
    }
  }

  // Add cross-reference note to page B
  const pathB = path.join(wikiPath, pageB.path);
  if (fs.existsSync(pathB)) {
    let content = fs.readFileSync(pathB, "utf-8");
    const noteB = `\n> **Related**: This topic overlaps with [[${pageAId}]]. See that page for details. (${today})\n`;
    if (!content.includes(`[[${pageAId}]]`)) {
      content = content.trimEnd() + noteB;
      fs.writeFileSync(pathB, content, "utf-8");
      updated.push(pageBId);
    }
  }

  // Add cross-references in the store
  store.addCrossReference(pageAId, pageBId, "overlap");
  store.addCrossReference(pageBId, pageAId, "overlap");

  return { updated };
}

// ============================================================================
// SPLIT RESOLUTION
// ============================================================================

/**
 * Split a page into two focused pages.
 *
 * Creates two new pages, distributes content sections,
 * and adds cross-references between them.
 */
export function splitPage(
  wikiPath: string,
  store: WikiStore,
  sourceId: string,
  newPageId: string,
  newPageTitle: string,
  sectionFilter: (sectionTitle: string) => boolean
): { original: string; newPage: string } {
  console.assert(typeof sourceId === "string", "sourceId must be string");
  console.assert(typeof newPageId === "string", "newPageId must be string");

  const sourcePage = store.getPage(sourceId);
  if (!sourcePage) throw new Error(`Source page "${sourceId}" not found`);

  const sourcePath = path.join(wikiPath, sourcePage.path);
  const sourceContent = fs.readFileSync(sourcePath, "utf-8");

  // Extract all sections
  const allSections = extractSections(sourceContent);

  // Split sections based on filter
  const keepSections = allSections.filter(s => !sectionFilter(s.title));
  const moveSections = allSections.filter(s => sectionFilter(s.title));

  // Rebuild original page (keeping sections)
  const keepContent = reconstructFromSections(sourceContent, keepSections, sourceId);

  // Build new page (moved sections)
  const moveContent = buildNewPage(sourcePage.title, newPageTitle, moveSections, sourceId);

  // Write original page
  fs.writeFileSync(sourcePath, keepContent, "utf-8");

  // Write new page
  const newPath = path.join(wikiPath, sourcePage.path.replace(sourceId, newPageId));
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, moveContent, "utf-8");

  // Add new page to store
  store.upsertPage({
    id: newPageId,
    path: sourcePage.path.replace(sourceId, newPageId),
    type: sourcePage.type,
    title: newPageTitle,
    summary: `Split from [[${sourceId}]]`,
    sourceFiles: sourcePage.sourceFiles,
    sourceCommits: sourcePage.sourceCommits,
    lastIngested: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    inboundLinks: 1,
    outboundLinks: 1,
    stale: false,
  });

  // Add cross-references
  store.addCrossReference(sourceId, newPageId, "split");
  store.addCrossReference(newPageId, sourceId, "split");

  // Update original page summary if it has one
  store.upsertPage({
    ...sourcePage,
    lastChecked: new Date().toISOString(),
  });

  return { original: sourceId, newPage: newPageId };
}

// ============================================================================
// HELPERS
// ============================================================================

interface Section {
  title: string;
  content: string;
  level: number;
}

/**
 * Extract sections (## headings) from markdown content.
 */
function extractSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentTitle = "";
  let currentContent: string[] = [];
  let currentLevel = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      // Save previous section
      if (currentTitle || currentContent.length > 0) {
        sections.push({
          title: currentTitle,
          content: currentContent.join("\n"),
          level: currentLevel,
        });
      }
      currentLevel = headingMatch[1]!.length;
      currentTitle = headingMatch[2]!.trim();
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentTitle || currentContent.length > 0) {
    sections.push({
      title: currentTitle,
      content: currentContent.join("\n"),
      level: currentLevel,
    });
  }

  return sections.filter(s => s.title || s.content.trim().length > 0);
}

/**
 * Reconstruct a page from a subset of sections.
 */
function reconstructFromSections(
  originalContent: string,
  sections: Section[],
  pageId: string
): string {
  if (sections.length === 0) {
    return originalContent.split("\n")[0] + `\n\n> Content moved to related page. See cross-references.\n`;
  }

  // Keep the first line (title) from original
  const titleLine = originalContent.split("\n")[0]!;
  const bodySections = sections.map(s => s.content.trim()).filter(Boolean);

  return titleLine + "\n\n" + bodySections.join("\n\n") + "\n";
}

/**
 * Build a new page from moved sections.
 */
function buildNewPage(
  originalTitle: string,
  newTitle: string,
  sections: Section[],
  sourceId: string
): string {
  const bodySections = sections.map(s => s.content.trim()).filter(Boolean);

  return [
    `# ${newTitle}`,
    "",
    `> **Split from** [[${sourceId}]]`,
    "",
    ...bodySections,
    "",
    "## See Also",
    "",
    `- [[${sourceId}]] — the original page this was split from`,
    "",
  ].join("\n");
}