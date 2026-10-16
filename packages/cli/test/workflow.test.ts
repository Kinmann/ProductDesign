import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadSchemaFile } from "@specflow/core";
import { parseSpecs } from "@specflow/parser";
import { addReview, MemoryStore, Neo4jStore, neo4jConfigFromEnv, type GraphStore } from "@specflow/store";
import { runIngest, runLink } from "../src/workflow.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEMO = join(ROOT, "examples/demo");
const SPECS = join(DEMO, "specs");
const SCENARIO = join(DEMO, "scenarios/password-policy");
const schema = loadSchemaFile(join(ROOT, "schema/schema.yaml"));
const expected = parse(readFileSync(join(SCENARIO, "expected.yaml"), "utf8"));

if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
const neo4jConfig = neo4jConfigFromEnv();

/** Step 1 overlay: only the policy file of the scenario. */
function policyOnlyOverlay(): string {
  const dir = mkdtempSync(join(tmpdir(), "specflow-policy-only-"));
  cpSync(join(SCENARIO, "specs/prd"), join(dir, "prd"), { recursive: true });
  return dir;
}

type L09 = { rule: string; element: string; upper?: string };
const asExpected = (findings: { code: string; element?: string; message: string }[]): L09[] =>
  findings.map((f) => {
    const upper = /← ([A-Z][A-Z0-9-]+)/.exec(f.message)?.[1];
    return { rule: f.code, element: f.element ?? "", ...(f.code === "L09" && upper && { upper }) };
  });
const sortL = (xs: L09[]) => [...xs].sort((a, b) => `${a.rule}${a.element}`.localeCompare(`${b.rule}${b.element}`));

/** The password-policy scenario (PRD 8.4) end to end, against any store. */
function scenario(name: string, makeStore: () => Promise<{ store: GraphStore; project: string }>) {
  describe(`password-policy scenario on ${name}`, () => {
    let store: GraphStore;
    let project: string;
    const reviewsPath = join(mkdtempSync(join(tmpdir(), "specflow-reviews-")), "reviews.yaml");
    const ingest = (roots: string[], dryRun = false) =>
      runIngest({ roots, project, schema, store, reviewsPath, specVersion: "test", dryRun });

    beforeAll(async () => {
      ({ store, project } = await makeStore());
    });
    afterAll(async () => {
      await store.deleteProject(project);
      await store.close();
    });

    it("ingests the DEMO specs as CS-0001 and registers the artifact links", async () => {
      const first = await ingest([SPECS]);
      expect(first.lint.findings).toEqual([]);
      expect(first.applied).toBe(true);
      expect(first.plan.changeSet).toMatchObject({ id: "CS-0001" });
      expect(first.plan.changeSet?.changes).toHaveLength(29);

      const links = join(mkdtempSync(join(tmpdir(), "specflow-links-")), "links.yaml");
      cpSync(join(DEMO, "links.yaml"), links);
      // The fixture's project key is DEMO; point it at this test's project.
      const text = readFileSync(links, "utf8").replace("project: DEMO", `project: ${project}`);
      writeFileSync(links, text);
      const linked = await runLink(store, links, schema);
      expect(linked.plan.problems).toEqual([]);
      expect(linked.applied).toBe(true);

      const graph = await store.load(project);
      expect([...graph.elements.values()].filter((e) => e.layer === "artifact")).toHaveLength(8);
      expect([...graph.edges.values()].filter((e) => e.layer === "artifact")).toHaveLength(9);
    });

    it("is idempotent: ingesting the same specs again changes nothing", async () => {
      const again = await ingest([SPECS]);
      expect(again.plan.changeSet).toBeUndefined();
      expect(again.plan.removedEdges).toEqual([]);
      expect(again.lint.errors).toBe(0);
    });

    it("step 1: changing only the policy is refused (L14 + L09)", async () => {
      const step1 = await ingest([SPECS, policyOnlyOverlay()]);
      expect(step1.applied).toBe(false);
      expect(sortL(asExpected(step1.lint.findings))).toEqual(sortL(expected.step1_policy_only.lint_errors));
    });

    it("step 2: after the cascaded FDD edit, the unreviewed requirements still block (L09)", async () => {
      const step2 = await ingest([SPECS, join(SCENARIO, "specs")]);
      expect(step2.applied).toBe(false);
      expect(sortL(asExpected(step2.lint.findings))).toEqual(sortL(expected.step2_cascaded.lint_errors));
      const byElement = (a: { element: string }, b: { element: string }) => a.element.localeCompare(b.element);
      const changes = step2.plan.changeSet?.changes.map((c) => ({ element: c.id, op: c.op, change_type: c.changeType }));
      expect(changes?.sort(byElement)).toEqual([...expected.step2_cascaded.changeset].sort(byElement));
    });

    it("step 2: confirming 'no change' lets the ingest through and syncs the links", async () => {
      const after = parseSpecs([SPECS, join(SCENARIO, "specs")], { project, schema });
      const rule = after.nodes.find((n) => n.id === "RULE-PW-001")!;
      for (const { element } of expected.step2_cascaded.lint_errors as L09[]) {
        addReview(reviewsPath, { element, upper: "RULE-PW-001", upperHash: rule.contentHash });
      }
      const step2 = await ingest([SPECS, join(SCENARIO, "specs")]);
      expect(step2.lint.findings).toEqual(expected.step2_cascaded.after_confirming_no_change.lint_errors);
      expect(step2.applied).toBe(true);
      expect(step2.plan.changeSet?.id).toBe("CS-0002");

      const graph = await store.load(project);
      const version = (id: string) => graph.elements.get(`${project}:${id}`)?.version;
      expect([version("RULE-PW-001"), version("AC-SIGNUP-002-01"), version("AC-SIGNUP-002-04"), version("REQ-SIGNUP-002")]).toEqual([2, 2, 1, 1]);

      const synced = (type: string, from: string, to: string) =>
        graph.edges.get(`${type}|${project}:${from}|${project}:${to}`)?.syncedVersion;
      expect(synced("GOVERNED_BY", "REQ-LOGIN-001", "RULE-PW-001")).toBe(2);
      expect(synced("CITES", "AC-SIGNUP-002-01", "RULE-PW-001")).toBe(2);
      // Downstream artifacts still reflect the old spec: this is what impact analysis (M5) works from.
      expect(synced("VERIFIES", "TC-SIGNUP-007", "AC-SIGNUP-002-01")).toBe(1);
    });
  });
}

scenario("the memory store", async () => ({ store: new MemoryStore(), project: "DEMO" }));

describe.skipIf(!neo4jConfig)("Neo4j", () => {
  scenario("Neo4j", async () => {
    const store = new Neo4jStore(neo4jConfig!);
    await store.verifyConnectivity();
    await store.ensureSchema();
    // A throwaway project key so the test never touches real data.
    return { store, project: `ITEST${Date.now().toString(36).toUpperCase()}` };
  });
});
