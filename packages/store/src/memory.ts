import { edgeKey, emptyGraph, type ChangeSet, type GraphStore, type IngestPlan, type LinkPlan, type StoredGraph } from "./types.ts";

/** In-process store with the same behaviour as the Neo4j store. Used by tests and dry runs. */
export class MemoryStore implements GraphStore {
  private readonly graphs = new Map<string, StoredGraph>();
  readonly changeSets: ChangeSet[] = [];

  async load(project: string): Promise<StoredGraph> {
    const graph = this.graphs.get(project) ?? emptyGraph(project);
    // Return a copy so callers cannot mutate stored state.
    return {
      project,
      elements: new Map([...graph.elements].map(([k, v]) => [k, structuredClone(v)])),
      edges: new Map([...graph.edges].map(([k, v]) => [k, structuredClone(v)])),
      changeSetCount: graph.changeSetCount,
    };
  }

  async applyIngest(plan: IngestPlan): Promise<void> {
    const graph = this.graph(plan.project);
    for (const element of plan.elements) graph.elements.set(element.uid, structuredClone(element));
    for (const edge of plan.removedEdges) graph.edges.delete(edgeKey(edge));
    for (const edge of plan.edges) graph.edges.set(edgeKey(edge), structuredClone(edge));
    if (plan.changeSet) {
      graph.changeSetCount += 1;
      this.changeSets.push(structuredClone(plan.changeSet));
    }
  }

  async applyLinks(plan: LinkPlan): Promise<void> {
    const graph = this.graph(plan.project);
    for (const element of plan.elements) graph.elements.set(element.uid, structuredClone(element));
    for (const edge of plan.removedEdges) graph.edges.delete(edgeKey(edge));
    for (const edge of plan.edges) graph.edges.set(edgeKey(edge), structuredClone(edge));
  }

  async deleteProject(project: string): Promise<void> {
    this.graphs.delete(project);
  }

  async close(): Promise<void> {}

  private graph(project: string): StoredGraph {
    let graph = this.graphs.get(project);
    if (!graph) this.graphs.set(project, (graph = emptyGraph(project)));
    return graph;
  }
}
