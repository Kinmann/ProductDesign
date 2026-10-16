import {
  DEPRECATED,
  DOC_LEVELS,
  STATUS_FIELD,
  type GraphSnapshot,
  type Schema,
  type SpecEdge,
  type SpecNode,
  type StaleLink,
} from "@specflow/core";
import {
  edgeKey,
  type ChangeSet,
  type ChangeType,
  type ElementChange,
  type IngestPlan,
  type Review,
  type StoredEdge,
  type StoredElement,
  type StoredGraph,
} from "./types.ts";

export interface PlanOptions {
  schema: Schema;
  reviews?: Review[];
  /** Label of the spec version being ingested (commit SHA when available). */
  specVersion: string;
  now?: Date;
}

/**
 * Works out what an ingest of `snapshot` would change in the stored graph, without touching it:
 * element versions, the ChangeSet, which sync links become stale (L09), and removed IDs (L05).
 */
export function planIngest(stored: StoredGraph, snapshot: GraphSnapshot, options: PlanOptions): IngestPlan {
  const { schema } = options;
  const elements = new Map<string, StoredElement>();
  const changes: ElementChange[] = [];

  for (const node of snapshot.nodes) {
    const previous = stored.elements.get(node.uid);
    const next = toStoredElement(node, previous);
    elements.set(node.uid, next);
    if (!previous) {
      changes.push(change(next, null, "added"));
    } else if (previous.contentHash !== node.contentHash) {
      const op = isDeprecated(next) && !isDeprecated(previous) ? "deprecated" : "modified";
      changes.push(change(next, previous, op));
    }
  }

  const removed = [...stored.elements.values()].filter((e) => e.layer === "spec" && !elements.has(e.uid));

  const sync = new Set(schema.syncRelations);
  const reviewed = new Set((options.reviews ?? []).map((r) => reviewKey(r.element, r.upper, r.upperHash)));
  const changedUids = new Set(changes.map((c) => c.uid));
  const edges: StoredEdge[] = [];
  const unresolved: StoredEdge[] = [];
  const stale: StaleLink[] = [];

  for (const edge of snapshot.edges) {
    const next: StoredEdge = { type: edge.type, from: edge.from, to: edge.to, layer: "spec", props: { ...edge.props } };
    if (!elements.has(edge.from) || !elements.has(edge.to)) {
      unresolved.push(next);
      continue;
    }
    if (sync.has(edge.type)) {
      const upperUid = upperEnd(edge, elements);
      const lowerUid = upperUid === edge.from ? edge.to : edge.from;
      const upper = elements.get(upperUid)!;
      const previousSynced = stored.edges.get(edgeKey(edge))?.syncedVersion;
      const lower = elements.get(lowerUid)!;
      if (previousSynced === undefined || previousSynced >= upper.version) {
        // A new link reflects the upper element as it is now.
        next.syncedVersion = previousSynced ?? upper.version;
      } else if (changedUids.has(lowerUid) || reviewed.has(reviewKey(lower.id, upper.id, upper.contentHash))) {
        // Editing the lower element, or confirming "no change", counts as reviewing it.
        next.syncedVersion = upper.version;
      } else {
        next.syncedVersion = previousSynced;
        stale.push({
          relation: edge.type,
          lower: lowerUid,
          upper: upperUid,
          upperVersion: upper.version,
          syncedVersion: previousSynced,
          upperHash: upper.contentHash,
          source: edge.source,
        });
      }
    }
    edges.push(next);
  }

  const kept = new Set(edges.map(edgeKey));
  const removedEdges = [...stored.edges.values()].filter((e) => e.layer === "spec" && !kept.has(edgeKey(e)));

  const changeSet: ChangeSet | undefined =
    changes.length > 0
      ? {
          id: `CS-${String(stored.changeSetCount + 1).padStart(4, "0")}`,
          project: snapshot.project,
          specVersion: options.specVersion,
          createdAt: (options.now ?? new Date()).toISOString(),
          changes: changes.map((c) => ({ ...c, changeType: classify(c, stored.elements.get(c.uid), elements.get(c.uid)!) })),
        }
      : undefined;

  return {
    project: snapshot.project,
    specVersion: options.specVersion,
    ...(changeSet && { changeSet }),
    elements: [...elements.values()],
    edges,
    removedEdges,
    removed,
    stale,
    unresolved,
  };
}

/** The stored graph as it will be after `plan` is applied: new spec layer, unchanged artifact layer. */
export function graphAfter(stored: StoredGraph, plan: IngestPlan): StoredGraph {
  const elements = new Map([...stored.elements].filter(([, e]) => e.layer !== "spec"));
  for (const element of plan.elements) elements.set(element.uid, element);
  const edges = new Map([...stored.edges].filter(([, e]) => e.layer !== "spec"));
  for (const edge of plan.edges) edges.set(edgeKey(edge), edge);
  return { project: stored.project, elements, edges, changeSetCount: stored.changeSetCount + (plan.changeSet ? 1 : 0) };
}

/**
 * The end of a sync relation that the other end must follow: the one in the higher stage
 * (PRD before FDD before IA). Within the same stage it is the target, e.g. the requirement depended on.
 */
export function upperEnd(edge: Pick<SpecEdge, "from" | "to">, elements: Map<string, Pick<StoredElement, "docLevel">>): string {
  const rank = (uid: string) => {
    const level = elements.get(uid)?.docLevel;
    return level ? DOC_LEVELS.indexOf(level) : DOC_LEVELS.length;
  };
  return rank(edge.from) < rank(edge.to) ? edge.from : edge.to;
}

function toStoredElement(node: SpecNode, previous: StoredElement | undefined): StoredElement {
  const version = !previous ? 1 : previous.contentHash === node.contentHash ? previous.version : previous.version + 1;
  return {
    uid: node.uid,
    project: node.project,
    id: node.id,
    type: node.type,
    layer: "spec",
    domain: "spec",
    ...(node.docLevel && { docLevel: node.docLevel }),
    title: node.title,
    version,
    contentHash: node.contentHash,
    text: describe(node),
    attrs: node.attrs,
    values: node.values,
    source: `${node.source.file}:${node.source.line}`,
  };
}

/** Title, policy values, and fields, one per line: what a reviewer compares before and after. */
function describe(node: SpecNode): string {
  return [
    node.title,
    ...Object.entries(node.values).map(([k, v]) => `${k}: ${v}`),
    ...Object.entries(node.attrs).map(([k, v]) => `${k}: ${v}`),
  ].join("\n");
}

function change(next: StoredElement, previous: StoredElement | null, op: ElementChange["op"]): ElementChange {
  return {
    uid: next.uid,
    id: next.id,
    type: next.type,
    op,
    changeType: "Unclassified",
    version: { from: previous?.version ?? null, to: next.version },
    before: previous?.text ?? null,
    after: next.text,
  };
}

const STRUCTURAL_TYPES = new Set(["Feature", "Requirement", "Screen", "Flow"]);
/** IA fields that change structure rather than wording (PRD 6.2). */
const SCREEN_STRUCTURE_FIELDS = ["상위", "이동", "요구사항", "플로우"];

/**
 * Rule-based change type (PRD 6.4). Only what rules can decide is classified; the rest is
 * `Unclassified` and left to a person or, from Phase 2, the Spec Agent.
 */
export function classify(c: ElementChange, before: StoredElement | undefined, after: StoredElement): ChangeType {
  if (c.op === "added" || c.op === "deprecated") {
    if (STRUCTURAL_TYPES.has(c.type)) return "Structural";
    if (c.type === "AcceptanceCriteria") return "Behavioral";
    if (c.type === "BusinessRule") return "Rule";
    if (c.type === "DataEntity") return "Data";
    return "Unclassified";
  }
  if (!before) return "Unclassified";
  switch (c.type) {
    case "BusinessRule":
      return sameRecord(before.values, after.values) ? "Unclassified" : "Rule";
    case "DataEntity":
      return "Data";
    case "Screen":
      return SCREEN_STRUCTURE_FIELDS.some((f) => before.attrs[f] !== after.attrs[f]) ? "Structural" : "Unclassified";
    case "AcceptanceCriteria":
    case "Requirement":
    case "Flow":
      // A different number (length, count, time) changes behaviour; other wording needs a person.
      return numbers(before.text) === numbers(after.text) ? "Unclassified" : "Behavioral";
    default:
      return "Unclassified";
  }
}

function isDeprecated(element: StoredElement): boolean {
  return element.attrs[STATUS_FIELD] === DEPRECATED;
}

function reviewKey(element: string, upper: string, upperHash: string): string {
  return `${element}|${upper}|${upperHash}`;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}

function numbers(text: string): string {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).join(",");
}
