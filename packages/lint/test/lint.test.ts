import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSchemaFile, type GraphSnapshot } from "@specflow/core";
import { parseSpecs, SnapshotBuilder } from "@specflow/parser";
import { lint, RULES } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SPECS = join(ROOT, "examples/demo/specs");
const SCENARIO = join(ROOT, "examples/demo/scenarios/password-policy/specs");
const schema = loadSchemaFile(join(ROOT, "schema/schema.yaml"));
const options = { project: "DEMO", schema };

function header(doc: string, extra = ""): string {
  return `---\nid: ${doc.toUpperCase()}-DOC\ndoc: ${doc}\ntitle: t\nowner: me\nstatus: draft\nversion: 0.1.0\n${extra}---\n`;
}

/** A small, valid project: one feature, one requirement on one screen. Tests override files to break one rule. */
const BASE: Record<string, string> = {
  "prd/prd.md": `${header("prd")}### FEAT-A 기능 A\n- 설명: a\n`,
  "prd/policies/pw.md": `${header("prd")}### RULE-PW-001 비밀번호\n- 최소 길이: 8자\n`,
  "fdd/a.md": `${header("fdd", "feature: FEAT-A\n")}### REQ-A-001 요구 A\n- 정책: [[RULE-PW-001]]\n- 인수 조건:\n  - AC-A-001-01: 8자 미만이면 에러 (RULE-PW-001 최소 길이)\n`,
  "ia/sitemap.md": `${header("ia")}- 홈 [[SCR-HOME]]\n  - A [[SCR-A]]\n`,
  "ia/screens.md": `${header("ia")}### SCR-HOME 홈\n- 이동: [[SCR-A]]\n\n### SCR-A 화면 A\n- 상위: [[SCR-HOME]]\n- 요구사항: [[REQ-A-001]]\n`,
};

function snapshotOf(files: Record<string, string>): GraphSnapshot {
  const builder = new SnapshotBuilder(options);
  for (const [file, text] of Object.entries(files)) builder.addDocument(file, text);
  return builder.finish();
}

function codes(files: Record<string, string>, previous?: Record<string, string>): string[] {
  const result = lint(snapshotOf(files), { schema, ...(previous && { previous: snapshotOf(previous) }) });
  return result.findings.map((f) => f.code);
}

const withFile = (file: string, text: string) => ({ ...BASE, [file]: text });

describe("base fixture", () => {
  it("is clean", () => {
    expect(codes(BASE)).toEqual([]);
  });
});

describe("rules", () => {
  it("L01 requires front matter fields, including feature for an FDD", () => {
    const fdd = BASE["fdd/a.md"]!.replace("feature: FEAT-A\n", "").replace("owner: me\n", "");
    expect(codes(withFile("fdd/a.md", fdd))).toContain("L01");
  });

  it("L02 requires IDs on spec headings and acceptance criteria", () => {
    expect(codes(withFile("prd/prd.md", `${BASE["prd/prd.md"]}\n### 이름 없는 기능\n`))).toEqual(["L02"]);
  });

  it("L03 rejects references to missing or deprecated elements", () => {
    const missing = BASE["fdd/a.md"]!.replace("- 정책: [[RULE-PW-001]]", "- 정책: [[RULE-PW-009]]");
    expect(codes(withFile("fdd/a.md", missing))).toContain("L03");

    const deprecated = BASE["prd/policies/pw.md"]!.replace("- 최소 길이: 8자", "- 최소 길이: 8자\n- 상태: deprecated");
    expect(codes(withFile("prd/policies/pw.md", deprecated))).toContain("L03");
  });

  it("L04 and L07 report a policy defined twice with different values", () => {
    const twice = `${BASE["prd/policies/pw.md"]}\n### RULE-PW-001 비밀번호 (다시)\n- 최소 길이: 10자\n`;
    expect(codes(withFile("prd/policies/pw.md", twice))).toEqual(["L04", "L07"]);
  });

  it("L05 rejects IDs that disappeared since the base version", () => {
    const current = withFile("prd/prd.md", BASE["prd/prd.md"]!);
    const base = withFile("prd/prd.md", `${BASE["prd/prd.md"]}\n### FEAT-B 기능 B\n- 설명: b\n`);
    expect(codes(current, base)).toEqual(["L05"]);
  });

  it("L06 requires acceptance criteria on every requirement", () => {
    const fdd = `${BASE["fdd/a.md"]}\n### REQ-A-002 요구 A2\n- 노출: 없음\n`;
    expect(codes(withFile("fdd/a.md", fdd))).toEqual(["L06"]);
  });

  it("L08 flags expressions the glossary says to avoid", () => {
    const files = {
      ...BASE,
      "glossary.md": `${header("prd")}### TERM-MEMBER 회원\n- 피할 표현: 유저\n`,
      "prd/prd.md": `${header("prd")}### FEAT-A 기능 A\n- 설명: 유저가 쓴다\n`,
    };
    expect(codes(files)).toEqual(["L08"]);
  });

  it("L10 rejects elements in the wrong stage and references that point down a stage", () => {
    // A requirement written in an IA document, then referenced from the FDD.
    const ia = `${BASE["ia/screens.md"]}\n### REQ-Z-001 잘못 둔 요구사항\n- 인수 조건:\n  - AC-Z-001-01: z\n`;
    const fdd = BASE["fdd/a.md"]!.replace("- 정책: [[RULE-PW-001]]", "- 정책: [[RULE-PW-001]]\n- 의존: [[REQ-Z-001]]");
    const found = lint(snapshotOf({ ...BASE, "ia/screens.md": ia, "fdd/a.md": fdd }), { schema }).findings;
    const l10 = found.filter((f) => f.code === "L10").map((f) => f.message);
    // REQ-Z-001 is misplaced, and the FDD points down at it. (Its "인수 조건" means nothing in an IA document.)
    expect(l10).toHaveLength(2);
    expect(l10.join("\n")).toContain("FDD → IA REQ-Z-001");
    // The IA pointing up at the FDD (BASE) is the normal direction.
    expect(codes(BASE)).not.toContain("L10");
  });

  it("L11 wants every requirement placed on a screen unless marked", () => {
    const screens = BASE["ia/screens.md"]!.replace("- 요구사항: [[REQ-A-001]]\n", "");
    expect(codes(withFile("ia/screens.md", screens))).toEqual(["L11"]);
    const marked = BASE["fdd/a.md"]!.replace("- 정책:", "- 노출: 없음\n- 정책:");
    expect(codes({ ...withFile("ia/screens.md", screens), "fdd/a.md": marked })).toEqual([]);
  });

  it("L12 wants an FDD for every feature", () => {
    expect(codes(withFile("prd/prd.md", `${BASE["prd/prd.md"]}\n### FEAT-B 기능 B\n- 설명: b\n`))).toEqual(["L12"]);
  });

  it("L13 compares the sitemap with each screen's parent", () => {
    const moved = BASE["ia/sitemap.md"]!.replace("  - A [[SCR-A]]", "- A [[SCR-A]]");
    expect(codes(withFile("ia/sitemap.md", moved))).toEqual(["L13"]);
    const unlisted = `${BASE["ia/screens.md"]}\n### SCR-B 화면 B\n- 상위: [[SCR-HOME]]\n`;
    expect(codes(withFile("ia/screens.md", unlisted))).toEqual(["L13"]);
  });

  it("L14 checks cited values against the policy", () => {
    const changed = BASE["prd/policies/pw.md"]!.replace("8자", "10자");
    expect(codes(withFile("prd/policies/pw.md", changed))).toEqual(["L14"]);
    const unknownItem = BASE["fdd/a.md"]!.replace("(RULE-PW-001 최소 길이)", "(RULE-PW-001 최대 길이)");
    expect(codes(withFile("fdd/a.md", unknownItem))).toEqual(["L14"]);
  });

  describe("feature dependencies", () => {
    const twoFeatures = {
      ...BASE,
      "prd/prd.md": `${header("prd")}### FEAT-A 기능 A\n- 설명: a\n\n### FEAT-B 기능 B\n- 설명: b\n`,
      "fdd/b.md": `${header("fdd", "feature: FEAT-B\n")}### REQ-B-001 요구 B\n- 노출: 없음\n- 인수 조건:\n  - AC-B-001-01: b\n`,
    };
    const prdWith = (deps: string) =>
      `${header("prd")}### FEAT-A 기능 A\n- 설명: a\n\n### FEAT-B 기능 B\n- 의존: ${deps}\n`;

    it("L16 requires a PRD feature dependency for cross-feature requirement dependencies", () => {
      const fdd = twoFeatures["fdd/b.md"].replace("- 노출: 없음", "- 노출: 없음\n- 의존: [[REQ-A-001]]");
      expect(codes({ ...twoFeatures, "fdd/b.md": fdd })).toEqual(["L16"]);
      expect(codes({ ...twoFeatures, "fdd/b.md": fdd, "prd/prd.md": prdWith("[[FEAT-A]]") })).toEqual([]);
    });

    it("L17 warns about a feature dependency without requirement evidence", () => {
      expect(codes({ ...twoFeatures, "prd/prd.md": prdWith("[[FEAT-A]]") })).toEqual(["L17"]);
    });

    it("L18 warns about dependency cycles once", () => {
      const prd = `${header("prd")}### FEAT-A 기능 A\n- 의존: [[FEAT-B]]\n\n### FEAT-B 기능 B\n- 의존: [[FEAT-A]]\n`;
      const result = lint(snapshotOf({ ...twoFeatures, "prd/prd.md": prd }), { schema });
      const cycles = result.findings.filter((f) => f.code === "L18");
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.message).toContain("FEAT-A → FEAT-B → FEAT-A");
    });
  });

  it("uses the severity declared for each rule", () => {
    const result = lint(snapshotOf(withFile("prd/prd.md", `${BASE["prd/prd.md"]}\n### FEAT-B 기능 B\n- 설명: b\n`)), {
      schema,
    });
    expect(result).toMatchObject({ errors: 0, warnings: 1 });
    expect(RULES.L12!.severity).toBe("warning");
  });
});

describe("DEMO and the password-policy scenario", () => {
  const lintOf = (roots: string[]) => lint(parseSpecs(roots, options), { schema, previous: parseSpecs(SPECS, options) });

  it("DEMO specs are clean", () => {
    expect(lintOf([SPECS]).findings).toEqual([]);
  });

  it("step 1: changing only the policy is blocked by the stale citation (L14)", () => {
    const policyOnly = mkdtempSync(join(tmpdir(), "specflow-step1-"));
    cpSync(join(SCENARIO, "prd"), join(policyOnly, "prd"), { recursive: true });
    const result = lintOf([SPECS, policyOnly]);
    expect(result.findings).toMatchObject([{ code: "L14", element: "AC-SIGNUP-002-01", source: { file: "fdd/signup.md" } }]);
  });

  it("step 2: after the cascaded FDD edit the snapshot rules pass (L09 is checked in M4)", () => {
    expect(lintOf([SPECS, SCENARIO]).findings).toEqual([]);
  });
});
