import type { DocLevel } from "./schema.ts";

/** Where something was declared, for lint messages. `file` is relative to the specs root. */
export interface SourceRef {
  file: string;
  line: number;
}

/** A spec element (PRD/FDD/IA) parsed from Markdown. */
export interface SpecNode {
  /** Global id: `{project}:{id}` (PRD 5.9). */
  uid: string;
  project: string;
  id: string;
  type: string;
  docLevel?: DocLevel;
  title: string;
  /** Field lines that do not map to a relation, e.g. `설명`, `노출`, `구성`. */
  attrs: Record<string, string>;
  /** Policy values of a BusinessRule: item → value (PRD 6.2). */
  values: Record<string, string>;
  /** Hash of the element's own normalized text; drives version bumps (M4). */
  contentHash: string;
  source: SourceRef;
}

export interface SpecEdge {
  /** Relation name from the schema. */
  type: string;
  from: string;
  to: string;
  props: Record<string, string | number>;
  source: SourceRef;
}

export interface SpecDocument {
  file: string;
  frontMatter: Record<string, unknown>;
  docLevel?: DocLevel;
  elementUids: string[];
}

/** One line of the IA sitemap's nested list. */
export interface SitemapEntry {
  screen: string;
  parent?: string;
  source: SourceRef;
}

export interface ParseIssue {
  /** Lint code when the problem maps to a rule (e.g. L01, L02), otherwise a parser code (Pxx). */
  code: string;
  severity: "error" | "warning";
  message: string;
  source: SourceRef;
}

export interface GraphSnapshot {
  project: string;
  documents: SpecDocument[];
  nodes: SpecNode[];
  edges: SpecEdge[];
  sitemap: SitemapEntry[];
  /** Second and later definitions of an ID already in `nodes` (lint L04, L07). They add no relations. */
  duplicates: SpecNode[];
  issues: ParseIssue[];
}

/** Field every element may carry to mark its lifecycle: `- 상태: deprecated` (PRD 5.6). Never a relation or policy value. */
export const STATUS_FIELD = "상태";
export const DEPRECATED = "deprecated";

const PROJECT_SEPARATOR = ":";

/** `REQ-SIGNUP-002` in project DEMO → `DEMO:REQ-SIGNUP-002`; already-qualified refs are kept. */
export function toUid(project: string, ref: string): string {
  return ref.includes(PROJECT_SEPARATOR) ? ref : `${project}${PROJECT_SEPARATOR}${ref}`;
}

export function splitUid(uid: string): { project: string; id: string } {
  const at = uid.indexOf(PROJECT_SEPARATOR);
  return at < 0 ? { project: "", id: uid } : { project: uid.slice(0, at), id: uid.slice(at + 1) };
}

export function idPrefix(id: string): string {
  return splitUid(id).id.split("-")[0] ?? "";
}

/**
 * A sync relation whose upper element changed but whose lower element was neither edited nor
 * confirmed "no change" (lint L09, PRD 5.8).
 */
export interface StaleLink {
  relation: string;
  /** The element that must be reviewed. */
  lower: string;
  /** The changed element it depends on. */
  upper: string;
  upperVersion: number;
  syncedVersion: number;
  /** Content hash of the upper element; a review must name it to count. */
  upperHash: string;
  source: SourceRef;
}
