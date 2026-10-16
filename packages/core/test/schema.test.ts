import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSchemaFile, parseSchema, SchemaError } from "../src/index.ts";

const SCHEMA_PATH = fileURLToPath(new URL("../../../schema/schema.yaml", import.meta.url));

describe("schema/schema.yaml", () => {
  const schema = loadSchemaFile(SCHEMA_PATH);

  it("defines the spec element types per document stage", () => {
    const levels = (name: string) => schema.nodeTypes.get(name)?.docLevels;
    expect(levels("Feature")).toEqual(["prd"]);
    expect(levels("Requirement")).toEqual(["fdd"]);
    expect(levels("BusinessRule")).toEqual(["prd", "fdd"]);
    expect(levels("Screen")).toEqual(["ia"]);
  });

  it("reads propagation rules, weights, and depth limits", () => {
    expect(schema.relations.get("GOVERNED_BY")).toMatchObject({
      from: ["Requirement"],
      to: ["BusinessRule"],
      propagate: "reverse",
      weight: "high",
    });
    expect(schema.relations.get("DEPENDS_ON")).toMatchObject({ weight: "medium", maxDepth: 1 });
    expect(schema.relations.get("FEATURE_DEPENDS_ON")?.propagate).toBe("none");
  });

  it("expands the *spec wildcard to every spec-domain node type", () => {
    const from = schema.relations.get("CITES")?.from ?? [];
    expect(from).toContain("Requirement");
    expect(from).toContain("Screen");
    expect(from).not.toContain("DesignFrame");
  });

  it("marks traceability relations", () => {
    const traced = [...schema.relations.values()].filter((r) => r.traceability).map((r) => r.name);
    expect(traced.sort()).toEqual(["IMPLEMENTS", "REALIZES", "REALIZES_DATA", "VERIFIES"]);
  });

  it("maps field labels and citations per stage", () => {
    expect(schema.fieldLabels.get("fdd")?.get("Requirement")?.get("정책")).toBe("GOVERNED_BY");
    expect(schema.fieldLabels.get("ia")?.get("Screen")?.get("요구사항")).toBe("APPEARS_ON");
    expect(schema.fieldLabels.get("prd")?.get("BusinessRule")?.get("*")).toBe("value");
    expect(schema.citations).toEqual([{ docLevel: "fdd", pattern: "(RULE-ID 항목)", relation: "CITES" }]);
  });

  it("lists sync relations and storage constraints", () => {
    expect(schema.syncRelations).toContain("CITES");
    expect(schema.uniqueProps).toEqual(["uid"]);
    expect(schema.indexes).toEqual(["project", "type", "status"]);
  });
});

describe("parseSchema validation", () => {
  const base = `
version: 1
node_types:
  Requirement: { id_prefix: REQ, domain: spec, doc_level: fdd }
relations:
  DEPENDS_ON: { from: Requirement, to: Requirement, propagate: reverse }
field_labels: {}
`;

  it("accepts a minimal valid schema", () => {
    expect(parseSchema(base).relations.size).toBe(1);
  });

  it("reports every problem at once", () => {
    const broken = base
      .replace("to: Requirement", "to: Screen")
      .replace("propagate: reverse", "propagate: sideways")
      .replace("field_labels: {}", 'field_labels:\n  fdd:\n    Requirement: { "의존": DEPENDS_ON_TYPO }');
    try {
      parseSchema(broken);
      expect.unreachable("parseSchema should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      const problems = (error as SchemaError).problems;
      expect(problems).toHaveLength(3);
      expect(problems.join("\n")).toMatch(/unknown node type "Screen"/);
      expect(problems.join("\n")).toMatch(/propagate must be one of/);
      expect(problems.join("\n")).toMatch(/unknown relation or attribute "DEPENDS_ON_TYPO"/);
    }
  });
});
