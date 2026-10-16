import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReadQueryResult } from "@specflow/store";
import { z } from "zod";
import { checkQuery, QUERY_LIMITS, scopeProblems } from "./query.ts";
import {
  analyzeChangeSet,
  getElement,
  getSchema,
  getSyncStatus,
  getTrace,
  scopeOf,
  searchElements,
  type ToolContext,
} from "./tools.ts";

/** A store that can run scoped read-only Cypher (the Neo4j store). */
interface QueryableStore {
  readQuery(
    cypher: string,
    params: Record<string, unknown>,
    options: { allowedProjects: string[]; timeoutMs: number; maxRows: number },
  ): Promise<ReadQueryResult>;
}

function canQuery(store: unknown): store is QueryableStore {
  return typeof (store as Partial<QueryableStore>).readQuery === "function";
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * Ontology MCP server (PRD 5.7, IMPLEMENTATION_PLAN M6). Read tools only; every call is limited to the
 * session's project and the shared library. Writes stay in the CLI (ingest, link) until later phases.
 */
export function createOntologyServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "specflow-ontology", version: "0.1.0" },
    {
      instructions:
        `기획 온톨로지(PRD → FDD → IA와 디자인·개발·QA 산출물)를 조회한다. 이 세션의 프로젝트는 ${ctx.project}이고, ` +
        `${scopeOf(ctx).join(", ")} 프로젝트만 볼 수 있다. 처음이면 get_schema로 구조를 확인하고, ` +
        "기획 원문을 추측하지 말고 get_element·get_trace로 근거를 조회해 답한다.",
    },
  );

  server.registerTool(
    "get_schema",
    {
      title: "온톨로지 스키마",
      description: "노드 타입, 관계 타입과 전파 규칙, 동기화 관계를 돌려준다. 처음 붙는 에이전트가 구조를 파악할 때 쓴다.",
      annotations: READ_ONLY,
    },
    async () => json(getSchema(ctx)),
  );

  server.registerTool(
    "get_element",
    {
      title: "기획 요소·산출물 조회",
      description: "ID로 기획 요소나 산출물을 조회한다. 내용, 버전, 정책 값, 들어오고 나가는 관계와 동기화 상태를 포함한다.",
      inputSchema: { id: z.string().describe("요소 ID. 예: REQ-SIGNUP-002, shared:RULE-PW-001") },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const element = await getElement(ctx, id);
      return element ? json(element) : error(`요소가 없습니다 (또는 이 세션에서 볼 수 없습니다): ${id}`);
    },
  );

  server.registerTool(
    "search_elements",
    {
      title: "기획 요소 검색",
      description: "ID, 제목, 본문에서 키워드로 찾는다 (공백으로 나눈 단어 중 많이 맞는 순).",
      inputSchema: {
        query: z.string().min(1).describe("검색어. 예: 비밀번호 정책"),
        type: z.string().optional().describe("노드 타입으로 좁히기. 예: Requirement, TestCase"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ query, type, limit }) => json(await searchElements(ctx, query, type, limit)),
  );

  server.registerTool(
    "get_trace",
    {
      title: "연결 그래프 조회",
      description: "요소에서 시작해 관계를 따라 주변 요소와 관계를 돌려준다. 기획 요소의 상하위와 연결된 산출물을 볼 때 쓴다.",
      inputSchema: {
        id: z.string().describe("시작 요소 ID"),
        depth: z.number().int().min(1).max(4).optional().describe("단계 수 (기본 2, 최대 4)"),
        direction: z.enum(["both", "out", "in"]).optional().describe("관계 방향 (기본 both)"),
      },
      annotations: READ_ONLY,
    },
    async ({ id, depth, direction }) => {
      const trace = await getTrace(ctx, id, depth, direction);
      return trace ? json(trace) : error(`요소가 없습니다 (또는 이 세션에서 볼 수 없습니다): ${id}`);
    },
  );

  server.registerTool(
    "get_sync_status",
    {
      title: "동기화 현황",
      description: "최신 기획을 반영하지 않은 산출물과, 상위 단계가 바뀌었는데 검토되지 않은 기획 요소 간 연결을 돌려준다.",
      annotations: READ_ONLY,
    },
    async () => json(await getSyncStatus(ctx)),
  );

  server.registerTool(
    "analyze_impact",
    {
      title: "영향도 분석",
      description:
        "반영된 기획 변경(ChangeSet)이 어떤 디자인·코드·TC에 영향을 주는지 등급과 근거 경로로 돌려준다. 반영 전 변경의 미리보기는 CLI(specflow impact)를 쓴다.",
      inputSchema: { changeset: z.string().optional().describe("ChangeSet ID (예: CS-0002). 비우면 가장 최근 것") },
      annotations: READ_ONLY,
    },
    async ({ changeset }) => {
      const result = await analyzeChangeSet(ctx, changeset);
      if (!result) return error(`ChangeSet이 없습니다: ${changeset ?? "(최근)"}`);
      return { content: [{ type: "text", text: result.markdown }, { type: "text", text: JSON.stringify(result.report, null, 2) }] };
    },
  );

  server.registerTool(
    "query_graph",
    {
      title: "그래프 질의 (읽기 전용)",
      description:
        "정해진 도구로 답할 수 없을 때 쓰는 읽기 전용 Cypher 질의. 모든 MATCH의 노드에 `WHERE n.project IN $scope`를 붙여야 한다 " +
        `($scope는 서버가 넣는다). 쓰기·CALL·관리 구문은 거부한다. 결과는 최대 ${QUERY_LIMITS.maxRows}행, 실행 ${QUERY_LIMITS.timeoutMs / 1000}초 제한. ` +
        "예: MATCH (r:Element {id: 'RULE-PW-001'})<-[:GOVERNED_BY]-(q:Element) WHERE r.project IN $scope AND q.project IN $scope RETURN q.id, q.title",
      inputSchema: {
        cypher: z.string().min(1),
        params: z.record(z.unknown()).optional().describe("질의 파라미터. scope와 project는 서버가 정한다"),
      },
      annotations: READ_ONLY,
    },
    async ({ cypher, params }) => {
      const problems = checkQuery(cypher, params ?? {});
      if (problems.length > 0) return error(problems.join("\n"));
      if (!canQuery(ctx.store)) return error("이 저장소에서는 Cypher 질의를 쓸 수 없습니다 (Neo4j 저장소에서만 가능).");
      try {
        const result = await ctx.store.readQuery(
          cypher,
          { ...params, scope: scopeOf(ctx), project: ctx.project },
          { allowedProjects: scopeOf(ctx), timeoutMs: QUERY_LIMITS.timeoutMs, maxRows: QUERY_LIMITS.maxRows },
        );
        const outside = scopeProblems(result);
        if (outside.length > 0) return error(outside.join("\n"));
        return json({ columns: result.columns, rows: result.rows, truncated: result.truncated });
      } catch (e) {
        return error(`질의 실행이 실패했습니다: ${(e as Error).message}`);
      }
    },
  );

  return server;
}
