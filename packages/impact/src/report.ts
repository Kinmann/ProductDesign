import type { Domain, Grade, ImpactItem, ImpactReport, TraceStep } from "./impact.ts";

const DOMAIN_NAMES: Record<Domain, string> = { design: "디자인", dev: "개발", qa: "QA" };
const ACTION_NAMES = { update: "수정", create: "신규", deprecate: "폐기", review: "검토" } as const;
const OP_NAMES = { added: "신규", modified: "수정", deprecated: "폐기" } as const;

/**
 * Trace path as the PRD writes it, arrows following the stored edges:
 * `RULE-PW-001 ←GOVERNED_BY─ REQ-SIGNUP-002 ←IMPLEMENTS─ DSN-SIGNUP-PW`.
 */
export function formatTrace(path: TraceStep[]): string {
  return path
    .map((step, i) => {
      if (i === 0 || !step.relation) return step.id;
      return step.forward ? `─${step.relation}→ ${step.id}` : `←${step.relation}─ ${step.id}`;
    })
    .join(" ");
}

/** Markdown Impact Report (PRD 11.1): change summary, per-domain tables, new work, warnings. */
export function renderImpactMarkdown(report: ImpactReport, options: { preview?: boolean } = {}): string {
  const title = `## Impact Report · ${report.project} ${report.changeSet}${options.preview ? " (미리보기)" : ""}`;
  const changes = [
    `### 변경 요소 ${report.changes.length}개`,
    "",
    "| 요소 | 변경 | 유형 | 버전 |",
    "|---|---|---|---|",
    ...report.changes.map((c) => {
      const version = c.version.from === null ? `신규 v${c.version.to}` : `v${c.version.from} → v${c.version.to}`;
      return `| \`${c.id}\` | ${OP_NAMES[c.op]} | ${c.changeType} | ${version} |`;
    }),
  ];

  const summary = [
    "### 예상 영향",
    "",
    "| 도메인 | High | Medium | Low | 신규 작업 |",
    "|---|---|---|---|---|",
    ...(["design", "dev", "qa"] as Domain[]).map((domain) => {
      const items = report.artifacts.filter((a) => a.domain === domain);
      const count = (grade: Grade) => items.filter((a) => a.grade === grade).length;
      const created = report.newWork.filter((w) => w.domain === domain).length;
      return `| ${DOMAIN_NAMES[domain]} | ${count("High")} | ${count("Medium")} | ${count("Low")} | ${created} |`;
    }),
  ];

  const domains = (["design", "dev", "qa"] as Domain[]).flatMap((domain) => {
    const items = report.artifacts.filter((a) => a.domain === domain);
    if (items.length === 0) return [];
    return [
      `### ${DOMAIN_NAMES[domain]}`,
      "",
      "| 등급 | 산출물 | 작업 | 근거 경로 |",
      "|---|---|---|---|",
      ...items.map((a: ImpactItem) => `| ${a.grade} | \`${a.artifact}\` ${a.title} | ${ACTION_NAMES[a.action]} | ${formatTrace(a.path)} |`),
      "",
    ];
  });

  const newWork =
    report.newWork.length === 0
      ? []
      : [
          "### 신규 작업",
          "",
          "| 도메인 | 기획 요소 | 등급 | 이유 |",
          "|---|---|---|---|",
          ...report.newWork.map((w) => `| ${DOMAIN_NAMES[w.domain]} | \`${w.element}\` | ${w.grade} | ${w.reason} |`),
          "",
        ];

  const warnings = report.warnings.length === 0 ? [] : ["### 경고", "", ...report.warnings.map((w) => `- ${w}`), ""];
  const empty = report.artifacts.length === 0 && report.newWork.length === 0 ? ["영향받는 산출물이 없습니다.", ""] : [];

  return [title, "", ...changes, "", ...summary, "", ...domains, ...newWork, ...warnings, ...empty].join("\n");
}
