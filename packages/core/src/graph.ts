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
  /** Lint code when the problem maps to a rule (e.g. L01, L04), otherwise a parser code (Pxx). */
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
  issues: ParseIssue[];
}

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
