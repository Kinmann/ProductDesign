import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSchemaFile } from "@specflow/core";
import { parseSpecs } from "@specflow/parser";
import { addReview, MemoryStore, Neo4jStore, neo4jConfigFromEnv, type GraphStore } from "@specflow/store";
import { runIngest, runLink } from "@specflow/cli/workflow";
import { checkQuery, createOntologyServer } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEMO = join(ROOT, "examples/demo");
const SPECS = join(DEMO, "specs");
const OVERLAY = join(DEMO, "scenarios/password-policy/specs");
const schema = loadSchemaFile(join(ROOT, "schema/schema.yaml"));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
const neo4jConfig = neo4jConfigFromEnv();

/** DEMO before and after the password-policy change, plus an unrelated project to prove isolation. */
async function seed(store: GraphStore, project: string, other: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "specflow-mcp-"));
  const links = join(tmp, "links.yaml");
  writeFileSync(links, readFileSync(join(DEMO, "links.yaml"), "utf8").replace("project: DEMO", `project: ${project}`));
  const reviewsPath = join(tmp, "reviews.yaml");
  await runIngest({ roots: [SPECS], project, schema, store, specVersion: "base" });
  await runLink(store, links, schema);
  const rule = parseSpecs([SPECS, OVERLAY], { project, schema }).nodes.find((n) => n.id === "RULE-PW-001")!;
  for (const element of ["REQ-SIGNUP-002", "REQ-LOGIN-001", "REQ-ACCOUNT-004"]) {
    addReview(reviewsPath, { element, upper: "RULE-PW-001", upperHash: rule.contentHash });
  }
  const changed = await runIngest({ roots: [SPECS, OVERLAY], project, schema, store, reviewsPath, specVersion: "pw" });
  expect(changed.applied).toBe(true);
  // Another project with a secret-looking requirement that must stay invisible.
  await runIngest({ roots: [SPECS], project: other, schema, store, specVersion: "other" });
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const data = (r: ToolResult) => JSON.parse(r.content[0]!.text);

function toolSuite(name: string, setup: () => Promise<{ client: Client; store: GraphStore; project: string; other: string; cleanup: () => Promise<void> }>) {
  describe(`Ontology MCP server on ${name}`, () => {
    let client: Client;
    let project: string;
    let other: string;
    let cleanup: () => Promise<void>;
    const call = async (tool: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name: tool, arguments: args })) as ToolResult;

    beforeAll(async () => {
      ({ client, project, other, cleanup } = await setup());
    }, 60_000);
    afterAll(async () => cleanup());

    it("lists the read-only tools", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "analyze_impact", "get_element", "get_schema", "get_sync_status", "get_trace", "query_graph", "search_elements",
      ]);
      expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    });

    it("get_schema tells an agent what it can read", async () => {
      const schemaInfo = data(await call("get_schema"));
      expect(schemaInfo.readableProjects).toEqual([project, "shared"]);
      expect(schemaInfo.relations.find((r: { relation: string }) => r.relation === "GOVERNED_BY")).toMatchObject({ propagate: "reverse", weight: "high" });
    });

    it("get_element returns content, versions, and relations with sync state", async () => {
      const req = data(await call("get_element", { id: "AC-SIGNUP-002-01" }));
      expect(req).toMatchObject({ id: "AC-SIGNUP-002-01", type: "AcceptanceCriteria", version: 2, docLevel: "fdd" });
      expect(req.relations).toContainEqual(
        expect.objectContaining({ relation: "VERIFIES", direction: "in", other: "TC-SIGNUP-007", syncedVersion: 1, upToDate: false }),
      );
      expect(req.relations).toContainEqual(expect.objectContaining({ relation: "CITES", direction: "out", other: "RULE-PW-001", upToDate: true }));
    });

    it("search_elements finds by keyword", async () => {
      const hits = data(await call("search_elements", { query: "비밀번호 정책", type: "BusinessRule" }));
      expect(hits[0]).toMatchObject({ id: "RULE-PW-001", version: 2 });
    });

    it("get_trace walks from a policy to the artifacts", async () => {
      const trace = data(await call("get_trace", { id: "RULE-PW-001", depth: 2, direction: "in" }));
      const ids = trace.nodes.map((n: { id: string }) => n.id);
      expect(ids).toEqual(expect.arrayContaining(["REQ-SIGNUP-002", "DSN-SIGNUP-PW", "CODE-auth/password-validator"]));
    });

    it("get_sync_status shows artifacts behind the spec", async () => {
      const status = data(await call("get_sync_status"));
      expect(status.artifacts).toEqual({ total: 8, inSync: 7, stale: 1 });
      expect(status.staleArtifacts).toMatchObject([{ artifact: "TC-SIGNUP-007", element: "AC-SIGNUP-002-01", syncedVersion: 1, elementVersion: 2 }]);
      expect(status.staleSpecLinks).toEqual([]);
    });

    it("analyze_impact reports the latest ChangeSet", async () => {
      const result = await call("analyze_impact");
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain(`## Impact Report · ${project} CS-0002`);
      expect(text(result)).toContain("| 디자인 | 2 | 1 | 0 | 0 |");
    });

    it("never shows another project's data", async () => {
      expect((await call("get_element", { id: `${other}:REQ-SIGNUP-002` })).isError).toBe(true);
      const hits = data(await call("search_elements", { query: "REQ-SIGNUP-002" }));
      expect(hits.every((h: { project: string }) => h.project === project)).toBe(true);
    });

    it("refuses unsafe graph queries before running them", async () => {
      const writes = await call("query_graph", { cypher: "MATCH (n:Element) WHERE n.project IN $scope SET n.title = 'x'" });
      expect(writes.isError).toBe(true);
      const unscoped = await call("query_graph", { cypher: "MATCH (n:Element) RETURN count(n)" });
      expect(text(unscoped)).toContain("$scope");
    });
  });
}

describe("checkQuery", () => {
  it.each([
    ["MATCH (n:Element) WHERE n.project IN $scope RETURN n.id", []],
    ["MATCH (n:Element) WHERE n.project IN $scope RETURN n.title = 'CREATE'", []],
    ["MATCH (n) RETURN n", ["$scope"]],
    ["MATCH (a) WHERE a.project IN $scope MATCH (b) RETURN b", ["MATCH마다"]],
    ["MATCH (n) WHERE n.project IN $scope DETACH DELETE n", ["DETACH", "DELETE"]],
    ["CALL db.labels()", ["CALL", "MATCH가 없는"]],
    ["MATCH (n) WHERE n.project IN $scope RETURN n; MATCH (m) WHERE m.project IN $scope RETURN m", [";"]],
  ])("%s", (cypher, expected) => {
    const problems = checkQuery(cypher).join("\n");
    if (expected.length === 0) expect(problems).toBe("");
    for (const fragment of expected) expect(problems).toContain(fragment);
  });

  it("does not let callers set the scope", () => {
    expect(checkQuery("MATCH (n) WHERE n.project IN $scope RETURN n", { scope: ["OTHER"] }).join()).toContain("$scope");
  });
});

toolSuite("the memory store", async () => {
  const store = new MemoryStore();
  await seed(store, "DEMO", "OTHER");
  const server = createOntologyServer({ store, schema, project: "DEMO" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, store, project: "DEMO", other: "OTHER", cleanup: async () => client.close() };
});

describe.skipIf(!neo4jConfig)("Neo4j", () => {
  const suffix = Date.now().toString(36).toUpperCase();
  const project = `ITEST${suffix}`;
  const other = `ITESTB${suffix}`;

  // The real entry point over stdio, exactly as Claude Code starts it from .mcp.json.
  toolSuite("Neo4j over stdio", async () => {
    const store = new Neo4jStore(neo4jConfig!);
    await store.ensureSchema();
    await seed(store, project, other);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, "packages/mcp/src/main.ts"), "--project", project],
      cwd: ROOT,
      stderr: "ignore",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    return {
      client,
      store,
      project,
      other,
      cleanup: async () => {
        await client.close();
        await store.deleteProject(project);
        await store.deleteProject(other);
        await store.close();
      },
    };
  });

  describe("query_graph on Neo4j", () => {
    let client: Client;
    let store: Neo4jStore;
    const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "query_graph", arguments: args })) as ToolResult;

    beforeAll(async () => {
      store = new Neo4jStore(neo4jConfig!);
      await seed(store, `${project}Q`, `${other}Q`);
      const server = createOntologyServer({ store, schema, project: `${project}Q` });
      const [a, b] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "test", version: "0" });
      await Promise.all([server.connect(b), client.connect(a)]);
    }, 60_000);
    afterAll(async () => {
      await client.close();
      await store.deleteProject(`${project}Q`);
      await store.deleteProject(`${other}Q`);
      await store.close();
    });

    it("answers a scoped question", async () => {
      const result = await call({
        cypher:
          "MATCH (r:Element {id: 'RULE-PW-001'})<-[:GOVERNED_BY]-(q:Element) WHERE r.project IN $scope AND q.project IN $scope RETURN q.id AS id ORDER BY id",
      });
      expect(result.isError).toBeFalsy();
      expect(data(result).rows).toEqual([["REQ-ACCOUNT-004"], ["REQ-LOGIN-001"], ["REQ-SIGNUP-002"]]);
    });

    it("refuses a result that reaches into another project", async () => {
      // Mentions $scope but escapes it with OR: the result check catches the other project's nodes.
      const result = await call({ cypher: "MATCH (n:Element) WHERE n.project IN $scope OR n.id = 'REQ-SIGNUP-002' RETURN n" });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`${other}Q`);
    });

    it("Neo4j itself rejects writes in the read transaction (second guard)", async () => {
      await expect(
        store.readQuery("CREATE (:Probe)", {}, { allowedProjects: [], timeoutMs: 2000, maxRows: 1 }),
      ).rejects.toThrow();
      const probe = await store.readQuery("MATCH (p:Probe) RETURN count(p) AS n", {}, { allowedProjects: [], timeoutMs: 2000, maxRows: 1 });
      expect(probe.rows).toEqual([[0]]);
    });
  });
});
