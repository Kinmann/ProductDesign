import {
  DEPRECATED,
  DOC_LEVELS,
  STATUS_FIELD,
  type DocLevel,
  type GraphSnapshot,
  type Schema,
  type SourceRef,
  type SpecDocument,
  type SpecEdge,
  type SpecNode,
  type StaleLink,
} from "@specflow/core";

export type Severity = "error" | "warning";

export interface LintFinding {
  code: string;
  severity: Severity;
  message: string;
  source: SourceRef;
  /** The spec element the finding is about, when there is one. */
  element?: string;
}

export interface LintOptions {
  schema: Schema;
  /** Snapshot of the base version (e.g. main). Enables L05 (IDs must not disappear). */
  previous?: GraphSnapshot;
}

export interface LintResult {
  findings: LintFinding[];
  errors: number;
  warnings: number;
}

/** L09 needs stored versions (see `staleLinkFindings`); L15 needs the Spec Agent (Phase 2). */
export const RULES: Record<string, { severity: Severity; summary: string }> = {
  L01: { severity: "error", summary: "front matter 필수 필드" },
  L02: { severity: "error", summary: "기획 요소는 ID를 가진다" },
  L03: { severity: "error", summary: "참조한 요소가 존재하고 폐기되지 않았다" },
  L04: { severity: "error", summary: "ID 중복 없음" },
  L05: { severity: "error", summary: "기존 ID가 사라지지 않았다" },
  L06: { severity: "error", summary: "요구사항마다 인수 조건 1개 이상" },
  L07: { severity: "error", summary: "같은 정책 항목을 다른 값으로 정의하지 않는다" },
  L08: { severity: "warning", summary: "용어집의 피할 표현을 쓰지 않는다" },
  L09: { severity: "error", summary: "상위 단계 변경 후 하위 요소를 검토했다" },
  L10: { severity: "error", summary: "상위 단계 문서가 하위 단계 요소를 참조하지 않는다" },
  L11: { severity: "warning", summary: "요구사항이 IA 화면에 배치되어 있다" },
  L12: { severity: "warning", summary: "Feature마다 FDD가 있다" },
  L13: { severity: "error", summary: "사이트맵 계층과 화면의 상위 필드가 일치한다" },
  L14: { severity: "error", summary: "출처를 단 값이 정책 값과 일치한다" },
  L16: { severity: "error", summary: "다른 기능 요구사항에 의존하면 PRD에 기능 의존이 있다" },
  L17: { severity: "warning", summary: "기능 의존마다 요구사항 의존 근거가 있다" },
  L18: { severity: "warning", summary: "기능 의존이 순환하지 않는다" },
};

const REQUIRED_FRONT_MATTER = ["id", "doc", "title", "owner", "status", "version"];
/** Requirement field marking that it has no screen: `- 노출: 없음` (PRD 6.2). */
const EXPOSURE_FIELD = "노출";
const NO_EXPOSURE = "없음";
/** Term field listing expressions to avoid, comma separated (PRD 6.3 L08). */
const AVOID_FIELD = "피할 표현";

export function lint(snapshot: GraphSnapshot, options: LintOptions): LintResult {
  const ctx = new Context(snapshot, options);
  const findings = [
    ...snapshot.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message, source: i.source })),
    ...frontMatter(ctx),
    ...references(ctx),
    ...duplicates(ctx),
    ...disappeared(ctx),
    ...acceptanceCriteria(ctx),
    ...avoidedTerms(ctx),
    ...stageDirection(ctx),
    ...placement(ctx),
    ...featureDocuments(ctx),
    ...sitemap(ctx),
    ...citations(ctx),
    ...featureDependencies(ctx),
  ].sort((a, b) => a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line);
  return {
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
}

/** L09: sync links whose upper element changed while the lower one was neither edited nor confirmed. */
export function staleLinkFindings(stale: StaleLink[], nodes: SpecNode[]): LintFinding[] {
  const byUid = new Map(nodes.map((n) => [n.uid, n]));
  return stale.map((link) => {
    const lower = byUid.get(link.lower);
    return {
      code: "L09",
      severity: RULES.L09!.severity,
      message:
        `상위 요소가 바뀌었는데 검토하지 않았습니다: ${idOf(link.lower)} ← ${idOf(link.upper)} ` +
        `(${link.relation}, v${link.syncedVersion} → v${link.upperVersion}). ` +
        `고치거나 "specflow review ${idOf(link.lower)} --upper ${idOf(link.upper)} --specs <폴더> --project <키>"로 변경 없음을 확인하세요`,
      source: lower?.source ?? link.source,
      element: idOf(link.lower),
    };
  });
}

/** Merges extra findings into a result and keeps the counts right. */
export function withFindings(result: LintResult, extra: LintFinding[]): LintResult {
  const findings = [...result.findings, ...extra].sort(
    (a, b) => a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line,
  );
  return {
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
}

class Context {
  readonly nodes: Map<string, SpecNode>;
  readonly documentOf = new Map<string, SpecDocument>();
  readonly snapshot: GraphSnapshot;
  readonly options: LintOptions;

  constructor(snapshot: GraphSnapshot, options: LintOptions) {
    this.snapshot = snapshot;
    this.options = options;
    this.nodes = new Map(snapshot.nodes.map((n) => [n.uid, n]));
    for (const doc of snapshot.documents) for (const uid of doc.elementUids) this.documentOf.set(uid, doc);
  }

  edges(type: string): SpecEdge[] {
    return this.snapshot.edges.filter((e) => e.type === type);
  }

  nodesOf(type: string): SpecNode[] {
    return this.snapshot.nodes.filter((n) => n.type === type);
  }

  isDeprecated(node: SpecNode): boolean {
    return node.attrs[STATUS_FIELD] === DEPRECATED || this.documentOf.get(node.uid)?.frontMatter.status === DEPRECATED;
  }

  /** The element whose own field wrote this edge: the last element starting at or before the edge's line. */
  declarer(edge: SpecEdge): SpecNode | undefined {
    const doc = this.snapshot.documents.find((d) => d.file === edge.source.file);
    let best: SpecNode | undefined;
    for (const uid of doc?.elementUids ?? []) {
      const node = this.nodes.get(uid)!;
      if (node.source.line <= edge.source.line && (!best || node.source.line > best.source.line)) best = node;
    }
    return best && (best.uid === edge.from || best.uid === edge.to) ? best : undefined;
  }

  /** The end of the edge that the declaring document points at. Front-matter edges have no declarer. */
  referencedUid(edge: SpecEdge): string | undefined {
    const declarer = this.declarer(edge);
    if (declarer) return declarer.uid === edge.from ? edge.to : edge.from;
    const outside = [edge.from, edge.to].filter((uid) => this.nodes.get(uid)?.source.file !== edge.source.file);
    return outside.length === 1 ? outside[0] : undefined;
  }

  /** Feature that owns a requirement through HAS_REQUIREMENT. */
  featureOf(requirementUid: string): string | undefined {
    return this.edges("HAS_REQUIREMENT").find((e) => e.to === requirementUid)?.from;
  }

  finding(code: string, message: string, source: SourceRef, element?: string): LintFinding {
    return { code, severity: RULES[code]!.severity, message, source, ...(element && { element }) };
  }
}

function* frontMatter(ctx: Context): Generator<LintFinding> {
  for (const doc of ctx.snapshot.documents) {
    const source = { file: doc.file, line: 1 };
    // A missing or broken front matter is already reported by the parser.
    if (Object.keys(doc.frontMatter).length === 0) continue;
    const missing = REQUIRED_FRONT_MATTER.filter((k) => doc.frontMatter[k] === undefined);
    if (doc.docLevel === "fdd" && doc.frontMatter.feature === undefined) missing.push("feature");
    if (missing.length > 0) yield ctx.finding("L01", `front matter에 필수 필드가 없습니다: ${missing.join(", ")}`, source);
    const level = doc.frontMatter.doc;
    if (level !== undefined && !(DOC_LEVELS as readonly unknown[]).includes(level)) {
      yield ctx.finding("L01", `doc 값은 ${DOC_LEVELS.join(", ")} 중 하나여야 합니다: ${String(level)}`, source);
    }
  }
}

function* references(ctx: Context): Generator<LintFinding> {
  for (const edge of ctx.snapshot.edges) {
    for (const uid of [edge.from, edge.to]) {
      // References to other projects (e.g. shared:) are checked against their own project.
      if (!uid.startsWith(`${ctx.snapshot.project}:`)) continue;
      if (!ctx.nodes.has(uid)) {
        yield ctx.finding("L03", `없는 요소를 참조합니다: ${idOf(uid)} (${edge.type})`, edge.source, idOf(uid));
      }
    }
    const referenced = ctx.nodes.get(ctx.referencedUid(edge) ?? "");
    if (referenced && ctx.isDeprecated(referenced)) {
      yield ctx.finding("L03", `폐기된 요소를 참조합니다: ${referenced.id} (${edge.type})`, edge.source, referenced.id);
    }
  }
}

function* duplicates(ctx: Context): Generator<LintFinding> {
  for (const dup of ctx.snapshot.duplicates) {
    const first = ctx.nodes.get(dup.uid)!;
    yield ctx.finding("L04", `ID가 중복됩니다: ${dup.id} (처음 정의: ${at(first.source)})`, dup.source, dup.id);
    for (const [item, value] of Object.entries(dup.values)) {
      const original = first.values[item];
      if (original !== undefined && normalize(original) !== normalize(value)) {
        yield ctx.finding(
          "L07",
          `같은 정책 항목을 다른 값으로 정의했습니다: ${dup.id} "${item}" — "${value}" ↔ "${original}" (${at(first.source)})`,
          dup.source,
          dup.id,
        );
      }
    }
  }
}

function* disappeared(ctx: Context): Generator<LintFinding> {
  const previous = ctx.options.previous;
  if (!previous) return;
  for (const node of previous.nodes) {
    if (!ctx.nodes.has(node.uid)) {
      yield ctx.finding(
        "L05",
        `기존 요소가 사라졌습니다: ${node.id}. 삭제하지 말고 "- ${STATUS_FIELD}: ${DEPRECATED}"로 폐기하세요`,
        node.source,
        node.id,
      );
    }
  }
}

function* acceptanceCriteria(ctx: Context): Generator<LintFinding> {
  const withCriteria = new Set(ctx.edges("HAS_CRITERIA").map((e) => e.from));
  for (const req of ctx.nodesOf("Requirement")) {
    if (!withCriteria.has(req.uid) && !ctx.isDeprecated(req)) {
      yield ctx.finding("L06", `요구사항에 인수 조건이 없습니다: ${req.id}`, req.source, req.id);
    }
  }
}

function* avoidedTerms(ctx: Context): Generator<LintFinding> {
  const avoid = ctx.nodesOf("Term").flatMap((term) =>
    (term.attrs[AVOID_FIELD] ?? "")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean)
      .map((word) => ({ word, term })),
  );
  if (avoid.length === 0) return;
  for (const node of ctx.snapshot.nodes) {
    if (node.type === "Term") continue;
    const text = [node.title, ...Object.values(node.attrs)].join(" ");
    for (const { word, term } of avoid) {
      if (text.includes(word)) {
        yield ctx.finding("L08", `용어집의 피할 표현을 썼습니다: ${node.id} "${word}" → ${term.title} (${term.id})`, node.source, node.id);
      }
    }
  }
}

function* stageDirection(ctx: Context): Generator<LintFinding> {
  const rank = (level: DocLevel | undefined) => (level ? DOC_LEVELS.indexOf(level) : -1);
  for (const node of ctx.snapshot.nodes) {
    const allowed = ctx.options.schema.nodeTypes.get(node.type)?.docLevels ?? [];
    if (node.docLevel && allowed.length > 0 && !allowed.includes(node.docLevel)) {
      yield ctx.finding(
        "L10",
        `이 단계 문서에 올 수 없는 요소입니다: ${node.id} (${node.type}는 ${allowed.join("·").toUpperCase()}에 작성)`,
        node.source,
        node.id,
      );
    }
  }
  for (const edge of ctx.snapshot.edges) {
    const referenced = ctx.nodes.get(ctx.referencedUid(edge) ?? "");
    if (!referenced) continue;
    const declaringLevel = ctx.snapshot.documents.find((d) => d.file === edge.source.file)?.docLevel;
    if (rank(referenced.docLevel) > rank(declaringLevel)) {
      yield ctx.finding(
        "L10",
        `상위 단계 문서가 하위 단계 요소를 참조합니다: ${declaringLevel?.toUpperCase()} → ${referenced.docLevel?.toUpperCase()} ${referenced.id}`,
        edge.source,
        referenced.id,
      );
    }
  }
}

function* placement(ctx: Context): Generator<LintFinding> {
  const placed = new Set(ctx.edges("APPEARS_ON").map((e) => e.from));
  for (const req of ctx.nodesOf("Requirement")) {
    if (placed.has(req.uid) || req.attrs[EXPOSURE_FIELD] === NO_EXPOSURE || ctx.isDeprecated(req)) continue;
    yield ctx.finding(
      "L11",
      `IA 화면에 배치되지 않은 요구사항입니다: ${req.id}. 화면이 필요 없으면 "- ${EXPOSURE_FIELD}: ${NO_EXPOSURE}"를 적으세요`,
      req.source,
      req.id,
    );
  }
}

function* featureDocuments(ctx: Context): Generator<LintFinding> {
  const described = new Set(
    ctx.snapshot.documents
      .filter((d) => d.docLevel === "fdd" && typeof d.frontMatter.feature === "string")
      .map((d) => `${ctx.snapshot.project}:${d.frontMatter.feature as string}`),
  );
  for (const feature of ctx.nodesOf("Feature")) {
    if (!described.has(feature.uid) && !ctx.isDeprecated(feature)) {
      yield ctx.finding("L12", `FDD가 없는 기능입니다: ${feature.id}`, feature.source, feature.id);
    }
  }
}

function* sitemap(ctx: Context): Generator<LintFinding> {
  if (ctx.snapshot.sitemap.length === 0) return;
  const declared = new Map(ctx.edges("CHILD_OF").map((e) => [e.from, e]));
  const listed = new Set<string>();
  for (const entry of ctx.snapshot.sitemap) {
    listed.add(entry.screen);
    const edge = declared.get(entry.screen);
    const parent = edge?.to;
    if (parent !== entry.parent) {
      const want = entry.parent ? idOf(entry.parent) : "없음(최상위)";
      const have = parent ? idOf(parent) : "없음";
      yield ctx.finding(
        "L13",
        `사이트맵과 화면 정의의 상위 화면이 다릅니다: ${idOf(entry.screen)} — 사이트맵 ${want}, 화면 정의 ${have}`,
        edge?.source ?? entry.source,
        idOf(entry.screen),
      );
    }
  }
  for (const screen of ctx.nodesOf("Screen")) {
    if (!listed.has(screen.uid) && !ctx.isDeprecated(screen)) {
      yield ctx.finding("L13", `사이트맵에 없는 화면입니다: ${screen.id}`, screen.source, screen.id);
    }
  }
}

function* citations(ctx: Context): Generator<LintFinding> {
  for (const edge of ctx.edges("CITES")) {
    const rule = ctx.nodes.get(edge.to);
    const citing = idOf(edge.from);
    if (!rule) continue; // reported by L03
    const item = String(edge.props.item);
    const value = rule.values[item];
    if (value === undefined) {
      const items = Object.keys(rule.values).join(", ") || "없음";
      yield ctx.finding("L14", `정책에 없는 항목을 인용했습니다: ${citing} → ${rule.id} "${item}" (정책 항목: ${items})`, edge.source, citing);
    } else if (!normalize(String(edge.props.text)).includes(normalize(value))) {
      yield ctx.finding(
        "L14",
        `인용한 값이 정책과 다릅니다: ${citing} → ${rule.id} "${item}" (현재 정책 값: ${value})`,
        edge.source,
        citing,
      );
    }
  }
}

function* featureDependencies(ctx: Context): Generator<LintFinding> {
  const featureDeps = ctx.edges("FEATURE_DEPENDS_ON");
  const declared = new Set(featureDeps.map((e) => `${e.from}|${e.to}`));
  const evidenced = new Set<string>();

  for (const edge of ctx.edges("DEPENDS_ON")) {
    const from = ctx.featureOf(edge.from);
    const to = ctx.featureOf(edge.to);
    if (!from || !to || from === to) continue;
    evidenced.add(`${from}|${to}`);
    if (!declared.has(`${from}|${to}`)) {
      yield ctx.finding(
        "L16",
        `PRD에 없는 기능 의존입니다: ${idOf(edge.from)} → ${idOf(edge.to)} (PRD에 ${idOf(from)} → ${idOf(to)} 의존 필요)`,
        edge.source,
        idOf(edge.from),
      );
    }
  }

  for (const edge of featureDeps) {
    if (!evidenced.has(`${edge.from}|${edge.to}`)) {
      yield ctx.finding(
        "L17",
        `FDD에 근거가 없는 기능 의존입니다: ${idOf(edge.from)} → ${idOf(edge.to)}`,
        edge.source,
        idOf(edge.from),
      );
    }
  }

  for (const cycle of findCycles(featureDeps)) {
    const first = featureDeps.find((e) => e.from === cycle[0] && e.to === cycle[1])!;
    yield ctx.finding("L18", `기능 의존이 순환합니다: ${cycle.map(idOf).join(" → ")}`, first.source, idOf(cycle[0]!));
  }
}

/** Each elementary cycle once, starting from its smallest uid. */
function findCycles(edges: SpecEdge[]): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const cycles = new Map<string, string[]>();
  const walk = (start: string, at: string, path: string[]) => {
    for (const to of next.get(at) ?? []) {
      if (to === start) {
        const cycle = [...path, start];
        const key = [...new Set(cycle)].sort().join("|");
        if (!cycles.has(key) && path.every((p) => p >= start)) cycles.set(key, cycle);
      } else if (!path.includes(to)) {
        walk(start, to, [...path, to]);
      }
    }
  };
  for (const start of [...next.keys()].sort()) walk(start, start, [start]);
  return [...cycles.values()];
}

function idOf(uid: string): string {
  return uid.slice(uid.indexOf(":") + 1);
}

function at(source: SourceRef): string {
  return `${source.file}:${source.line}`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, "");
}
