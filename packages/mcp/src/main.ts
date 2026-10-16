#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadSchemaFile } from "@specflow/core";
import { Neo4jStore, neo4jConfigFromEnv } from "@specflow/store";
import { createOntologyServer } from "./server.ts";

// Started by an MCP client over stdio: stdout carries the protocol, so logs go to stderr only.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      schema: { type: "string", default: `${ROOT}schema/schema.yaml` },
    },
  });
  const project = values.project ?? process.env.SPECFLOW_PROJECT;
  if (!project || !PROJECT_KEY.test(project)) {
    throw new Error("--project <키>(또는 SPECFLOW_PROJECT)로 이 세션의 프로젝트를 지정해주세요.");
  }
  if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
  const config = neo4jConfigFromEnv();
  if (!config) throw new Error(".env에 NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD를 넣어주세요.");

  const store = new Neo4jStore(config);
  await store.verifyConnectivity();
  const server = createOntologyServer({ store, schema: loadSchemaFile(values.schema), project });
  const close = async () => {
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`specflow-ontology MCP 서버 시작: 프로젝트 ${project}\n`);
}

main().catch((e) => {
  process.stderr.write(`specflow-ontology MCP 서버를 시작하지 못했습니다: ${(e as Error).message}\n`);
  process.exit(1);
});
