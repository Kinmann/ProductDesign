import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSchemaFile } from "@specflow/core";
import { SnapshotBuilder } from "@specflow/parser";
import { MemoryStore, planIngest, planLinks, type ChangeSet, type StoredGraph } from "@specflow/store";
import { analyzeImpact, formatTrace, gradeOf, renderImpactMarkdown } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const schema = loadSchemaFile(join(ROOT, "schema/schema.yaml"));
const opts = { schema, specVersion: "t", now: new Date("2026-10-16T00:00:00Z") };

const header = (doc: string, extra = "") =>
  `---\nid: ${doc}-${Math.random()}\ndoc: ${doc}\ntitle: t\nowner: me\nstatus: draft\nversion: 0.1.0\n${extra}---\n`;

/** Ingest `before`, link artifacts, then plan `after` and return the stored graph after it plus its ChangeSet. */
async function changed(
  before: Record<string, string>,
  after: Record<string, string>,
  links: { id: string; type: string; to: string; relation: string }[],
): Promise<{ graph: StoredGraph; changeSet: ChangeSet }> {
  const store = new MemoryStore();
  const snap = (files: Record<string, string>) => {
    const b = new SnapshotBuilder({ project: "T", schema });
    for (const [f, t] of Object.entries(files)) b.addDocument(f, t);
    return b.finish();
  };
  await store.applyIngest(planIngest(await store.load("T"), snap(before), opts));
  await store.applyLinks(
    planLinks(
      await store.load("T"),
      { project: "T", artifacts: links.map((l) => ({ id: l.id, type: l.type, title: l.id, source: "x", links: [{ relation: l.relation, to: l.to }] })) },
      schema,
    ),
  );
  const plan = planIngest(await store.load("T"), snap(after), opts);
  await store.applyIngest(plan);
  return { graph: await store.load("T"), changeSet: plan.changeSet! };
}

const base = {
  "prd/f.md": `${header("prd")}### FEAT-A 기능\n- 설명: a\n`,
  "prd/r.md": `${header("prd")}### RULE-R-001 정책\n- 한도: 3회\n`,
  "fdd/a.md": `${header("fdd", "feature: FEAT-A\n")}### REQ-A-001 첫째\n- 정책: [[RULE-R-001]]\n- 인수 조건:\n  - AC-A-001-01: 3회 실패 시 잠금\n\n### REQ-A-002 둘째\n- 의존: [[REQ-A-001]]\n- 인수 조건:\n  - AC-A-002-01: b\n\n### REQ-A-003 셋째\n- 의존: [[REQ-A-002]]\n- 인수 조건:\n  - AC-A-003-01: c\n`,
};
const ruleChanged = { ...base, "prd/r.md": base["prd/r.md"].replace("3회", "5회") };

describe("gradeOf (부록 B)", () => {
  it.each([
    ["Behavioral", 0, false, "High"],
    ["Copy", 0, false, "Medium"],
    ["Rule", 1, false, "High"],
    ["Structural", 1, false, "High"],
    ["Behavioral", 1, false, "Medium"],
    ["Rule", 2, false, "Medium"],
    ["Rule", 3, false, "Low"],
    ["Rule", 1, true, "Low"],
    ["Unclassified", 0, false, "High"],
  ] as const)("%s at distance %i (low only: %s) → %s", (changeType, distance, lowOnly, grade) => {
    expect(gradeOf(changeType, { distance, lowOnly })).toBe(grade);
  });
});

describe("analyzeImpact", () => {
  it("follows reverse propagation from a policy to the requirements that follow it", async () => {
    const { graph, changeSet } = await changed(base, ruleChanged, [
      { id: "CODE-a", type: "CodeModule", relation: "REALIZES", to: "REQ-A-001" },
    ]);
    const report = analyzeImpact(graph, changeSet, { schema });
    expect(report.artifacts).toMatchObject([{ artifact: "CODE-a", grade: "High", distance: 1, trace: ["RULE-R-001", "REQ-A-001", "CODE-a"] }]);
    expect(formatTrace(report.artifacts[0]!.path)).toBe("RULE-R-001 ←GOVERNED_BY─ REQ-A-001 ←REALIZES─ CODE-a");
  });

  it("follows a max_depth: 1 relation only once per path", async () => {
    // REQ-A-002 depends on REQ-A-001, REQ-A-003 on REQ-A-002: a second DEPENDS_ON hop is not taken.
    const { graph, changeSet } = await changed(base, ruleChanged, [
      { id: "CODE-b", type: "CodeModule", relation: "REALIZES", to: "REQ-A-002" },
      { id: "CODE-c", type: "CodeModule", relation: "REALIZES", to: "REQ-A-003" },
    ]);
    const report = analyzeImpact(graph, changeSet, { schema });
    expect(report.artifacts.map((a) => [a.artifact, a.distance, a.grade])).toEqual([["CODE-b", 2, "Medium"]]);
  });

  it("does not propagate against a forward-only relation", async () => {
    // HAS_REQUIREMENT is forward (Feature → Requirement): changing a requirement does not reach the feature's other requirements.
    const reqChanged = { ...base, "fdd/a.md": base["fdd/a.md"].replace("### REQ-A-003 셋째", "### REQ-A-003 셋째 (바뀜)") };
    const { graph, changeSet } = await changed(base, reqChanged, [
      { id: "DSN-f", type: "DesignFrame", relation: "IMPLEMENTS", to: "REQ-A-001" },
    ]);
    const report = analyzeImpact(graph, changeSet, { schema });
    expect(report.artifacts).toEqual([]);
  });

  it("ignores editorial changes", async () => {
    const { graph, changeSet } = await changed(base, ruleChanged, [
      { id: "CODE-a", type: "CodeModule", relation: "REALIZES", to: "REQ-A-001" },
    ]);
    const editorial = { ...changeSet, changes: changeSet.changes.map((c) => ({ ...c, changeType: "Editorial" as const })) };
    expect(analyzeImpact(graph, editorial, { schema }).artifacts).toEqual([]);
  });

  it("asks for new work when a required domain has nothing to update", async () => {
    // A policy value change needs dev and QA (●). Only code is linked, so QA gets new work.
    const { graph, changeSet } = await changed(base, ruleChanged, [
      { id: "CODE-a", type: "CodeModule", relation: "REALIZES", to: "REQ-A-001" },
    ]);
    const report = analyzeImpact(graph, changeSet, { schema });
    expect(report.newWork).toEqual([
      { domain: "qa", element: "RULE-R-001", action: "create", grade: "High", reason: "연결된 산출물이 없음" },
    ]);
  });

  it("marks directly linked artifacts of a deprecated element for removal", async () => {
    const deprecated = { ...base, "fdd/a.md": base["fdd/a.md"].replace("- 의존: [[REQ-A-002]]", "- 의존: [[REQ-A-002]]\n- 상태: deprecated") };
    const { graph, changeSet } = await changed(base, deprecated, [
      { id: "TC-c", type: "TestCase", relation: "VERIFIES", to: "REQ-A-003" },
    ]);
    const report = analyzeImpact(graph, changeSet, { schema });
    expect(changeSet.changes.map((c) => [c.id, c.op, c.changeType])).toEqual([["REQ-A-003", "deprecated", "Structural"]]);
    expect(report.artifacts).toMatchObject([{ artifact: "TC-c", action: "deprecate", grade: "High" }]);
  });

  it("renders a Markdown report", async () => {
    const { graph, changeSet } = await changed(base, ruleChanged, [
      { id: "CODE-a", type: "CodeModule", relation: "REALIZES", to: "REQ-A-001" },
    ]);
    const md = renderImpactMarkdown(analyzeImpact(graph, changeSet, { schema }), { preview: true });
    expect(md).toContain("## Impact Report · T CS-0002 (미리보기)");
    expect(md).toContain("| 개발 | 1 | 0 | 0 | 0 |");
    expect(md).toContain("| QA | 0 | 0 | 0 | 1 |");
    expect(md).toContain("RULE-R-001 ←GOVERNED_BY─ REQ-A-001 ←REALIZES─ CODE-a");
  });
});
