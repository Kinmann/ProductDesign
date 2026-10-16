#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadSchemaFile, type GraphSnapshot } from "@specflow/core";
import { parseSpecs } from "@specflow/parser";

const DEFAULT_SCHEMA = fileURLToPath(new URL("../../../schema/schema.yaml", import.meta.url));

const USAGE = `사용법: specflow <명령> [옵션]

명령
  parse <specs 폴더>    기획서를 읽어 그래프 스냅샷(JSON)을 출력한다

옵션
  --project <키>        프로젝트 키 (필수, 예: DEMO)
  --overlay <폴더>      specs 위에 덮어쓸 폴더. 여러 번 줄 수 있다
  --schema <파일>       온톨로지 스키마 (기본: schema/schema.yaml)
  --summary             JSON 대신 요소·관계 개수와 문제 목록을 출력한다
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      overlay: { type: "string", multiple: true, default: [] },
      schema: { type: "string", default: DEFAULT_SCHEMA },
      summary: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, specsDir] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }
  if (command !== "parse") return fail(`알 수 없는 명령입니다: ${command}`);
  if (!specsDir) return fail("specs 폴더를 지정해주세요.");
  if (!values.project) return fail("--project로 프로젝트 키를 지정해주세요.");

  const schema = loadSchemaFile(values.schema);
  const snapshot = parseSpecs([specsDir, ...values.overlay], { project: values.project, schema });
  process.stdout.write(values.summary ? summarize(snapshot) : `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot.issues.some((i) => i.severity === "error") ? 2 : 0;
}

function summarize(snapshot: GraphSnapshot): string {
  const count = (keys: string[]) =>
    Object.entries(keys.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {}))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `  ${k.padEnd(20)} ${n}`)
      .join("\n");
  const issues = snapshot.issues.map(
    (i) => `  [${i.code}] ${i.severity} ${i.source.file}:${i.source.line} ${i.message}`,
  );
  return [
    `프로젝트 ${snapshot.project} · 문서 ${snapshot.documents.length}개`,
    `기획 요소 ${snapshot.nodes.length}개`,
    count(snapshot.nodes.map((n) => n.type)),
    `관계 ${snapshot.edges.length}개`,
    count(snapshot.edges.map((e) => e.type)),
    `문제 ${snapshot.issues.length}건`,
    ...issues,
    "",
  ].join("\n");
}

function fail(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
