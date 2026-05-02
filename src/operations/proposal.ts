/**
 * Proposal Module — Human-in-the-loop ingestion proposals.
 *
 * When ingestion mode is "confirm" or "guided", the wiki generates a proposal
 * before making changes. The proposal describes what will be created, updated,
 * and cross-referenced. The agent or user can approve, modify, or reject it.
 *
 * Proposals are stored as JSON in `.codebase-wiki/meta/proposals/`.
 */

import * as fs from "fs";
import * as path from "path";
import { formatWikiDate } from "../shared.js";
import type { WikiStore } from "../core/store.js";

// ============================================================================
// TYPES
// ============================================================================

/** A single page action within a proposal */
export interface ProposalAction {
  type: "create" | "update";
  pageId: string;
  pageType: string;
  title: string;
  path: string;
  summary: string;
  sections?: string[];       // Sections that will be added/updated
  crossRefs?: string[];      // Pages this will reference
  sourceManifestId?: string; // Source that triggered this action
}

/** An ingestion proposal — describes what will happen before it happens */
export interface Proposal {
  id: string;                  // Unique proposal ID
  source: string;              // What triggered this (e.g., "git-commits", "article")
  sourceTitle: string;         // Human-readable title
  createdAt: string;           // ISO timestamp
  status: "pending" | "approved" | "rejected" | "applied";
  actions: ProposalAction[];    // Pages to create or update
  contradictions?: {            // Potential conflicts detected
    pageA: string;
    pageB: string;
    similarity: number;
    suggestion: string;
  }[];
  metadata: Record<string, any>; // Source-specific metadata
}

/** Result of applying a proposal */
export interface ProposalResult {
  proposalId: string;
  applied: boolean;
  pagesCreated: string[];
  pagesUpdated: string[];
  crossReferencesAdded: number;
  errors: string[];
}

// ============================================================================
// PROPOSAL GENERATION
// ============================================================================

/**
 * Generate a unique proposal ID.
 */
export function generateProposalId(source: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `prop-${source.slice(0, 8)}-${timestamp}-${random}`;
}

/**
 * Save a proposal to disk.
 */
export function saveProposal(wikiPath: string, proposal: Proposal): void {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");
  console.assert(typeof proposal === "object", "proposal must be object");

  const proposalsDir = path.join(wikiPath, "meta", "proposals");
  fs.mkdirSync(proposalsDir, { recursive: true });

  const filePath = path.join(proposalsDir, `${proposal.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), "utf-8");
}

/**
 * Load a proposal from disk.
 */
export function loadProposal(wikiPath: string, proposalId: string): Proposal | null {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");
  console.assert(typeof proposalId === "string", "proposalId must be string");

  const filePath = path.join(wikiPath, "meta", "proposals", `${proposalId}.json`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as Proposal;
  } catch {
    return null;
  }
}

/**
 * List all proposals, optionally filtered by status.
 */
export function listProposals(wikiPath: string, status?: string): Proposal[] {
  console.assert(typeof wikiPath === "string", "wikiPath must be string");

  const proposalsDir = path.join(wikiPath, "meta", "proposals");
  if (!fs.existsSync(proposalsDir)) return [];

  const proposals: Proposal[] = [];
  const files = fs.readdirSync(proposalsDir).filter(f => f.endsWith(".json"));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(proposalsDir, file), "utf-8");
      const proposal = JSON.parse(content) as Proposal;
      if (!status || proposal.status === status) {
        proposals.push(proposal);
      }
    } catch {
      // Skip invalid proposal files
    }
  }

  return proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Update a proposal's status.
 */
export function updateProposalStatus(
  wikiPath: string,
  proposalId: string,
  status: Proposal["status"]
): Proposal | null {
  const proposal = loadProposal(wikiPath, proposalId);
  if (!proposal) return null;

  proposal.status = status;
  saveProposal(wikiPath, proposal);
  return proposal;
}

/**
 * Modify a proposal's actions (e.g., remove a page creation, change type).
 */
export function modifyProposal(
  wikiPath: string,
  proposalId: string,
  changes: { actions?: ProposalAction[] }
): Proposal | null {
  const proposal = loadProposal(wikiPath, proposalId);
  if (!proposal) return null;

  if (changes.actions) {
    proposal.actions = changes.actions;
  }

  saveProposal(wikiPath, proposal);
  return proposal;
}

// ============================================================================
// PROPOSAL FORMATTING
// ============================================================================

/**
 * Format a proposal as a human-readable message for the agent.
 */
export function formatProposal(proposal: Proposal): string {
  const lines: string[] = [
    `📖 Ingest Proposal for "${proposal.sourceTitle}"`,
    ``,
    `**Source**: ${proposal.source}`,
    `**Created**: ${proposal.createdAt.split("T")[0]}`,
    `**Status**: ${proposal.status}`,
    ``,
  ];

  const creates = proposal.actions.filter(a => a.type === "create");
  const updates = proposal.actions.filter(a => a.type === "update");

  if (creates.length > 0) {
    lines.push("**New pages to create:**");
    for (const action of creates) {
      lines.push(`- [[${action.pageId}]] (${action.pageType}) — ${action.summary}`);
    }
    lines.push("");
  }

  if (updates.length > 0) {
    lines.push("**Pages to update:**");
    for (const action of updates) {
      lines.push(`- [[${action.pageId}]] — ${action.summary}`);
    }
    lines.push("");
  }

  if (proposal.actions.some(a => a.crossRefs && a.crossRefs.length > 0)) {
    lines.push("**Cross-references to add:**");
    for (const action of proposal.actions) {
      if (action.crossRefs && action.crossRefs.length > 0) {
        lines.push(`- [[${action.pageId}]] → ${action.crossRefs.map(r => `[[${r}]]`).join(", ")}`);
      }
    }
    lines.push("");
  }

  if (proposal.contradictions && proposal.contradictions.length > 0) {
    lines.push("**⚠️ Potential contradictions:**");
    for (const c of proposal.contradictions) {
      const pct = (c.similarity * 100).toFixed(0);
      lines.push(`- [[${c.pageA}]] ↔ [[${c.pageB}]] (${pct}% overlap) — ${c.suggestion}`);
    }
    lines.push("");
  }

  lines.push("Proceed? (approve / reject / edit)");

  return lines.join("\n");
}

/**
 * Format a short summary of all pending proposals.
 */
export function formatProposalList(proposals: Proposal[]): string {
  if (proposals.length === 0) {
    return "No pending proposals.";
  }

  const lines = [`📋 ${proposals.length} proposal(s):`, ""];

  for (const p of proposals) {
    const createCount = p.actions.filter(a => a.type === "create").length;
    const updateCount = p.actions.filter(a => a.type === "update").length;
    lines.push(`- **${p.id}** (${p.status}) — ${p.sourceTitle}`);
    lines.push(`  ${createCount} create, ${updateCount} update — ${p.createdAt.split("T")[0]}`);
  }

  return lines.join("\n");
}