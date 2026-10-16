import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadSchemaFile, type Schema } from "../src/index.ts";

// Sanity checks for the DEMO pilot data (examples/demo). The parser (M2) will do this
// properly; until then these checks keep links.yaml and expected.yaml honest.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEMO = join(ROOT, "examples/demo");
const schema = loadSchemaFile(join(ROOT, "schema/schema.yaml"));

interface LinkFile {
  project: string;
  artifacts: { id: string; type: string; links: { relation: string; to: string }[] }[];
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f));
}

/** Element IDs defined by `### ID title` headings and `- AC-…:` criteria lines. */
function definedIds(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const file of markdownFiles(dir)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const heading = /^### ([A-Z]+-[A-Z0-9-]+) /.exec(line);
      const criteria = /^\s+- (AC-[A-Z0-9-]+):/.exec(line);
      const id = heading?.[1] ?? criteria?.[1];
      if (id) ids.add(id);
    }
  }
  return ids;
}

function typeOf(id: string, s: Schema): string | undefined {
  const prefix = id.split("-")[0];
  return [...s.nodeTypes.values()].find((t) => t.idPrefix === prefix)?.name;
}

describe("examples/demo", () => {
  const ids = definedIds(join(DEMO, "specs"));
  const links = parse(readFileSync(join(DEMO, "links.yaml"), "utf8")) as LinkFile;

  it("defines the elements the scenario relies on", () => {
    for (const id of ["FEAT-SIGNUP", "RULE-PW-001", "REQ-SIGNUP-002", "AC-SIGNUP-002-01", "SCR-ACCOUNT-PW"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("references only defined elements", () => {
    for (const file of markdownFiles(join(DEMO, "specs"))) {
      for (const [, ref] of readFileSync(file, "utf8").matchAll(/\[\[([^\]]+)\]\]/g)) {
        expect(ids, `${file} → ${ref}`).toContain(ref);
      }
    }
  });

  it("links artifacts with schema-valid relations to existing elements", () => {
    expect(links.project).toBe("DEMO");
    expect(links.artifacts).toHaveLength(8);
    for (const artifact of links.artifacts) {
      expect(typeOf(artifact.id, schema), artifact.id).toBe(artifact.type);
      for (const link of artifact.links) {
        const relation = schema.relations.get(link.relation);
        expect(relation?.traceability, link.relation).toBe(true);
        expect(relation?.from).toContain(artifact.type);
        expect(ids, `${artifact.id} → ${link.to}`).toContain(link.to);
        expect(relation?.to).toContain(typeOf(link.to, schema));
      }
    }
  });

  it("expects only artifacts and elements that exist after the change", () => {
    const scenario = join(DEMO, "scenarios/password-policy");
    const afterChange = new Set([...ids, ...definedIds(join(scenario, "specs"))]);
    const expected = parse(readFileSync(join(scenario, "expected.yaml"), "utf8"));
    const artifactIds = new Set(links.artifacts.map((a) => a.id));
    const impact = expected.step2_cascaded.impact;

    expect(impact.artifacts).toHaveLength(8);
    for (const item of impact.artifacts as { artifact: string; trace: string[] }[]) {
      expect(artifactIds).toContain(item.artifact);
      expect(item.trace.at(-1)).toBe(item.artifact);
      for (const id of item.trace.slice(0, -1)) expect(afterChange, id).toContain(id);
    }
    for (const item of impact.new_work as { element: string }[]) {
      expect(ids).not.toContain(item.element);
      expect(afterChange).toContain(item.element);
    }
  });
});
