import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSchemaFile, type GraphSnapshot } from "@specflow/core";
import { SnapshotBuilder } from "@specflow/parser";
import { edgeKey, emptyGraph, MemoryStore, planIngest, planLinks, type StoredGraph } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const schema = loadSchemaFile(join(ROOT, "schema/schema.yaml"));
const options = { project: "T", schema };
const opts = { schema, specVersion: "test", now: new Date("2026-10-16T00:00:00Z") };

const header = (doc: string, extra = "") =>
  `---\nid: ${doc}-DOC\ndoc: ${doc}\ntitle: t\nowner: me\nstatus: draft\nversion: 0.1.0\n${extra}---\n`;

function snapshotOf(files: Record<string, string>): GraphSnapshot {
  const builder = new SnapshotBuilder(options);
  for (const [file, text] of Object.entries(files)) builder.addDocument(file, text);
  return builder.finish();
}

const files = (minLength: string, ac = `${minLength} 미만이면 에러 (RULE-PW-001 최소 길이)`, req = "비밀번호 설정") => ({
  "prd/pw.md": `${header("prd")}### RULE-PW-001 비밀번호\n- 최소 길이: ${minLength}\n`,
  "fdd/a.md": `${header("fdd", "feature: FEAT-A\n")}### REQ-A-001 ${req}\n- 정책: [[RULE-PW-001]]\n- 인수 조건:\n  - AC-A-001-01: ${ac}\n`,
  "prd/f.md": `${header("prd")}### FEAT-A 기능\n- 설명: a\n`,
});

async function storedAfter(...versions: Record<string, string>[]): Promise<StoredGraph> {
  const store = new MemoryStore();
  for (const v of versions) await store.applyIngest(planIngest(await store.load("T"), snapshotOf(v), opts));
  return store.load("T");
}

describe("planIngest", () => {
  it("adds every element at version 1 in the first ChangeSet", () => {
    const plan = planIngest(emptyGraph("T"), snapshotOf(files("8자")), opts);
    expect(plan.changeSet?.id).toBe("CS-0001");
    expect(plan.changeSet?.changes.map((c) => [c.id, c.op, c.changeType])).toEqual([
      ["AC-A-001-01", "added", "Behavioral"],
      ["FEAT-A", "added", "Structural"],
      ["REQ-A-001", "added", "Structural"],
      ["RULE-PW-001", "added", "Rule"],
    ]);
    expect(plan.elements.every((e) => e.version === 1)).toBe(true);
    expect(plan.stale).toEqual([]);
  });

  it("is a no-op when nothing changed", async () => {
    const stored = await storedAfter(files("8자"));
    const plan = planIngest(stored, snapshotOf(files("8자")), opts);
    expect(plan.changeSet).toBeUndefined();
    expect(plan.removedEdges).toEqual([]);
  });

  it("bumps versions of changed elements and classifies by rule", async () => {
    const stored = await storedAfter(files("8자"));
    const plan = planIngest(stored, snapshotOf(files("10자")), opts);
    expect(plan.changeSet?.id).toBe("CS-0002");
    expect(plan.changeSet?.changes.map((c) => [c.id, c.changeType, c.version])).toEqual([
      ["AC-A-001-01", "Behavioral", { from: 1, to: 2 }],
      ["RULE-PW-001", "Rule", { from: 1, to: 2 }],
    ]);
    expect(plan.changeSet?.changes[1]).toMatchObject({ before: expect.stringContaining("8자"), after: expect.stringContaining("10자") });
  });

  it("leaves wording-only changes unclassified", async () => {
    const stored = await storedAfter(files("8자"));
    const plan = planIngest(stored, snapshotOf(files("8자", undefined, "비밀번호 정하기")), opts);
    expect(plan.changeSet?.changes.map((c) => [c.id, c.changeType])).toEqual([["REQ-A-001", "Unclassified"]]);
  });

  describe("sync links (L09)", () => {
    const policyOnly = { ...files("8자"), "prd/pw.md": files("10자")["prd/pw.md"] };

    it("marks lower elements stale when only the upper changed", async () => {
      const stored = await storedAfter(files("8자"));
      const plan = planIngest(stored, snapshotOf(policyOnly), opts);
      expect(plan.stale.map((s) => [s.relation, s.lower, s.upper, s.syncedVersion, s.upperVersion])).toEqual([
        ["CITES", "T:AC-A-001-01", "T:RULE-PW-001", 1, 2],
        ["GOVERNED_BY", "T:REQ-A-001", "T:RULE-PW-001", 1, 2],
      ]);
    });

    it("treats editing the lower element as reviewing it", async () => {
      const stored = await storedAfter(files("8자"));
      const plan = planIngest(stored, snapshotOf(files("10자")), opts);
      expect(plan.stale.map((s) => s.lower)).toEqual(["T:REQ-A-001"]);
      const cites = plan.edges.find((e) => e.type === "CITES");
      expect(cites?.syncedVersion).toBe(2);
    });

    it("accepts a review only for the upper content it names", async () => {
      const stored = await storedAfter(files("8자"));
      const snapshot = snapshotOf(files("10자"));
      const upperHash = snapshot.nodes.find((n) => n.id === "RULE-PW-001")!.contentHash;
      const reviewed = planIngest(stored, snapshot, { ...opts, reviews: [{ element: "REQ-A-001", upper: "RULE-PW-001", upperHash }] });
      expect(reviewed.stale).toEqual([]);
      expect(reviewed.edges.find((e) => e.type === "GOVERNED_BY")?.syncedVersion).toBe(2);

      const outdated = planIngest(stored, snapshot, {
        ...opts,
        reviews: [{ element: "REQ-A-001", upper: "RULE-PW-001", upperHash: "an-older-hash" }],
      });
      expect(outdated.stale.map((s) => s.lower)).toEqual(["T:REQ-A-001"]);
    });

    it("keeps a stale link stale across ingests until it is reviewed", async () => {
      const store = new MemoryStore();
      await store.applyIngest(planIngest(await store.load("T"), snapshotOf(files("8자")), opts));
      const forced = planIngest(await store.load("T"), snapshotOf(files("10자")), opts);
      await store.applyIngest(forced); // e.g. applied despite L09
      const again = planIngest(await store.load("T"), snapshotOf(files("10자")), opts);
      expect(again.changeSet).toBeUndefined();
      expect(again.stale.map((s) => s.lower)).toEqual(["T:REQ-A-001"]);
    });
  });

  it("reports removed IDs (L05) and references outside the project", async () => {
    const stored = await storedAfter(files("8자"));
    const without = { ...files("8자"), "prd/f.md": `${header("prd")}` };
    without["fdd/a.md"] = without["fdd/a.md"].replace("- 정책: [[RULE-PW-001]]", "- 정책: [[shared:RULE-PW-001]]");
    const plan = planIngest(stored, snapshotOf(without), opts);
    expect(plan.removed.map((e) => e.id)).toEqual(["FEAT-A"]);
    // The FDD's `feature: FEAT-A` now points at the removed feature, and the policy lives in another project.
    expect(plan.unresolved.map(edgeKey).sort()).toEqual([
      "GOVERNED_BY|T:REQ-A-001|shared:RULE-PW-001",
      "HAS_REQUIREMENT|T:FEAT-A|T:REQ-A-001",
    ]);
  });
});

describe("planLinks", () => {
  it("records the linked element's version and keeps it on re-registration", async () => {
    const store = new MemoryStore();
    await store.applyIngest(planIngest(await store.load("T"), snapshotOf(files("8자")), opts));
    const file = {
      project: "T",
      artifacts: [{ id: "TC-A-001", type: "TestCase", title: "tc", source: "x", links: [{ relation: "VERIFIES", to: "AC-A-001-01" }] }],
    };
    const first = planLinks(await store.load("T"), file, schema);
    expect(first.problems).toEqual([]);
    expect(first.edges[0]).toMatchObject({ layer: "artifact", syncedVersion: 1 });
    await store.applyLinks(first);

    await store.applyIngest(planIngest(await store.load("T"), snapshotOf(files("10자")), opts));
    const second = planLinks(await store.load("T"), file, schema);
    expect(second.edges[0]?.syncedVersion).toBe(1); // still reflects v1: the TC is stale for impact analysis
  });

  it("rejects unknown targets and relations that do not fit", async () => {
    const stored = await storedAfter(files("8자"));
    const plan = planLinks(
      stored,
      {
        project: "T",
        artifacts: [
          { id: "TC-A-002", type: "TestCase", title: "t", source: "x", links: [{ relation: "VERIFIES", to: "AC-NOPE-01" }] },
          { id: "DSN-A", type: "DesignFrame", title: "d", source: "x", links: [{ relation: "VERIFIES", to: "REQ-A-001" }] },
          { id: "REQ-X-001", type: "Requirement", title: "r", source: "x", links: [] },
        ],
      },
      schema,
    );
    expect(plan.problems).toHaveLength(3);
  });
});
