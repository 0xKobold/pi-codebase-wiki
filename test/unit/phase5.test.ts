/**
 * Human-in-the-Loop Ingestion Proposal Tests
 *
 * Tests: proposal creation, save/load, format, status updates,
 * confirm/guided mode integration, proposal listing and filtering.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  generateProposalId,
  saveProposal,
  loadProposal,
  listProposals,
  updateProposalStatus,
  modifyProposal,
  formatProposal,
  formatProposalList,
} from "../../src/operations/proposal.js";
import type { Proposal, ProposalAction } from "../../src/operations/proposal.js";

let tmpDir: string;
let wikiPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-p5-"));
  wikiPath = path.join(tmpDir, ".codebase-wiki");
  fs.mkdirSync(path.join(wikiPath, "meta", "proposals"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createTestProposal(overrides?: Partial<Proposal>): Proposal {
  return {
    id: generateProposalId("article"),
    source: "article",
    sourceTitle: "Understanding OAuth 2.0",
    createdAt: new Date().toISOString(),
    status: "pending",
    actions: [
      {
        type: "create",
        pageId: "oauth-flow",
        pageType: "concept",
        title: "OAuth 2.0 Flow",
        path: "concepts/oauth-flow.md",
        summary: "OAuth 2.0 authentication flow overview",
        crossRefs: ["auth-module"],
      },
      {
        type: "create",
        pageId: "oauth-security",
        pageType: "concept",
        title: "OAuth Security",
        path: "concepts/oauth-security.md",
        summary: "Security considerations for OAuth",
      },
      {
        type: "update",
        pageId: "auth-module",
        pageType: "entity",
        title: "Auth Module",
        path: "entities/auth-module.md",
        summary: "Add OAuth section",
        crossRefs: ["oauth-flow", "oauth-security"],
      },
    ],
    contradictions: [
      {
        pageA: "oauth-flow",
        pageB: "auth-module",
        similarity: 0.45,
        suggestion: "update",
      },
    ],
    metadata: { type: "article", contentLength: 5000 },
    ...overrides,
  };
}

// ─── PROPOSAL ID GENERATION ──────────────────────────────────────────────────

describe("generateProposalId creates unique IDs", () => {
  test("includes source prefix", () => {
    const id = generateProposalId("article");
    expect(id).toContain("prop-article");
  });

  test("generates unique IDs", () => {
    const id1 = generateProposalId("article");
    const id2 = generateProposalId("article");
    expect(id1).not.toBe(id2);
  });
});

// ─── SAVE & LOAD ────────────────────────────────────────────────────────────

describe("saveProposal and loadProposal persist proposals to disk", () => {
  test("saves and loads a proposal", () => {
    const proposal = createTestProposal();
    saveProposal(wikiPath, proposal);

    const loaded = loadProposal(wikiPath, proposal.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(proposal.id);
    expect(loaded!.source).toBe("article");
    expect(loaded!.sourceTitle).toBe("Understanding OAuth 2.0");
    expect(loaded!.actions.length).toBe(3);
    expect(loaded!.contradictions!.length).toBe(1);
  });

  test("returns null for nonexistent proposal", () => {
    const loaded = loadProposal(wikiPath, "nonexistent");
    expect(loaded).toBeNull();
  });

  test("preserves all action fields", () => {
    const proposal = createTestProposal();
    saveProposal(wikiPath, proposal);

    const loaded = loadProposal(wikiPath, proposal.id)!;
    const action = loaded.actions[0]!;
    expect(action.type).toBe("create");
    expect(action.pageId).toBe("oauth-flow");
    expect(action.pageType).toBe("concept");
    expect(action.crossRefs).toEqual(["auth-module"]);
  });
});

// ─── LIST PROPOSALS ──────────────────────────────────────────────────────────

describe("listProposals returns proposals sorted by date", () => {
  test("returns empty when no proposals exist", () => {
    const proposals = listProposals(wikiPath);
    expect(proposals).toEqual([]);
  });

  test("lists all proposals", () => {
    saveProposal(wikiPath, createTestProposal({ id: "prop-1" }));
    saveProposal(wikiPath, createTestProposal({ id: "prop-2", sourceTitle: "Other Article" }));

    const proposals = listProposals(wikiPath);
    expect(proposals.length).toBe(2);
  });

  test("filters by status", () => {
    saveProposal(wikiPath, createTestProposal({ id: "prop-1", status: "pending" }));
    saveProposal(wikiPath, createTestProposal({ id: "prop-2", status: "approved" }));
    saveProposal(wikiPath, createTestProposal({ id: "prop-3", status: "rejected" }));

    const pending = listProposals(wikiPath, "pending");
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe("prop-1");

    const approved = listProposals(wikiPath, "approved");
    expect(approved.length).toBe(1);
  });
});

// ─── STATUS UPDATES ─────────────────────────────────────────────────────────

describe("updateProposalStatus changes proposal status", () => {
  test("approves a pending proposal", () => {
    const proposal = createTestProposal();
    saveProposal(wikiPath, proposal);

    const updated = updateProposalStatus(wikiPath, proposal.id, "approved");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("approved");

    // Verify persisted
    const reloaded = loadProposal(wikiPath, proposal.id);
    expect(reloaded!.status).toBe("approved");
  });

  test("rejects a pending proposal", () => {
    const proposal = createTestProposal();
    saveProposal(wikiPath, proposal);

    const updated = updateProposalStatus(wikiPath, proposal.id, "rejected");
    expect(updated!.status).toBe("rejected");
  });

  test("marks proposal as applied", () => {
    const proposal = createTestProposal();
    saveProposal(wikiPath, proposal);

    const updated = updateProposalStatus(wikiPath, proposal.id, "applied");
    expect(updated!.status).toBe("applied");
  });

  test("returns null for nonexistent proposal", () => {
    const result = updateProposalStatus(wikiPath, "nonexistent", "approved");
    expect(result).toBeNull();
  });
});

// ─── MODIFY PROPOSAL ────────────────────────────────────────────────────────

describe("modifyProposal changes proposal actions", () => {
  test("replaces actions with modified set", () => {
    const proposal = createTestProposal();
    saveProposal(wikiPath, proposal);

    const modifiedActions: ProposalAction[] = [
      {
        type: "create",
        pageId: "oauth-flow",
        pageType: "concept",
        title: "OAuth 2.0 Flow (revised)",
        path: "concepts/oauth-flow.md",
        summary: "Updated summary",
      },
    ];

    const modified = modifyProposal(wikiPath, proposal.id, { actions: modifiedActions });
    expect(modified).not.toBeNull();
    expect(modified!.actions.length).toBe(1);
    expect(modified!.actions[0]!.title).toBe("OAuth 2.0 Flow (revised)");
  });
});

// ─── FORMATTING ─────────────────────────────────────────────────────────────

describe("formatProposal produces readable output", () => {
  test("includes pages to create, update, and contradictions", () => {
    const proposal = createTestProposal();
    const formatted = formatProposal(proposal);

    expect(formatted).toContain("Ingest Proposal");
    expect(formatted).toContain("Understanding OAuth 2.0");
    expect(formatted).toContain("New pages to create");
    expect(formatted).toContain("[[oauth-flow]]");
    expect(formatted).toContain("[[oauth-security]]");
    expect(formatted).toContain("Pages to update");
    expect(formatted).toContain("[[auth-module]]");
    expect(formatted).toContain("Cross-references to add");
    expect(formatted).toContain("Potential contradictions");
    expect(formatted).toContain("45% overlap");
    expect(formatted).toContain("approve / reject / edit");
  });
});

describe("formatProposalList summarizes multiple proposals", () => {
  test("shows count and details", () => {
    const proposals = [
      createTestProposal({ id: "prop-1", createdAt: "2026-05-01T10:00:00.000Z" }),
      createTestProposal({ id: "prop-2", sourceTitle: "Other", createdAt: "2026-05-02T10:00:00.000Z" }),
    ];

    const formatted = formatProposalList(proposals);
    expect(formatted).toContain("2 proposal(s)");
    expect(formatted).toContain("prop-1");
    expect(formatted).toContain("prop-2");
  });

  test("shows empty message when no proposals", () => {
    const formatted = formatProposalList([]);
    expect(formatted).toContain("No pending proposals");
  });
});