#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadSchemaFile, type GraphSnapshot } from "@specflow/core";
import { renderImpactMarkdown } from "@specflow/impact";
import { lint, type LintResult } from "@specflow/lint";
import { parseSpecs } from "@specflow/parser";
import {
  addReview,
  defaultReviewsPath,
  Neo4jStore,
  neo4jConfigFromEnv,
  type ChangeSet,
  type GraphStore,
} from "@specflow/store";
import { runImpactPreview, runImpactRecorded, runIngest, runLink } from "./workflow.ts";

const DEFAULT_SCHEMA = fileURLToPath(new URL("../../../schema/schema.yaml", import.meta.url));

const USAGE = `사용법: specflow <명령> [옵션]

명령
  parse <specs 폴더>     기획서를 읽어 그래프 스냅샷(JSON)을 출력한다
  lint <specs 폴더>      정합성 규칙을 검사한다. --db를 주면 저장소와 비교해 L05·L09도 검사한다
  ingest <specs 폴더>    기획서를 Neo4j에 반영한다. Error가 있으면 반영하지 않는다
  impact <specs 폴더>    기획 변경의 영향도를 분석한다 (반영 전 미리보기). --changeset이면 반영된 변경을 분석한다
  link <links.yaml>      산출물과 기획 요소의 연결을 등록한다
  review <요소 ID>       상위 요소가 바뀐 하위 요소를 "변경 없음"으로 확인한다 (L09)
  reset                  프로젝트의 저장 데이터를 모두 지운다 (--yes 필요)

옵션
  --project <키>         프로젝트 키 (예: DEMO). link는 links.yaml의 project를 쓴다
  --overlay <폴더>       specs 위에 덮어쓸 폴더. 여러 번 줄 수 있다
  --schema <파일>        온톨로지 스키마 (기본: schema/schema.yaml)
  --summary              parse: JSON 대신 개수와 문제 목록을 출력한다
  --base <폴더>          lint: 비교할 이전 버전 specs 폴더 (L05)
  --db                   lint: Neo4j 저장소와 비교한다 (L05, L09)
  --json                 lint·ingest·impact: 결과를 JSON으로 출력한다
  --changeset <ID>       impact: 반영된 ChangeSet (예: CS-0002, latest)
  --dry-run              ingest·link: 반영하지 않고 계획만 보여준다
  --reviews <파일>       확인 기록 파일 (기본: <specs>/.specflow/reviews.yaml)
  --upper <요소 ID>      review: 바뀐 상위 요소
  --note <글>            review: 확인 메모
  --specs <폴더>         review: specs 폴더 (필수)
  --yes                  reset: 확인

Neo4j 접속 정보는 .env의 NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD(, NEO4J_DATABASE)에서 읽는다.
`;

const COMMANDS = ["parse", "lint", "ingest", "impact", "link", "review", "reset"];

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      overlay: { type: "string", multiple: true, default: [] },
      schema: { type: "string", default: DEFAULT_SCHEMA },
      summary: { type: "boolean", default: false },
      base: { type: "string" },
      db: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      reviews: { type: "string" },
      upper: { type: "string" },
      note: { type: "string" },
      specs: { type: "string" },
      changeset: { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }
  if (!COMMANDS.includes(command)) return fail(`알 수 없는 명령입니다: ${command}`);
  const schema = loadSchemaFile(values.schema);

  if (command === "link") {
    if (!target) return fail("links.yaml 경로를 지정해주세요.");
    return withStore(async (store) => {
      const { plan, applied } = await runLink(store, target, schema, values["dry-run"]);
      for (const problem of plan.problems) process.stdout.write(`Error  ${problem}\n`);
      process.stdout.write(
        `${applied ? "등록했습니다" : "등록하지 않았습니다"}: 산출물 ${plan.elements.length}개, 연결 ${plan.edges.length}개, 제거 ${plan.removedEdges.length}개\n`,
      );
      return plan.problems.length > 0 ? 2 : 0;
    });
  }

  if (!values.project) return fail("--project로 프로젝트 키를 지정해주세요.");
  const project = values.project;

  if (command === "reset") {
    if (!values.yes) return fail(`프로젝트 ${project}의 저장 데이터를 모두 지웁니다. 계속하려면 --yes를 붙이세요.`);
    return withStore(async (store) => {
      await store.deleteProject(project);
      process.stdout.write(`프로젝트 ${project}의 저장 데이터를 지웠습니다.\n`);
      return 0;
    });
  }

  if (command === "impact" && values.changeset) {
    const id = values.changeset === "latest" ? undefined : values.changeset;
    return withStore(async (store) => {
      const report = await runImpactRecorded(store, project, schema, id);
      if (!report) return fail(`ChangeSet이 없습니다: ${values.changeset}`);
      process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderImpactMarkdown(report));
      return 0;
    });
  }

  if (command === "review") {
    const specsDir = values.specs;
    if (!target || !values.upper || !specsDir) return fail("review <요소 ID> --upper <요소 ID> --specs <폴더>가 필요합니다.");
    const snapshot = parseSpecs([specsDir, ...values.overlay], { project, schema });
    const upper = snapshot.nodes.find((n) => n.id === values.upper);
    if (!snapshot.nodes.some((n) => n.id === target)) return fail(`요소가 없습니다: ${target}`);
    if (!upper) return fail(`상위 요소가 없습니다: ${values.upper}`);
    const path = values.reviews ?? defaultReviewsPath(specsDir);
    addReview(path, { element: target, upper: upper.id, upperHash: upper.contentHash, ...(values.note && { note: values.note }) });
    process.stdout.write(`확인을 기록했습니다: ${target} ← ${upper.id} (${path})\n`);
    return 0;
  }

  if (!target) return fail("specs 폴더를 지정해주세요.");
  const roots = [target, ...values.overlay];
  const reviewsPath = values.reviews ?? defaultReviewsPath(target);

  if (command === "parse") {
    const snapshot = parseSpecs(roots, { project, schema });
    process.stdout.write(values.summary ? summarize(snapshot) : `${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot.issues.some((i) => i.severity === "error") ? 2 : 0;
  }

  if (command === "lint" && !values.db) {
    const snapshot = parseSpecs(roots, { project, schema });
    const previous = values.base ? parseSpecs(values.base, { project, schema }) : undefined;
    const result = lint(snapshot, { schema, ...(previous && { previous }) });
    process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : formatLint(result));
    return result.errors > 0 ? 2 : 0;
  }

  if (command === "impact") {
    return withStore(async (store) => {
      const { outcome, report } = await runImpactPreview({ roots, project, schema, store, reviewsPath });
      if (!report) {
        process.stdout.write("저장된 기획과 비교해 바뀐 요소가 없습니다.\n");
        return 0;
      }
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ report, lint: outcome.lint }, null, 2)}\n`);
      } else {
        process.stdout.write(renderImpactMarkdown(report, { preview: true }));
        if (outcome.lint.errors > 0) {
          process.stdout.write(`\n> 린트 Error ${outcome.lint.errors}건이 있어 아직 반영할 수 없습니다. specflow lint --db로 확인하세요.\n`);
        }
      }
      return 0;
    });
  }

  // lint --db and ingest share the same plan; lint never writes.
  const dryRun = command === "lint" || values["dry-run"];
  return withStore(async (store) => {
    const outcome = await runIngest({ roots, project, schema, store, reviewsPath, dryRun });
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ changeSet: outcome.plan.changeSet, lint: outcome.lint, applied: outcome.applied }, null, 2)}\n`);
    } else {
      if (command === "ingest") process.stdout.write(formatChangeSet(outcome.plan.changeSet));
      process.stdout.write(formatLint(outcome.lint));
      if (command === "ingest") {
        process.stdout.write(
          outcome.applied
            ? `반영했습니다 (${outcome.plan.specVersion}).\n`
            : dryRun
              ? "반영하지 않았습니다 (--dry-run).\n"
              : "Error가 있어 반영하지 않았습니다.\n",
        );
      }
    }
    return outcome.lint.errors > 0 ? 2 : 0;
  });
}

async function withStore(work: (store: GraphStore) => Promise<number>): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = neo4jConfigFromEnv();
  if (!config) return fail(".env에 NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD를 넣어주세요.");
  const store = new Neo4jStore(config);
  try {
    await store.verifyConnectivity();
    await store.ensureSchema();
    return await work(store);
  } catch (error) {
    process.stderr.write(`Neo4j 작업이 실패했습니다: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await store.close();
  }
}

function formatChangeSet(changeSet: ChangeSet | undefined): string {
  if (!changeSet) return "바뀐 기획 요소가 없습니다.\n";
  const rows = changeSet.changes.map((c) => {
    const version = c.version.from === null ? `신규 v${c.version.to}` : `v${c.version.from} → v${c.version.to}`;
    return `  ${c.id.padEnd(20)} ${c.op.padEnd(10)} ${c.changeType.padEnd(12)} ${version}`;
  });
  return [`${changeSet.id} · ${changeSet.specVersion} · 변경 ${changeSet.changes.length}건`, ...rows, ""].join("\n");
}

function formatLint(result: LintResult): string {
  const lines = result.findings.map(
    (f) => `${f.source.file}:${f.source.line}  ${f.severity === "error" ? "Error  " : "Warning"}  ${f.code}  ${f.message}`,
  );
  return [...lines, `Error ${result.errors}건 · Warning ${result.warnings}건`, ""].join("\n");
}

function summarize(snapshot: GraphSnapshot): string {
  const count = (keys: string[]) =>
    Object.entries(keys.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {}))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `  ${k.padEnd(20)} ${n}`)
      .join("\n");
  const issues = snapshot.issues.map((i) => `  [${i.code}] ${i.severity} ${i.source.file}:${i.source.line} ${i.message}`);
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

process.exitCode = await main(process.argv.slice(2));
