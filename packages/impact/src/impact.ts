import type { RelationDef, Schema } from "@specflow/core";
import type { ChangeSet, ChangeType, ElementChange, StoredEdge, StoredGraph } from "@specflow/store";

export type Grade = "High" | "Medium" | "Low";
export type Action = "update" | "create" | "deprecate" | "review";
export type Domain = "design" | "dev" | "qa";

/** One hop of a trace path. `forward` when the stored edge points from the previous element to this one. */
export interface TraceStep {
  id: string;
  relation?: string;
  forward?: boolean;
}

export interface ImpactItem {
  domain: Domain;
  artifact: string;
  title: string;
  source: string;
  grade: Grade;
  action: Action;
  /** Hops between the changed element and the element the artifact is linked to (PRD 부록 B). */
  distance: number;
  origin: string;
  changeType: ChangeType;
  /** IDs from the changed element to the artifact; `path` adds the relations. */
  trace: string[];
  path: TraceStep[];
}

export interface NewWorkItem {
  domain: Domain;
  element: string;
  action: "create";
  grade: Grade;
  reason: string;
}

export interface ImpactReport {
  project: string;
  changeSet: string;
  changes: Pick<ElementChange, "id" | "type" | "op" | "changeType" | "version" | "before" | "after">[];
  artifacts: ImpactItem[];
  newWork: NewWorkItem[];
  warnings: string[];
}

export interface ImpactOptions {
  schema: Schema;
  /** Default 3 (PRD F4). */
  maxDepth?: number;
  /** Warn when more artifacts than this are affected (PRD F4: 50). */
  wideLimit?: number;
}

const DOMAINS: Domain[] = ["design", "dev", "qa"];
const GRADE_RANK: Record<Grade, number> = { High: 3, Medium: 2, Low: 1 };

/**
 * PRD F4 "도메인 포함 기준": domains that must act on a change of this kind (●).
 * Other domains (○) are included only through linked artifacts found by the traversal.
 */
function requiredDomains(change: ElementChange): Domain[] {
  const kind = change.changeType;
  switch (change.type) {
    case "Screen":
      return change.op === "modified" && kind === "Structural" ? ["design", "dev"] : ["design"];
    case "Flow":
      return ["design", "qa"];
    case "Requirement":
      return kind === "Copy" ? ["design", "qa"] : ["dev", "qa"];
    case "AcceptanceCriteria":
      return kind === "Copy" ? ["design", "qa"] : ["qa"];
    case "BusinessRule":
      return kind === "Rule" ? ["dev", "qa"] : [];
    case "DataEntity":
      return ["dev"];
    default:
      return kind === "Copy" ? ["design", "qa"] : [];
  }
}

interface Reach {
  distance: number;
  path: TraceStep[];
  /** Every relation on the path has weight low (부록 B: Low). */
  lowOnly: boolean;
}

/**
 * Impact analysis (PRD F4): from each changed element, follow spec relations by their propagation rules
 * (5.3, depth ≤ 3), collect artifacts linked through traceability relations, grade them (부록 B),
 * and derive new work for domains that must act but have nothing to update.
 */
export function analyzeImpact(graph: StoredGraph, changeSet: ChangeSet, options: ImpactOptions): ImpactReport {
  const { schema } = options;
  const maxDepth = options.maxDepth ?? 3;
  const spread = buildSpread(graph, schema);
  const tracedBy = buildTraceIndex(graph, schema);

  // Editorial changes do not propagate (PRD 6.4).
  const origins = changeSet.changes.filter((c) => c.changeType !== "Editorial");
  const reachByOrigin = new Map<string, Map<string, Reach>>();
  const originCount = new Map<string, number>();
  for (const change of origins) {
    const reach = expand(change.uid, spread, maxDepth);
    reachByOrigin.set(change.uid, reach);
    for (const uid of reach.keys()) originCount.set(uid, (originCount.get(uid) ?? 0) + 1);
  }

  const best = new Map<string, { item: ImpactItem; linkedCount: number }>();
  const domainsReached = new Map<string, Set<Domain>>();
  for (const change of origins) {
    const reached = new Set<Domain>();
    for (const [elementUid, reach] of reachByOrigin.get(change.uid)!) {
      for (const link of tracedBy.get(elementUid) ?? []) {
        const artifact = graph.elements.get(link.from);
        const domain = artifact?.domain as Domain | undefined;
        if (!artifact || !domain || !DOMAINS.includes(domain)) continue;
        reached.add(domain);
        const grade = gradeOf(change.changeType, reach);
        const item: ImpactItem = {
          domain,
          artifact: artifact.id,
          title: artifact.title,
          source: artifact.source,
          grade,
          action: actionOf(change, reach, grade),
          distance: reach.distance,
          origin: change.id,
          changeType: change.changeType,
          trace: [...reach.path.map((s) => s.id), artifact.id],
          path: [...reach.path, { id: artifact.id, relation: link.type, forward: false }],
        };
        const candidate = { item, linkedCount: originCount.get(elementUid) ?? 0 };
        const current = best.get(artifact.uid);
        if (!current || better(candidate, current)) best.set(artifact.uid, candidate);
      }
    }
    domainsReached.set(change.uid, reached);
  }

  const newWork: NewWorkItem[] = [];
  for (const change of origins) {
    for (const domain of requiredDomains(change)) {
      // A new element always needs new work; a changed one only when the traversal found nothing to update.
      if (change.op === "added" || !domainsReached.get(change.uid)!.has(domain)) {
        newWork.push({
          domain,
          element: change.id,
          action: "create",
          grade: "High",
          reason: change.op === "added" ? "새 기획 요소" : "연결된 산출물이 없음",
        });
      }
    }
  }

  const artifacts = [...best.values()]
    .map((b) => b.item)
    .sort(
      (a, b) =>
        DOMAINS.indexOf(a.domain) - DOMAINS.indexOf(b.domain) ||
        GRADE_RANK[b.grade] - GRADE_RANK[a.grade] ||
        a.artifact.localeCompare(b.artifact),
    );
  const warnings: string[] = [];
  const wideLimit = options.wideLimit ?? 50;
  if (artifacts.length > wideLimit) warnings.push(`변경 범위가 넓습니다: 영향 산출물 ${artifacts.length}건 (기준 ${wideLimit}건)`);

  return {
    project: changeSet.project,
    changeSet: changeSet.id,
    changes: changeSet.changes.map(({ id, type, op, changeType, version, before, after }) => ({
      id,
      type,
      op,
      changeType,
      version,
      before,
      after,
    })),
    artifacts,
    newWork,
    warnings,
  };
}

/** 부록 B. Unclassified changes are graded like behavioural ones so nothing is under-reported. */
export function gradeOf(changeType: ChangeType, reach: Pick<Reach, "distance" | "lowOnly">): Grade {
  const { distance, lowOnly } = reach;
  const strong = changeType === "Rule" || changeType === "Structural";
  if (distance > 0 && lowOnly) return "Low";
  if (distance === 0 && changeType !== "Copy") return "High";
  if (strong && distance === 1) return "High";
  if (distance === 0 || distance <= 2) return "Medium";
  return "Low";
}

function actionOf(change: ElementChange, reach: Reach, grade: Grade): Action {
  if (change.op === "deprecated" && reach.distance === 0) return "deprecate";
  return grade === "Low" ? "review" : "update";
}

/** Higher grade, then shorter distance, then the linked element hit by more changes, then by trace. */
function better(a: { item: ImpactItem; linkedCount: number }, b: { item: ImpactItem; linkedCount: number }): boolean {
  return (
    GRADE_RANK[a.item.grade] - GRADE_RANK[b.item.grade] ||
    b.item.distance - a.item.distance ||
    a.linkedCount - b.linkedCount ||
    b.item.trace.join(">").localeCompare(a.item.trace.join(">"))
  ) > 0;
}

interface Hop {
  to: string;
  relation: RelationDef;
  forward: boolean;
}

/** For each spec element, where a change to it spreads according to each relation's `propagate`. */
function buildSpread(graph: StoredGraph, schema: Schema): Map<string, Hop[]> {
  const spread = new Map<string, Hop[]>();
  const add = (from: string, hop: Hop) => spread.set(from, [...(spread.get(from) ?? []), hop]);
  for (const edge of graph.edges.values()) {
    const relation = schema.relations.get(edge.type);
    if (!relation || relation.traceability || edge.layer !== "spec") continue;
    if (relation.propagate === "forward" || relation.propagate === "both") add(edge.from, { to: edge.to, relation, forward: true });
    if (relation.propagate === "reverse" || relation.propagate === "both") add(edge.to, { to: edge.from, relation, forward: false });
  }
  for (const hops of spread.values()) hops.sort((a, b) => a.to.localeCompare(b.to) || a.relation.name.localeCompare(b.relation.name));
  return spread;
}

/** Spec element → traceability edges (artifact → element) pointing at it. */
function buildTraceIndex(graph: StoredGraph, schema: Schema): Map<string, StoredEdge[]> {
  const index = new Map<string, StoredEdge[]>();
  for (const edge of graph.edges.values()) {
    if (!schema.relations.get(edge.type)?.traceability) continue;
    index.set(edge.to, [...(index.get(edge.to) ?? []), edge]);
  }
  return index;
}

/**
 * Breadth-first expansion. A relation with `max_depth: k` may appear at most k times on a path
 * (DEPENDS_ON, REFERS_TO, NAVIGATES_TO: once).
 */
function expand(start: string, spread: Map<string, Hop[]>, maxDepth: number): Map<string, Reach> {
  const reached = new Map<string, Reach>();
  const startId = idOf(start);
  reached.set(start, { distance: 0, path: [{ id: startId }], lowOnly: true });
  let frontier: { uid: string; reach: Reach; uses: Map<string, number> }[] = [
    { uid: start, reach: reached.get(start)!, uses: new Map() },
  ];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { uid, reach, uses } of frontier) {
      for (const hop of spread.get(uid) ?? []) {
        const used = uses.get(hop.relation.name) ?? 0;
        if (hop.relation.maxDepth !== undefined && used >= hop.relation.maxDepth) continue;
        if (reached.has(hop.to)) continue;
        const r: Reach = {
          distance: depth,
          path: [...reach.path, { id: idOf(hop.to), relation: hop.relation.name, forward: hop.forward }],
          lowOnly: reach.lowOnly && hop.relation.weight === "low",
        };
        reached.set(hop.to, r);
        next.push({ uid: hop.to, reach: r, uses: new Map(uses).set(hop.relation.name, used + 1) });
      }
    }
    frontier = next;
  }
  return reached;
}

function idOf(uid: string): string {
  return uid.slice(uid.indexOf(":") + 1);
}

