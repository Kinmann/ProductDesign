import type { ReadQueryResult } from "@specflow/store";

export const QUERY_LIMITS = { timeoutMs: 5_000, maxRows: 200, maxLength: 4_000 };

/**
 * Clauses and keywords a read-only, project-scoped query must not use. `CALL` is refused as a whole:
 * procedures (db.*, dbms.*, apoc.*) and CALL subqueries could read outside the scope or write.
 */
const FORBIDDEN = [
  "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP", "FOREACH", "LOAD", "CALL",
  "GRANT", "REVOKE", "DENY", "ALTER", "RENAME", "START", "STOP", "USE", "TERMINATE", "SHOW", "ENABLE", "DISABLE",
];

/** Removes string literals, backtick names, and comments so keywords inside them do not count. */
function stripLiterals(cypher: string): string {
  return cypher
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}

/**
 * Static checks before running a `query_graph` request (PRD 5.7, 5.9). Returns problems; empty means allowed.
 * The Neo4j read transaction and the result scope check run as further guards.
 */
export function checkQuery(cypher: string, params: Record<string, unknown> = {}): string[] {
  const problems: string[] = [];
  if (cypher.length > QUERY_LIMITS.maxLength) problems.push(`질의가 너무 깁니다 (${QUERY_LIMITS.maxLength}자 이하)`);
  const code = stripLiterals(cypher);
  const upper = code.toUpperCase();
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`).test(upper)) problems.push(`읽기 전용 질의에서 쓸 수 없는 키워드입니다: ${word}`);
  }
  if (code.includes(";")) problems.push("질의는 하나만 보낼 수 있습니다 (; 금지)");

  const matches = (upper.match(/\bMATCH\b/g) ?? []).length;
  const scoped = (code.match(/\$scope\b/g) ?? []).length;
  if (matches === 0) problems.push("MATCH가 없는 질의는 실행하지 않습니다");
  if (scoped < matches) {
    problems.push(
      `MATCH마다 프로젝트 범위 조건이 필요합니다: 각 MATCH의 노드에 "WHERE n.project IN $scope"를 붙이세요 (MATCH ${matches}개, $scope ${scoped}개)`,
    );
  }
  for (const reserved of ["scope", "project"]) {
    if (reserved in params) problems.push(`$${reserved}는 서버가 정하는 값이라 직접 넘길 수 없습니다`);
  }
  return problems;
}

export function scopeProblems(result: ReadQueryResult): string[] {
  return result.outOfScope.length > 0
    ? [`결과에 이 세션에서 볼 수 없는 프로젝트의 데이터가 있어 결과를 돌려주지 않습니다: ${result.outOfScope.join(", ")}`]
    : [];
}
