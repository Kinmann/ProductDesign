import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";
import type { ChangeSet, GraphStore, IngestPlan, LinkPlan, StoredEdge, StoredElement, StoredGraph } from "./types.ts";
import { edgeKey } from "./types.ts";

export interface ReadQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  /** Projects of returned nodes and relationship endpoints that are outside the allowed set. */
  outOfScope: string[];
}

export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

/** Reads NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD and optional NEO4J_DATABASE. */
export function neo4jConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Neo4jConfig | undefined {
  const { NEO4J_URI: uri, NEO4J_USERNAME: username, NEO4J_PASSWORD: password, NEO4J_DATABASE: database } = env;
  if (!uri || !username || !password) return undefined;
  return { uri, username, password, ...(database && { database }) };
}

/** Labels and relationship types come from the schema; refuse anything that is not a plain identifier. */
function identifier(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Neo4j 식별자로 쓸 수 없는 이름입니다: ${name}`);
  return name;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function elementRow(e: StoredElement) {
  return {
    uid: e.uid,
    project: e.project,
    id: e.id,
    type: e.type,
    layer: e.layer,
    domain: e.domain ?? null,
    docLevel: e.docLevel ?? null,
    title: e.title,
    version: e.version,
    contentHash: e.contentHash,
    text: e.text,
    status: e.attrs["상태"] ?? "active",
    attrs_json: JSON.stringify(e.attrs),
    values_json: JSON.stringify(e.values),
    source: e.source,
  };
}

function edgeRow(e: StoredEdge) {
  return { from: e.from, to: e.to, layer: e.layer, props_json: JSON.stringify(e.props), synced_version: e.syncedVersion ?? null };
}

export class Neo4jStore implements GraphStore {
  private readonly driver: Driver;
  private readonly database: string | undefined;

  constructor(config: Neo4jConfig) {
    this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
      disableLosslessIntegers: true,
    });
    this.database = config.database;
  }

  /** Uniqueness constraint on uid and the indexes from schema.yaml (PRD 5.1, 5.9). Safe to run repeatedly. */
  async ensureSchema(): Promise<void> {
    const statements = [
      "CREATE CONSTRAINT specflow_element_uid IF NOT EXISTS FOR (n:Element) REQUIRE n.uid IS UNIQUE",
      "CREATE CONSTRAINT specflow_changeset_uid IF NOT EXISTS FOR (c:ChangeSet) REQUIRE c.uid IS UNIQUE",
      "CREATE INDEX specflow_element_project IF NOT EXISTS FOR (n:Element) ON (n.project)",
      "CREATE INDEX specflow_element_type IF NOT EXISTS FOR (n:Element) ON (n.type)",
      "CREATE INDEX specflow_element_status IF NOT EXISTS FOR (n:Element) ON (n.status)",
    ];
    const session = this.driver.session(this.sessionConfig());
    try {
      for (const statement of statements) await session.run(statement);
    } finally {
      await session.close();
    }
  }

  async verifyConnectivity(): Promise<void> {
    await this.driver.getServerInfo(this.sessionConfig());
  }

  async load(project: string): Promise<StoredGraph> {
    const session = this.driver.session({ ...this.sessionConfig(), defaultAccessMode: neo4j.session.READ });
    try {
      const nodes = await session.run("MATCH (n:Element {project: $project}) RETURN n", { project });
      const rels = await session.run(
        `MATCH (a:Element {project: $project})-[r]->(b:Element)
         RETURN type(r) AS type, a.uid AS from, b.uid AS to, r.layer AS layer, r.props_json AS props, r.synced_version AS synced`,
        { project },
      );
      const count = await session.run("MATCH (c:ChangeSet {project: $project}) RETURN count(c) AS n", { project });

      const elements = new Map<string, StoredElement>();
      for (const record of nodes.records) {
        const p = record.get("n").properties as Record<string, unknown>;
        elements.set(String(p.uid), {
          uid: String(p.uid),
          project: String(p.project),
          id: String(p.id),
          type: String(p.type),
          layer: p.layer as StoredElement["layer"],
          ...(p.domain ? { domain: String(p.domain) } : {}),
          ...(p.docLevel ? { docLevel: p.docLevel as NonNullable<StoredElement["docLevel"]> } : {}),
          title: String(p.title),
          version: Number(p.version),
          contentHash: String(p.contentHash),
          text: String(p.text),
          attrs: JSON.parse(String(p.attrs_json ?? "{}")),
          values: JSON.parse(String(p.values_json ?? "{}")),
          source: String(p.source),
        });
      }
      const edges = new Map<string, StoredEdge>();
      for (const record of rels.records) {
        const synced = record.get("synced");
        const edge: StoredEdge = {
          type: record.get("type"),
          from: record.get("from"),
          to: record.get("to"),
          layer: record.get("layer"),
          props: JSON.parse(record.get("props") ?? "{}"),
          ...(synced !== null && { syncedVersion: Number(synced) }),
        };
        edges.set(edgeKey(edge), edge);
      }
      return { project, elements, edges, changeSetCount: Number(count.records[0]?.get("n") ?? 0) };
    } finally {
      await session.close();
    }
  }

  async applyIngest(plan: IngestPlan): Promise<void> {
    await this.write(async (tx) => {
      await this.deleteEdges(tx, plan.removedEdges);
      await this.upsertElements(tx, plan.elements);
      await this.upsertEdges(tx, plan.edges);
      const cs = plan.changeSet;
      if (!cs) return;
      await tx.run(
        `CREATE (c:ChangeSet {uid: $uid, project: $project, id: $id, specVersion: $specVersion,
                              createdAt: $createdAt, changes_json: $changes})
         WITH c
         UNWIND $modified AS uid
         MATCH (n:Element {uid: uid})
         MERGE (c)-[:MODIFIES]->(n)`,
        {
          uid: `${cs.project}:${cs.id}`,
          project: cs.project,
          id: cs.id,
          specVersion: cs.specVersion,
          createdAt: cs.createdAt,
          changes: JSON.stringify(cs.changes),
          modified: cs.changes.map((c) => c.uid),
        },
      );
      await tx.run(
        `MERGE (v:SpecVersion {uid: $uid})
         SET v.project = $project, v.label = $label, v.createdAt = $createdAt, v.changeSet = $changeSet`,
        { uid: `${cs.project}:sv:${cs.specVersion}`, project: cs.project, label: cs.specVersion, createdAt: cs.createdAt, changeSet: cs.id },
      );
    });
  }

  async applyLinks(plan: LinkPlan): Promise<void> {
    await this.write(async (tx) => {
      await this.deleteEdges(tx, plan.removedEdges);
      await this.upsertElements(tx, plan.elements);
      await this.upsertEdges(tx, plan.edges);
    });
  }

  async loadChangeSet(project: string, id?: string): Promise<ChangeSet | undefined> {
    const session = this.driver.session({ ...this.sessionConfig(), defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run(
        `MATCH (c:ChangeSet {project: $project})
         WHERE $id IS NULL OR c.id = $id
         RETURN c ORDER BY c.id DESC LIMIT 1`,
        { project, id: id ?? null },
      );
      const p = result.records[0]?.get("c").properties as Record<string, unknown> | undefined;
      if (!p) return undefined;
      return {
        id: String(p.id),
        project: String(p.project),
        specVersion: String(p.specVersion),
        createdAt: String(p.createdAt),
        changes: JSON.parse(String(p.changes_json)),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Runs a Cypher query in a read transaction (Neo4j refuses writes in read access mode), with a timeout and a row cap.
   * Every returned node and relationship endpoint is checked against `allowedProjects`.
   */
  async readQuery(
    cypher: string,
    params: Record<string, unknown>,
    options: { allowedProjects: string[]; timeoutMs: number; maxRows: number },
  ): Promise<ReadQueryResult> {
    const session = this.driver.session({ ...this.sessionConfig(), defaultAccessMode: neo4j.session.READ });
    try {
      return await session.executeRead(
        async (tx) => {
          const result = await tx.run(cypher, params);
          const nodeProjects = new Set<string>();
          const relationshipIds = new Set<string>();
          const plain = (value: unknown): unknown => {
            if (neo4j.isNode(value as never)) {
              const node = value as { labels: string[]; properties: Record<string, unknown> };
              nodeProjects.add(String(node.properties.project ?? "(none)"));
              return { labels: node.labels, properties: plain(node.properties) };
            }
            if (neo4j.isRelationship(value as never)) {
              const rel = value as { elementId: string; type: string; properties: Record<string, unknown> };
              relationshipIds.add(rel.elementId);
              return { type: rel.type, properties: plain(rel.properties) };
            }
            if (neo4j.isPath(value as never)) {
              const path = value as { segments: { start: unknown; relationship: unknown; end: unknown }[] };
              return path.segments.map((seg) => ({ start: plain(seg.start), relationship: plain(seg.relationship), end: plain(seg.end) }));
            }
            if (Array.isArray(value)) return value.map(plain);
            if (value && typeof value === "object") {
              if (typeof (value as { toString?: unknown }).toString === "function" && value.constructor?.name !== "Object") {
                return String(value); // temporal and spatial values
              }
              return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
            }
            return value;
          };
          const rows = result.records.slice(0, options.maxRows).map((record) => record.keys.map((k) => plain(record.get(k))));
          if (relationshipIds.size > 0) {
            const ends = await tx.run(
              "MATCH (a)-[r]->(b) WHERE elementId(r) IN $ids RETURN DISTINCT coalesce(a.project, '(none)') AS pa, coalesce(b.project, '(none)') AS pb",
              { ids: [...relationshipIds] },
            );
            for (const record of ends.records) {
              nodeProjects.add(String(record.get("pa")));
              nodeProjects.add(String(record.get("pb")));
            }
          }
          return {
            columns: result.records[0]?.keys.map(String) ?? [],
            rows,
            truncated: result.records.length > options.maxRows,
            outOfScope: [...nodeProjects].filter((p) => !options.allowedProjects.includes(p)),
          };
        },
        { timeout: options.timeoutMs },
      );
    } finally {
      await session.close();
    }
  }

  async deleteProject(project: string): Promise<void> {
    await this.write(async (tx) => {
      await tx.run(
        "MATCH (n {project: $project}) WHERE n:Element OR n:ChangeSet OR n:SpecVersion DETACH DELETE n",
        { project },
      );
    });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private sessionConfig() {
    return this.database ? { database: this.database } : {};
  }

  private async write(work: (tx: ManagedTransaction) => Promise<void>): Promise<void> {
    const session = this.driver.session(this.sessionConfig());
    try {
      await session.executeWrite(work);
    } finally {
      await session.close();
    }
  }

  private async upsertElements(tx: ManagedTransaction, elements: StoredElement[]): Promise<void> {
    for (const [type, group] of groupBy(elements, (e) => e.type)) {
      await tx.run(
        `UNWIND $rows AS row
         MERGE (n:Element {uid: row.uid})
         SET n += row, n:${identifier(type)}`,
        { rows: group.map(elementRow) },
      );
    }
  }

  private async upsertEdges(tx: ManagedTransaction, edges: StoredEdge[]): Promise<void> {
    for (const [type, group] of groupBy(edges, (e) => e.type)) {
      await tx.run(
        `UNWIND $rows AS row
         MATCH (a:Element {uid: row.from}), (b:Element {uid: row.to})
         MERGE (a)-[r:${identifier(type)}]->(b)
         SET r.layer = row.layer, r.props_json = row.props_json, r.synced_version = row.synced_version`,
        { rows: group.map(edgeRow) },
      );
    }
  }

  private async deleteEdges(tx: ManagedTransaction, edges: StoredEdge[]): Promise<void> {
    for (const [type, group] of groupBy(edges, (e) => e.type)) {
      await tx.run(
        `UNWIND $rows AS row
         MATCH (:Element {uid: row.from})-[r:${identifier(type)}]->(:Element {uid: row.to})
         DELETE r`,
        { rows: group.map(edgeRow) },
      );
    }
  }
}
