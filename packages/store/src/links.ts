import { readFileSync } from "node:fs";
import { nodeTypeForId, toUid, type Schema } from "@specflow/core";
import { parse } from "yaml";
import { edgeKey, type LinkFile, type LinkPlan, type StoredEdge, type StoredElement, type StoredGraph } from "./types.ts";

export function loadLinkFile(path: string): LinkFile {
  return parse(readFileSync(path, "utf8")) as LinkFile;
}

/**
 * Registers downstream artifacts and their traceability links (PRD F2).
 * A new link records the linked element's current version as `syncedVersion`; an existing link keeps its own,
 * so re-registering never marks a stale artifact as up to date.
 */
export function planLinks(stored: StoredGraph, file: LinkFile, schema: Schema): LinkPlan {
  const problems: string[] = [];
  const elements: StoredElement[] = [];
  const edges: StoredEdge[] = [];
  const project = file.project;

  for (const artifact of file.artifacts) {
    const type = schema.nodeTypes.get(artifact.type);
    const uid = toUid(project, artifact.id);
    if (!type || type.domain === "spec") {
      problems.push(`${artifact.id}: 산출물 타입이 아닙니다: ${artifact.type}`);
      continue;
    }
    if (nodeTypeForId(schema, artifact.id)?.name !== artifact.type) {
      problems.push(`${artifact.id}: ID 접두사가 타입 ${artifact.type}와 맞지 않습니다`);
    }
    const previous = stored.elements.get(uid);
    elements.push({
      uid,
      project,
      id: artifact.id,
      type: artifact.type,
      layer: "artifact",
      ...(type.domain && { domain: type.domain }),
      title: artifact.title,
      version: previous?.version ?? 1,
      contentHash: "",
      text: artifact.title,
      attrs: {},
      values: {},
      source: artifact.source,
    });

    for (const link of artifact.links) {
      const relation = schema.relations.get(link.relation);
      const target = stored.elements.get(toUid(project, link.to));
      if (!relation?.traceability) {
        problems.push(`${artifact.id}: 추적 관계가 아닙니다: ${link.relation}`);
      } else if (!target || target.layer !== "spec") {
        problems.push(`${artifact.id}: 연결할 기획 요소가 저장소에 없습니다: ${link.to} (먼저 ingest 하세요)`);
      } else if (!relation.from.includes(artifact.type) || !relation.to.includes(target.type)) {
        problems.push(`${artifact.id}: ${link.relation} 관계는 ${artifact.type}와 ${target.type}를 잇지 않습니다`);
      } else {
        const edge = { type: link.relation, from: uid, to: target.uid };
        const existing = stored.edges.get(edgeKey(edge));
        edges.push({ ...edge, layer: "artifact", props: {}, syncedVersion: existing?.syncedVersion ?? target.version });
      }
    }
  }

  const listed = new Set(elements.map((e) => e.uid));
  const kept = new Set(edges.map(edgeKey));
  const removedEdges = [...stored.edges.values()].filter(
    (e) => e.layer === "artifact" && listed.has(e.from) && !kept.has(edgeKey(e)),
  );
  return { project, elements, edges, removedEdges, problems };
}
