import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSchemaFile, type GraphSnapshot } from "@specflow/core";
import { parseSpecs, SnapshotBuilder } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SPECS = join(ROOT, "examples/demo/specs");
const OVERLAY = join(ROOT, "examples/demo/scenarios/password-policy/specs");
const schema = loadSchemaFile(join(ROOT, "schema/schema.yaml"));
const options = { project: "DEMO", schema };

const node = (s: GraphSnapshot, id: string) => s.nodes.find((n) => n.uid === `DEMO:${id}`);
const edgesOf = (s: GraphSnapshot, type: string) =>
  s.edges.filter((e) => e.type === type).map((e) => `${e.from.slice(5)} → ${e.to.slice(5)}`);

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
}

describe("DEMO specs", () => {
  const snapshot = parseSpecs(SPECS, options);

  it("parses every element and relation without problems", () => {
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.documents).toHaveLength(11);
    expect(countBy(snapshot.nodes.map((n) => n.type))).toEqual({
      AcceptanceCriteria: 10,
      BusinessRule: 1,
      DataEntity: 1,
      Feature: 3,
      Flow: 1,
      Requirement: 5,
      Screen: 6,
      Term: 2,
    });
    expect(countBy(snapshot.edges.map((e) => e.type))).toEqual({
      APPEARS_ON: 5,
      CHILD_OF: 5,
      CITES: 1,
      COVERS: 2,
      DEPENDS_ON: 3,
      FEATURE_DEPENDS_ON: 2,
      GOVERNED_BY: 3,
      HAS_CRITERIA: 10,
      HAS_REQUIREMENT: 5,
      NAVIGATES_TO: 10,
      PASSES_THROUGH: 2,
      USES: 3,
    });
  });

  it("records the document stage of each element", () => {
    expect(node(snapshot, "FEAT-SIGNUP")?.docLevel).toBe("prd");
    expect(node(snapshot, "AC-SIGNUP-002-01")?.docLevel).toBe("fdd");
    expect(node(snapshot, "SCR-SIGNUP")?.docLevel).toBe("ia");
  });

  it("links an FDD's feature to every requirement through front matter", () => {
    expect(edgesOf(snapshot, "HAS_REQUIREMENT")).toEqual([
      "FEAT-ACCOUNT → REQ-ACCOUNT-001",
      "FEAT-ACCOUNT → REQ-ACCOUNT-004",
      "FEAT-LOGIN → REQ-LOGIN-001",
      "FEAT-SIGNUP → REQ-SIGNUP-001",
      "FEAT-SIGNUP → REQ-SIGNUP-002",
    ]);
  });

  it("stores IA-declared relations in the schema's direction", () => {
    expect(edgesOf(snapshot, "APPEARS_ON")).toContain("REQ-SIGNUP-002 → SCR-SIGNUP");
    expect(edgesOf(snapshot, "PASSES_THROUGH")).toEqual([
      "FLOW-SIGNUP-01 → SCR-SIGNUP",
      "FLOW-SIGNUP-01 → SCR-SIGNUP-DONE",
    ]);
    expect(edgesOf(snapshot, "CHILD_OF")).toContain("SCR-ACCOUNT-PW → SCR-ACCOUNT");
  });

  it("turns nested acceptance criteria into elements of their own", () => {
    expect(node(snapshot, "AC-SIGNUP-002-02")?.title).toBe("비밀번호 확인 값이 다르면 가입 버튼을 비활성화한다.");
    expect(edgesOf(snapshot, "HAS_CRITERIA")).toContain("REQ-SIGNUP-002 → AC-SIGNUP-002-02");
  });

  it("reads policy values and citations", () => {
    expect(node(snapshot, "RULE-PW-001")?.values).toEqual({
      "최소 길이": "8자",
      "필수 문자": "영문, 숫자 각 1개 이상",
      "적용 대상": "모든 회원",
    });
    expect(node(snapshot, "RULE-PW-001")?.attrs["설명"]).toBe("가입과 비밀번호 변경 시 검증한다.");
    const cites = snapshot.edges.find((e) => e.type === "CITES");
    expect(cites).toMatchObject({
      from: "DEMO:AC-SIGNUP-002-01",
      to: "DEMO:RULE-PW-001",
      props: { item: "최소 길이", text: expect.stringContaining("8자 미만") },
    });
  });

  it("keeps flow step order and unmapped fields", () => {
    const covers = snapshot.edges.filter((e) => e.type === "COVERS");
    expect(covers.map((e) => [e.to.slice(5), e.props.order])).toEqual([
      ["REQ-SIGNUP-001", 1],
      ["REQ-SIGNUP-002", 2],
    ]);
    expect(node(snapshot, "FLOW-SIGNUP-01")?.attrs["예외"]).toBe("이메일 중복 시 로그인 화면으로 안내");
    expect(node(snapshot, "SCR-LOGIN")?.attrs["구성"]).toContain("로그인 버튼");
  });

  it("reads the sitemap hierarchy", () => {
    expect(snapshot.sitemap.map((e) => [e.screen.slice(5), e.parent?.slice(5)])).toEqual([
      ["SCR-HOME", undefined],
      ["SCR-SIGNUP", "SCR-HOME"],
      ["SCR-SIGNUP-DONE", "SCR-SIGNUP"],
      ["SCR-LOGIN", "SCR-HOME"],
      ["SCR-ACCOUNT", "SCR-HOME"],
      ["SCR-ACCOUNT-PW", "SCR-ACCOUNT"],
    ]);
  });
});

describe("password-policy overlay", () => {
  const before = parseSpecs(SPECS, options);
  const after = parseSpecs([SPECS, OVERLAY], options);
  const hash = (s: GraphSnapshot, id: string) => node(s, id)?.contentHash;

  it("changes the hash of edited elements only", () => {
    expect(hash(after, "RULE-PW-001")).not.toBe(hash(before, "RULE-PW-001"));
    expect(hash(after, "AC-SIGNUP-002-01")).not.toBe(hash(before, "AC-SIGNUP-002-01"));
    // Editing a requirement's acceptance criteria does not change the requirement itself.
    expect(hash(after, "REQ-SIGNUP-002")).toBe(hash(before, "REQ-SIGNUP-002"));
    expect(hash(after, "AC-SIGNUP-002-02")).toBe(hash(before, "AC-SIGNUP-002-02"));
  });

  it("adds the new acceptance criterion", () => {
    expect(node(before, "AC-SIGNUP-002-04")).toBeUndefined();
    expect(node(after, "AC-SIGNUP-002-04")?.title).toContain("특수문자");
    expect(node(after, "RULE-PW-001")?.values["최소 길이"]).toBe("10자");
  });
});

describe("parser edge cases", () => {
  const FDD = `---
id: FDD-X
doc: fdd
feature: FEAT-X
title: x
owner: me
status: draft
version: 0.1.0
---
`;
  function parseOne(body: string, header = FDD): GraphSnapshot {
    const builder = new SnapshotBuilder(options);
    builder.addDocument("fdd/x.md", header + body);
    return builder.finish();
  }

  it("ignores elements inside fenced code blocks", () => {
    const s = parseOne("```markdown\n### REQ-X-001 예시\n```\n");
    expect(s.nodes).toEqual([]);
  });

  it("reports a missing front matter", () => {
    const s = parseOne("### REQ-X-001 a\n", "");
    expect(s.issues.map((i) => i.code)).toContain("L01");
  });

  it("reports duplicate IDs with the first location", () => {
    const s = parseOne("### REQ-X-001 a\n### REQ-X-001 b\n");
    expect(s.issues).toMatchObject([{ code: "L04", message: expect.stringContaining("fdd/x.md:10") }]);
  });

  it("reports a relation that cannot connect the two types", () => {
    const s = parseOne("### REQ-X-001 a\n- 정책: [[SCR-HOME]]\n");
    expect(s.issues).toMatchObject([{ code: "P02", source: { line: 11 } }]);
    expect(s.edges.filter((e) => e.type === "GOVERNED_BY")).toEqual([]);
  });

  it("warns about references in fields that are not relations", () => {
    const s = parseOne("### REQ-X-001 a\n- 메모: [[REQ-X-002]] 참고\n");
    expect(s.issues.map((i) => i.code)).toEqual(["P04"]);
  });

  it("keeps project-qualified references as global ids", () => {
    const s = parseOne("### REQ-X-001 a\n- 정책: [[shared:RULE-PW-001]]\n");
    expect(s.edges.find((e) => e.type === "GOVERNED_BY")?.to).toBe("shared:RULE-PW-001");
  });

  it("treats non-element headings as section breaks", () => {
    const s = parseOne("### REQ-X-001 a\n- 설명: 첫 요구사항\n## 메모\n- 설명: 요구사항 밖의 글\n");
    expect(s.nodes.find((n) => n.id === "REQ-X-001")?.attrs["설명"]).toBe("첫 요구사항");
  });
});
