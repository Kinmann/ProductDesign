import type { DocLevel, StaleLink } from "@specflow/core";

/** PRD 5.1: the spec layer is rebuilt from Git; the artifact (link/state) layer exists only in the store. */
export type Layer = "spec" | "artifact";

export interface StoredElement {
  uid: string;
  project: string;
  id: string;
  type: string;
  layer: Layer;
  domain?: string;
  docLevel?: DocLevel;
  title: string;
  /** Integer version; +1 whenever the content hash changes (PRD 5.5). */
  version: number;
  contentHash: string;
  /** Human-readable content used for ChangeSet before/after. */
  text: string;
  attrs: Record<string, string>;
  values: Record<string, string>;
  /** `file:line` for spec elements, the external location for artifacts. */
  source: string;
}

export interface StoredEdge {
  type: string;
  from: string;
  to: string;
  layer: Layer;
  props: Record<string, string | number>;
  /** Version of the upper element this link last reflected (sync and traceability relations). */
  syncedVersion?: number;
}

export interface StoredGraph {
  project: string;
  elements: Map<string, StoredElement>;
  edges: Map<string, StoredEdge>;
  /** Number of ChangeSets recorded so far, for the next `CS-` id. */
  changeSetCount: number;
}

export function edgeKey(edge: { type: string; from: string; to: string }): string {
  return `${edge.type}|${edge.from}|${edge.to}`;
}

export function emptyGraph(project: string): StoredGraph {
  return { project, elements: new Map(), edges: new Map(), changeSetCount: 0 };
}

/** PRD 6.4. `Unclassified` when rules cannot tell (a person decides; IMPLEMENTATION_PLAN 7). */
export type ChangeType = "Structural" | "Rule" | "Behavioral" | "Data" | "Copy" | "Editorial" | "Unclassified";

export interface ElementChange {
  uid: string;
  id: string;
  type: string;
  op: "added" | "modified" | "deprecated";
  changeType: ChangeType;
  version: { from: number | null; to: number };
  before: string | null;
  after: string;
}

export interface ChangeSet {
  id: string;
  project: string;
  specVersion: string;
  createdAt: string;
  changes: ElementChange[];
}

export interface IngestPlan {
  project: string;
  specVersion: string;
  /** Undefined when nothing changed. */
  changeSet?: ChangeSet;
  /** Final spec-layer elements and edges after the ingest. */
  elements: StoredElement[];
  edges: StoredEdge[];
  removedEdges: StoredEdge[];
  /** Stored spec elements missing from the snapshot (L05): the ingest must be refused. */
  removed: StoredElement[];
  /** Sync links left stale by this change (L09). */
  stale: StaleLink[];
  /** Spec edges pointing outside the project (e.g. `shared:`); not stored in 1a. */
  unresolved: StoredEdge[];
}

/** "No change" confirmation for a stale link (PRD 5.8; IMPLEMENTATION_PLAN M4). */
export interface Review {
  element: string;
  upper: string;
  /** Content hash of the upper element that was reviewed. A later edit to it voids the review. */
  upperHash: string;
  note?: string;
}

export interface LinkFile {
  project: string;
  artifacts: {
    id: string;
    type: string;
    title: string;
    source: string;
    links: { relation: string; to: string }[];
  }[];
}

export interface LinkPlan {
  project: string;
  elements: StoredElement[];
  edges: StoredEdge[];
  removedEdges: StoredEdge[];
  problems: string[];
}

export interface GraphStore {
  load(project: string): Promise<StoredGraph>;
  applyIngest(plan: IngestPlan): Promise<void>;
  applyLinks(plan: LinkPlan): Promise<void>;
  /** Removes everything stored for the project. */
  deleteProject(project: string): Promise<void>;
  close(): Promise<void>;
}
