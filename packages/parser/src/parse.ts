import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOC_LEVELS,
  nodeTypeForId,
  toUid,
  type DocLevel,
  type GraphSnapshot,
  type ParseIssue,
  type RelationDef,
  type Schema,
  type SitemapEntry,
  type SourceRef,
  type SpecDocument,
  type SpecEdge,
  type SpecNode,
} from "@specflow/core";
import { parse as parseYaml } from "yaml";

export interface ParseOptions {
  project: string;
  schema: Schema;
}

/** An element ID, optionally project-qualified: `REQ-SIGNUP-002`, `shared:RULE-PW-001`. */
const ID = String.raw`(?:[a-z][a-z0-9_]*:)?[A-Z][A-Z0-9]*-[A-Za-z0-9/_-]*[A-Za-z0-9]`;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ELEMENT_HEADING = new RegExp(`^(${ID})\\s+(.+)$`);
const REFERENCE = new RegExp(`\\[\\[(${ID})\\]\\]`, "g");
const FENCE = /^\s*(```|~~~)/;
const TOP_ITEM = /^- (.*)$/;
const NESTED_ITEM = /^(\s+)- (.*)$/;
const FIELD = /^([^:[\]]+?):\s*(.*)$/;
const NESTED_ELEMENT = new RegExp(`^(${ID}):\\s*(.+)$`);
/** Label key in `field_labels` that applies to every label not listed explicitly. */
const ANY_LABEL = "*";

/**
 * Parses every Markdown file under the given roots into one graph snapshot.
 * Later roots override files with the same relative path (scenario overlays).
 */
export function parseSpecs(roots: string | string[], options: ParseOptions): GraphSnapshot {
  const files = new Map<string, string>();
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (file.endsWith(".md")) files.set(file.split("\\").join("/"), join(root, file));
    }
  }
  const builder = new SnapshotBuilder(options);
  for (const relative of [...files.keys()].sort()) {
    builder.addDocument(relative, readFileSync(files.get(relative)!, "utf8"));
  }
  return builder.finish();
}

interface OpenElement {
  node: SpecNode;
  lines: string[];
  /** Relation of the last top-level field, so nested items (acceptance criteria) know their parent. */
  fieldRelation?: RelationDef;
}

export class SnapshotBuilder {
  private readonly nodes = new Map<string, SpecNode>();
  private readonly edges = new Map<string, SpecEdge>();
  private readonly documents: SpecDocument[] = [];
  private readonly sitemap: SitemapEntry[] = [];
  private readonly issues: ParseIssue[] = [];
  private readonly citation?: { relation: RelationDef; pattern: RegExp };
  private readonly options: ParseOptions;

  constructor(options: ParseOptions) {
    this.options = options;
    const rule = options.schema.citations[0];
    const relation = rule && options.schema.relations.get(rule.relation);
    const target = relation && options.schema.nodeTypes.get(relation.to[0] ?? "");
    if (relation && target?.idPrefix) {
      // "(RULE-PW-001 최소 길이)" → id + item
      this.citation = {
        relation,
        pattern: new RegExp(`\\(((?:[a-z][a-z0-9_]*:)?${target.idPrefix}-[A-Z0-9-]*[A-Z0-9])\\s+([^()]+?)\\)`, "g"),
      };
    }
  }

  addDocument(file: string, text: string): void {
    const lines = text.split(/\r?\n/);
    const { frontMatter, bodyStart } = this.readFrontMatter(file, lines);
    const docLevel = (DOC_LEVELS as readonly unknown[]).includes(frontMatter.doc)
      ? (frontMatter.doc as DocLevel)
      : undefined;
    const doc: SpecDocument = { file, frontMatter, ...(docLevel && { docLevel }), elementUids: [] };
    this.documents.push(doc);

    let current: OpenElement | undefined;
    let inFence = false;
    const sitemapStack: { indent: number; uid: string }[] = [];
    const close = () => {
      if (current) this.closeElement(current);
      current = undefined;
    };

    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i]!;
      const source = { file, line: i + 1 };
      if (FENCE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const heading = HEADING.exec(line);
      if (heading) {
        close();
        const element = ELEMENT_HEADING.exec(heading[2]!.trim());
        if (element) current = this.openElement(element[1]!, element[2]!, docLevel, source, doc);
        continue;
      }

      if (!current) {
        if (docLevel === "ia") this.readSitemapLine(line, source, sitemapStack);
        continue;
      }

      const top = TOP_ITEM.exec(line);
      const nested = NESTED_ITEM.exec(line);
      if (top) {
        current.lines.push(line);
        const field = FIELD.exec(top[1]!);
        delete current.fieldRelation;
        if (field) this.readField(current, field[1]!.trim(), field[2]!.trim(), source);
      } else if (nested && current.fieldRelation) {
        this.readNestedElement(current, nested[2]!, source, doc);
      } else if (line.trim()) {
        current.lines.push(line);
      }
    }
    close();
    this.addFrontMatterRelations(doc, file);
  }

  finish(): GraphSnapshot {
    const byUid = <T extends { uid: string }>(a: T, b: T) => a.uid.localeCompare(b.uid);
    const byEdge = (a: SpecEdge, b: SpecEdge) =>
      a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
    return {
      project: this.options.project,
      documents: this.documents,
      nodes: [...this.nodes.values()].sort(byUid),
      edges: [...this.edges.values()].sort(byEdge),
      sitemap: this.sitemap,
      issues: this.issues,
    };
  }

  private readFrontMatter(file: string, lines: string[]) {
    if (lines[0]?.trim() !== "---") {
      this.issue("L01", "error", "front matter가 없습니다", { file, line: 1 });
      return { frontMatter: {}, bodyStart: 0 };
    }
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end < 0) {
      this.issue("L01", "error", "front matter가 닫히지 않았습니다 (---)", { file, line: 1 });
      return { frontMatter: {}, bodyStart: 0 };
    }
    try {
      const value: unknown = parseYaml(lines.slice(1, end).join("\n"));
      const frontMatter = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
      return { frontMatter, bodyStart: end + 1 };
    } catch (error) {
      this.issue("L01", "error", `front matter YAML 오류: ${(error as Error).message}`, { file, line: 2 });
      return { frontMatter: {}, bodyStart: end + 1 };
    }
  }

  private openElement(
    id: string,
    title: string,
    docLevel: DocLevel | undefined,
    source: SourceRef,
    doc: SpecDocument,
  ): OpenElement | undefined {
    const type = nodeTypeForId(this.options.schema, id);
    if (!type) {
      this.issue("P01", "warning", `알 수 없는 ID 접두사라 기획 요소로 읽지 않았습니다: ${id}`, source);
      return undefined;
    }
    const node = this.addNode(id, type.name, title.trim(), docLevel, source, doc);
    return node && { node, lines: [title.trim()] };
  }

  private closeElement(element: OpenElement): void {
    element.node.contentHash = hashText(element.lines);
  }

  private addNode(
    id: string,
    type: string,
    title: string,
    docLevel: DocLevel | undefined,
    source: SourceRef,
    doc: SpecDocument,
  ): SpecNode | undefined {
    const uid = toUid(this.options.project, id);
    const existing = this.nodes.get(uid);
    if (existing) {
      this.issue(
        "L04",
        "error",
        `ID가 중복됩니다: ${id} (처음 정의: ${existing.source.file}:${existing.source.line})`,
        source,
      );
      return undefined;
    }
    const node: SpecNode = {
      uid,
      project: uid.slice(0, uid.indexOf(":")),
      id: uid.slice(uid.indexOf(":") + 1),
      type,
      ...(docLevel && { docLevel }),
      title,
      attrs: {},
      values: {},
      contentHash: hashText([title]),
      source,
    };
    this.nodes.set(uid, node);
    doc.elementUids.push(uid);
    return node;
  }

  private readField(element: OpenElement, label: string, value: string, source: SourceRef): void {
    const { node } = element;
    const labels = node.docLevel && this.options.schema.fieldLabels.get(node.docLevel)?.get(node.type);
    const target = labels?.get(label) ?? labels?.get(ANY_LABEL);

    if (target === "value") {
      node.values[label] = value;
      return;
    }
    const relation = target ? this.options.schema.relations.get(target) : undefined;
    if (!relation) {
      node.attrs[label] = value;
      this.readCitations(node, value, source);
      for (const [, ref] of value.matchAll(REFERENCE)) {
        this.issue("P04", "warning", `관계로 정의되지 않은 필드 "${label}"의 참조는 무시됩니다: ${ref}`, source);
      }
      return;
    }

    node.attrs[label] = value;
    element.fieldRelation = relation;
    const refs = [...value.matchAll(REFERENCE)].map((m) => m[1]!);
    const ordered = value.includes("→");
    refs.forEach((ref, index) => {
      this.connect(relation, node, ref, source, ordered ? { order: index + 1 } : {});
    });
  }

  /** Nested `- AC-…: text` items under a relation field become elements of their own. */
  private readNestedElement(element: OpenElement, text: string, source: SourceRef, doc: SpecDocument): void {
    const match = NESTED_ELEMENT.exec(text.trim());
    const relation = element.fieldRelation!;
    if (!match) {
      element.lines.push(text);
      return;
    }
    const [, id, body] = match as unknown as [string, string, string];
    const type = nodeTypeForId(this.options.schema, id);
    if (!type) {
      this.issue("P01", "warning", `알 수 없는 ID 접두사라 기획 요소로 읽지 않았습니다: ${id}`, source);
      return;
    }
    const child = this.addNode(id, type.name, body.trim(), element.node.docLevel, source, doc);
    if (!child) return;
    this.connect(relation, element.node, id, source, {});
    this.readCitations(child, body, source);
  }

  private readCitations(node: SpecNode, text: string, source: SourceRef): void {
    if (!this.citation) return;
    for (const [, ref, item] of text.matchAll(this.citation.pattern)) {
      this.connect(this.citation.relation, node, ref!, source, { item: item!.trim(), text: text.trim() });
    }
  }

  /** Adds an edge between `node` and `ref`, choosing the direction the schema allows. */
  private connect(
    relation: RelationDef,
    node: SpecNode,
    ref: string,
    source: SourceRef,
    props: Record<string, string | number>,
  ): void {
    const refType = nodeTypeForId(this.options.schema, ref);
    if (!refType) {
      this.issue("P01", "error", `알 수 없는 ID 접두사: ${ref}`, source);
      return;
    }
    const refUid = toUid(this.options.project, ref);
    let from: string;
    let to: string;
    if (relation.from.includes(node.type) && relation.to.includes(refType.name)) {
      [from, to] = [node.uid, refUid];
    } else if (relation.from.includes(refType.name) && relation.to.includes(node.type)) {
      [from, to] = [refUid, node.uid];
    } else {
      this.issue(
        "P02",
        "error",
        `${relation.name} 관계는 ${node.type}와 ${refType.name}를 잇지 않습니다: ${node.id} — ${ref}`,
        source,
      );
      return;
    }
    const key = `${relation.name}|${from}|${to}`;
    if (!this.edges.has(key)) this.edges.set(key, { type: relation.name, from, to, props, source });
  }

  /** `feature: FEAT-SIGNUP` in an FDD links the feature to every requirement in the document. */
  private addFrontMatterRelations(doc: SpecDocument, file: string): void {
    const labels = doc.docLevel && this.options.schema.fieldLabels.get(doc.docLevel)?.get("front_matter");
    if (!labels) return;
    for (const [key, relationName] of labels) {
      const ref = doc.frontMatter[key];
      const relation = this.options.schema.relations.get(relationName);
      if (typeof ref !== "string" || !relation) continue;
      const refType = nodeTypeForId(this.options.schema, ref);
      for (const uid of doc.elementUids) {
        const node = this.nodes.get(uid)!;
        const fits =
          (relation.from.includes(node.type) && relation.to.includes(refType?.name ?? "")) ||
          (relation.to.includes(node.type) && relation.from.includes(refType?.name ?? ""));
        if (fits) this.connect(relation, node, ref, { file, line: 2 }, {});
      }
    }
  }

  /** IA sitemap: a nested list where each item names exactly one screen. */
  private readSitemapLine(line: string, source: SourceRef, stack: { indent: number; uid: string }[]): void {
    const item = /^(\s*)- (.*)$/.exec(line);
    if (!item) return;
    const refs = [...item[2]!.matchAll(REFERENCE)].map((m) => m[1]!);
    if (refs.length !== 1) return;
    const indent = item[1]!.length;
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
    const uid = toUid(this.options.project, refs[0]!);
    const parent = stack.at(-1)?.uid;
    this.sitemap.push({ screen: uid, ...(parent && { parent }), source });
    stack.push({ indent, uid });
  }

  private issue(code: string, severity: ParseIssue["severity"], message: string, source: SourceRef): void {
    this.issues.push({ code, severity, message, source });
  }
}

/** Whitespace-insensitive hash of an element's own lines. */
function hashText(lines: string[]): string {
  const normalized = lines
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
