import type { Schema } from "@specflow/core";
import { analyzeImpact, renderImpactMarkdown } from "@specflow/impact";
import { edgeKey, upperEnd, type GraphStore, type StoredEdge, type StoredElement, type StoredGraph } from "@specflow/store";

/** Projects every session may read besides its own (PRD 5.9). */
export const SHARED_PROJECT = "shared";

export interface ToolContext {
  store: GraphStore;
  schema: Schema;
  /** The session's project key; every read is limited to it and `shared`. */
  project: string;
}

/** The session's project merged with the shared library, read fresh on every call. */
export async function loadScope(ctx: ToolContext): Promise<StoredGraph> {
  const own = await ctx.store.load(ctx.project);
  if (ctx.project === SHARED_PROJECT) return own;
  const shared = await ctx.store.load(SHARED_PROJECT);
  return {
    project: ctx.project,
    elements: new Map([...shared.elements, ...own.elements]),
    edges: new Map([...shared.edges, ...own.edges]),
    changeSetCount: own.changeSetCount,
  };
}

export function scopeOf(ctx: ToolContext): string[] {
  return ctx.project === SHARED_PROJECT ? [SHARED_PROJECT] : [ctx.project, SHARED_PROJECT];
}

const idOf = (uid: string) => uid.slice(uid.indexOf(":") + 1);

/** Accepts `REQ-SIGNUP-002`, `DEMO:REQ-SIGNUP-002`, or `shared:RULE-PW-001`; never another project. */
export function resolve(graph: StoredGraph, ctx: ToolContext, ref: string): StoredElement | undefined {
  if (ref.includes(":")) {
    const project = ref.slice(0, ref.indexOf(":"));
    return scopeOf(ctx).includes(project) ? graph.elements.get(ref) : undefined;
  }
  return graph.elements.get(`${ctx.project}:${ref}`) ?? graph.elements.get(`${SHARED_PROJECT}:${ref}`);
}

function summary(e: StoredElement) {
  return {
    id: e.id,
    ...(e.project !== undefined && { project: e.project }),
    type: e.type,
    layer: e.layer,
    ...(e.docLevel && { docLevel: e.docLevel }),
    title: e.title,
    version: e.version,
  };
}

export function getSchema(ctx: ToolContext) {
  const { schema } = ctx;
  return {
    project: ctx.project,
    readableProjects: scopeOf(ctx),
    nodeTypes: [...schema.nodeTypes.values()].map((t) => ({
      type: t.name,
      idPrefix: t.idPrefix ?? null,
      domain: t.domain ?? null,
      docLevels: t.docLevels,
    })),
    relations: [...schema.relations.values()].map((r) => ({
      relation: r.name,
      from: r.from,
      to: r.to,
      propagate: r.propagate,
      weight: r.weight ?? null,
      maxDepth: r.maxDepth ?? null,
      traceability: r.traceability,
    })),
    syncRelations: schema.syncRelations,
    notes: [
      "propagate forward: from이 바뀌면 to가 영향받음 / reverse: to가 바뀌면 from이 영향받음 / both: 양쪽",
      "traceability 관계는 산출물(디자인·개발·QA)을 기획 요소에 잇는다. syncedVersion < 요소 version이면 그 산출물은 최신 기획을 반영하지 않은 상태다",
      "query_graph의 노드는 :Element 라벨, uid·project·id·type·layer·title·version·text 속성을 가진다",
    ],
  };
}

export async function getElement(ctx: ToolContext, ref: string) {
  const graph = await loadScope(ctx);
  const element = resolve(graph, ctx, ref);
  if (!element) return undefined;
  const relations = [...graph.edges.values()]
    .filter((e) => e.from === element.uid || e.to === element.uid)
    .map((e) => {
      const out = e.from === element.uid;
      const other = graph.elements.get(out ? e.to : e.from);
      const target = graph.elements.get(e.to);
      return {
        relation: e.type,
        direction: out ? "out" : "in",
        other: other ? idOf(other.uid) : idOf(out ? e.to : e.from),
        otherType: other?.type ?? null,
        otherTitle: other?.title ?? null,
        ...(e.syncedVersion !== undefined && {
          syncedVersion: e.syncedVersion,
          upToDate: target ? e.syncedVersion >= target.version : null,
        }),
      };
    })
    .sort((a, b) => a.relation.localeCompare(b.relation) || a.other.localeCompare(b.other));
  return { ...summary(element), domain: element.domain ?? null, source: element.source, attrs: element.attrs, values: element.values, relations };
}

export async function searchElements(ctx: ToolContext, query: string, type?: string, limit = 20) {
  const graph = await loadScope(ctx);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [...graph.elements.values()]
    .filter((e) => !type || e.type === type)
    .map((e) => {
      const hay = `${e.id} ${e.title} ${e.text}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) + (terms.includes(e.id.toLowerCase()) ? 2 : 0);
      return { element: e, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.element.id.localeCompare(b.element.id))
    .slice(0, Math.min(limit, 100));
  return hits.map((h) => ({ ...summary(h.element), score: h.score }));
}

export async function getTrace(ctx: ToolContext, ref: string, depth = 2, direction: "both" | "out" | "in" = "both") {
  const graph = await loadScope(ctx);
  const start = resolve(graph, ctx, ref);
  if (!start) return undefined;
  const maxDepth = Math.max(1, Math.min(depth, 4));
  const distance = new Map([[start.uid, 0]]);
  const edges = new Map<string, StoredEdge>();
  let frontier = [start.uid];
  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const uid of frontier) {
      for (const edge of graph.edges.values()) {
        const out = edge.from === uid && direction !== "in";
        const inbound = edge.to === uid && direction !== "out";
        if (!out && !inbound) continue;
        const other = out ? edge.to : edge.from;
        if (!graph.elements.has(other)) continue;
        edges.set(edgeKey(edge), edge);
        if (!distance.has(other)) {
          distance.set(other, d);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return {
    start: start.id,
    depth: maxDepth,
    direction,
    nodes: [...distance].map(([uid, d]) => ({ ...summary(graph.elements.get(uid)!), distance: d })).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)),
    edges: [...edges.values()].map((e) => ({
      relation: e.type,
      from: idOf(e.from),
      to: idOf(e.to),
      ...(e.syncedVersion !== undefined && { syncedVersion: e.syncedVersion }),
    })),
  };
}

export async function getSyncStatus(ctx: ToolContext) {
  const graph = await loadScope(ctx);
  const traceability = new Set([...ctx.schema.relations.values()].filter((r) => r.traceability).map((r) => r.name));
  const sync = new Set(ctx.schema.syncRelations);
  const artifacts = [...graph.elements.values()].filter((e) => e.layer === "artifact");

  const staleArtifacts = [...graph.edges.values()]
    .filter((e) => traceability.has(e.type))
    .flatMap((e) => {
      const element = graph.elements.get(e.to);
      const artifact = graph.elements.get(e.from);
      if (!element || !artifact || e.syncedVersion === undefined || e.syncedVersion >= element.version) return [];
      return [{ artifact: artifact.id, domain: artifact.domain ?? null, title: artifact.title, relation: e.type, element: element.id, syncedVersion: e.syncedVersion, elementVersion: element.version }];
    });

  const staleSpecLinks = [...graph.edges.values()]
    .filter((e) => sync.has(e.type))
    .flatMap((e) => {
      const upperUid = upperEnd(e, graph.elements);
      const upper = graph.elements.get(upperUid);
      if (!upper || e.syncedVersion === undefined || e.syncedVersion >= upper.version) return [];
      return [{ relation: e.type, lower: idOf(upperUid === e.from ? e.to : e.from), upper: upper.id, syncedVersion: e.syncedVersion, upperVersion: upper.version }];
    });

  const staleSet = new Set(staleArtifacts.map((s) => s.artifact));
  return {
    project: ctx.project,
    artifacts: { total: artifacts.length, inSync: artifacts.filter((a) => !staleSet.has(a.id)).length, stale: staleSet.size },
    staleArtifacts,
    staleSpecLinks,
  };
}

export async function analyzeChangeSet(ctx: ToolContext, id?: string) {
  const changeSet = await ctx.store.loadChangeSet(ctx.project, id);
  if (!changeSet) return undefined;
  const report = analyzeImpact(await loadScope(ctx), changeSet, { schema: ctx.schema });
  return { report, markdown: renderImpactMarkdown(report) };
}
