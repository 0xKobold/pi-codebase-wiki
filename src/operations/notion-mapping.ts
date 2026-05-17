/**
 * Markdown → Notion block conversion.
 *
 * Parses wiki markdown into Notion API block objects.
 * Handles headings, code blocks, lists, blockquotes, tables,
 * inline formatting (bold, italic, code), and wikilinks.
 *
 * Respects the 2000-char limit per rich_text block by splitting
 * long paragraphs and table cells.
 */

// ─── Types ─────────────────────────────────────────────────────

export interface NotionBlock {
  object: "block";
  type: string;
  [key: string]: unknown;
}

export interface RichTextSegment {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
  };
}

// ─── Constants ──────────────────────────────────────────────────

const RICH_TEXT_LIMIT = 2000;

const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  sql: "sql",
  json: "json",
  html: "html",
  css: "css",
  tsx: "typescript",
  jsx: "javascript",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "c++",
  cs: "c sharp",
  php: "php",
  r: "r",
  scala: "scala",
  dart: "dart",
  lua: "lua",
  perl: "perl",
  dockerfile: "docker",
  makefile: "make",
  toml: "toml",
  xml: "xml",
  diff: "diff",
};

// ─── Main Converter ─────────────────────────────────────────────

export function markdownToBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.split("\n");
  const blocks: NotionBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line || line.trim() === "") {
      i++;
      continue;
    }

    // Frontmatter — skip until closing ---
    if (line.trim() === "---" && i === 0) {
      i++;
      while (i < lines.length && lines[i]?.trim() !== "---") {
        i++;
      }
      i++; // skip closing ---
      continue;
    }

    // Code blocks
    if (line.startsWith("```")) {
      const result = parseCodeBlock(lines, i);
      blocks.push(result.block);
      i = result.nextIndex;
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      blocks.push(makeHeading(3, line.slice(4)));
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(makeHeading(2, line.slice(3)));
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(makeHeading(1, line.slice(2)));
      i++;
      continue;
    }

    // Blockquotes
    if (line.startsWith("> ")) {
      const result = parseBlockquote(lines, i);
      blocks.push(result.block);
      i = result.nextIndex;
      continue;
    }

    // Unordered lists
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const result = parseUnorderedList(lines, i);
      for (const item of result.items) {
        blocks.push(item);
      }
      i = result.nextIndex;
      continue;
    }

    // Ordered lists
    if (/^\d+\.\s/.test(line)) {
      const result = parseOrderedList(lines, i);
      for (const item of result.items) {
        blocks.push(item);
      }
      i = result.nextIndex;
      continue;
    }

    // Horizontal rules
    if (line.trim() === "---" || line.trim() === "***" || line.trim() === "____") {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    // Table detection
    if (line.includes("|") && line.trim().startsWith("|")) {
      const result = parseTable(lines, i);
      blocks.push(result.block);
      i = result.nextIndex;
      continue;
    }

    // Regular paragraph — collect until next block element
    const result = parseParagraph(lines, i);
    blocks.push(result.block);
    i = result.nextIndex;
  }

  return blocks;
}

// ─── Parsers ────────────────────────────────────────────────────

function parseCodeBlock(
  lines: string[],
  startIndex: number
): { block: NotionBlock; nextIndex: number } {
  const language = lines[startIndex]?.slice(3).trim() || "plain text";
  const codeLines: string[] = [];
  let i = startIndex + 1;

  while (i < lines.length && lines[i] !== "```") {
    codeLines.push(lines[i] ?? "");
    i++;
  }
  i++; // skip closing ```

  const code = codeLines.join("\n");

  // Split into 2000-char chunks if needed
  const chunks = splitIntoChunks(code, RICH_TEXT_LIMIT);

  return {
    block: {
      object: "block",
      type: "code",
      code: {
        rich_text: chunks.map((chunk) => ({ text: { content: chunk } })),
        language: mapLanguage(language),
      },
    },
    nextIndex: i,
  };
}

function parseBlockquote(
  lines: string[],
  startIndex: number
): { block: NotionBlock; nextIndex: number } {
  const quoteLines: string[] = [];
  let i = startIndex;

  while (i < lines.length && lines[i]?.startsWith("> ")) {
    quoteLines.push(lines[i]!.slice(2));
    i++;
  }

  const text = quoteLines.join("\n").slice(0, RICH_TEXT_LIMIT);

  return {
    block: {
      object: "block",
      type: "quote",
      quote: {
        rich_text: [{ text: { content: text } }],
      },
    },
    nextIndex: i,
  };
}

function parseUnorderedList(
  lines: string[],
  startIndex: number
): { items: NotionBlock[]; nextIndex: number } {
  const items: NotionBlock[] = [];
  let i = startIndex;

  while (i < lines.length && (lines[i]?.startsWith("- ") || lines[i]?.startsWith("* "))) {
    const text = lines[i]!.replace(/^[-*] /, "");
    items.push({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: parseInlineMarkdown(text),
      },
    });
    i++;
  }

  return { items, nextIndex: i };
}

function parseOrderedList(
  lines: string[],
  startIndex: number
): { items: NotionBlock[]; nextIndex: number } {
  const items: NotionBlock[] = [];
  let i = startIndex;

  while (i < lines.length && /^\d+\.\s/.test(lines[i] ?? "")) {
    const text = lines[i]!.replace(/^\d+\.\s/, "");
    items.push({
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: {
        rich_text: parseInlineMarkdown(text),
      },
    });
    i++;
  }

  return { items, nextIndex: i };
}

function parseTable(
  lines: string[],
  startIndex: number
): { block: NotionBlock; nextIndex: number } {
  const tableRows: string[][] = [];
  let i = startIndex;

  while (i < lines.length && lines[i]?.includes("|") && lines[i]?.trim().startsWith("|")) {
    const row = lines[i]!.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
    // Skip separator rows (---)
    if (!row.every((cell) => /^[-:]+$/.test(cell))) {
      tableRows.push(row);
    }
    i++;
  }

  if (tableRows.length === 0) {
    return {
      block: {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: "" } }] },
      },
      nextIndex: i,
    };
  }

  const colCount = Math.max(...tableRows.map((r) => r.length));
  const hasHeader = tableRows.length > 0;

  const tableBlock: NotionBlock = {
    object: "block",
    type: "table",
    table: {
      table_width: colCount,
      has_column_header: hasHeader,
      has_row_header: false,
      children: tableRows.map((row) => ({
        type: "table_row",
        table_row: {
          cells: Array.from({ length: colCount }, (_, ci) => {
            const cell = row[ci]?.slice(0, RICH_TEXT_LIMIT) ?? "";
            return [{ text: { content: cell } }];
          }),
        },
      })),
    },
  };

  return { block: tableBlock, nextIndex: i };
}

function parseParagraph(
  lines: string[],
  startIndex: number
): { block: NotionBlock; nextIndex: number } {
  const paraLines: string[] = [];
  let i = startIndex;

  while (
    i < lines.length &&
    lines[i]?.trim() !== "" &&
    !lines[i]?.startsWith("#") &&
    !lines[i]?.startsWith("```") &&
    !lines[i]?.startsWith("- ") &&
    !lines[i]?.startsWith("* ") &&
    !lines[i]?.startsWith("> ") &&
    !lines[i]?.trim().startsWith("|") &&
    lines[i]?.trim() !== "---" &&
    lines[i]?.trim() !== "***" &&
    !/^\d+\.\s/.test(lines[i] ?? "")
  ) {
    paraLines.push(lines[i]!);
    i++;
  }

  const text = paraLines.join("\n").slice(0, RICH_TEXT_LIMIT);

  // Check if it looks like a bold definition line (e.g., "**Term** — description")
  if (text.startsWith("**") && text.includes("**")) {
    return {
      block: {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: parseInlineMarkdown(text) },
      },
      nextIndex: i,
    };
  }

  return {
    block: {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: text } }] },
    },
    nextIndex: i,
  };
}

// ─── Inline Markdown Parser ─────────────────────────────────────

export function parseInlineMarkdown(text: string): RichTextSegment[] {
  if (!text) return [{ type: "text", text: { content: "" } }];

  const segments: RichTextSegment[] = [];
  // Match patterns: `code`, **bold**, *italic*, [text](url), [[wikilink]]
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|\[\[([^\]]+)\]\])/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      if (plain) {
        segments.push({ type: "text", text: { content: plain } });
      }
    }

    const token = match[0];

    if (token.startsWith("`") && token.endsWith("`")) {
      // Inline code
      segments.push({
        type: "text",
        text: { content: token.slice(1, -1) },
        annotations: { code: true },
      });
    } else if (token.startsWith("**") && token.endsWith("**")) {
      // Bold
      segments.push({
        type: "text",
        text: { content: token.slice(2, -2) },
        annotations: { bold: true },
      });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      // Italic (but not bold)
      segments.push({
        type: "text",
        text: { content: token.slice(1, -1) },
        annotations: { italic: true },
      });
    } else if (token.startsWith("[[") && token.endsWith("]]")) {
      // Wikilink
      const link = token.slice(2, -2);
      segments.push({
        type: "text",
        text: { content: link },
        annotations: { bold: true },
      });
    } else if (token.startsWith("[") && token.includes("](")) {
      // Markdown link [text](url)
      const linkText = token.slice(1, token.indexOf("]"));
      const linkUrl = token.slice(token.indexOf("](") + 2, -1);
      segments.push({
        type: "text",
        text: { content: linkText, link: { url: linkUrl } },
      });
    }

    lastIndex = pattern.lastIndex;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining) {
      segments.push({ type: "text", text: { content: remaining } });
    }
  }

  // Notion requires at least one segment
  if (segments.length === 0) {
    segments.push({ type: "text", text: { content: text.slice(0, RICH_TEXT_LIMIT) } });
  }

  return segments;
}

// ─── Helpers ────────────────────────────────────────────────────

function makeHeading(level: 1 | 2 | 3, text: string): NotionBlock {
  const type = `heading_${level}` as "heading_1" | "heading_2" | "heading_3";
  return {
    object: "block",
    type,
    [type]: {
      rich_text: parseInlineMarkdown(text.slice(0, RICH_TEXT_LIMIT)),
    },
  };
}

function mapLanguage(lang: string): string {
  return LANGUAGE_MAP[lang.toLowerCase()] ?? lang.toLowerCase() ?? "plain text";
}

function splitIntoChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxLen);
    chunks.push(chunk);
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}