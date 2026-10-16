import { readFileSync } from "node:fs";
import { parse } from "yaml";

export const DOC_LEVELS = ["prd", "fdd", "ia"] as const;
export type DocLevel = (typeof DOC_LEVELS)[number];

export const PROPAGATIONS = ["forward", "reverse", "both", "none"] as const;
export type Propagate = (typeof PROPAGATIONS)[number];

export const WEIGHTS = ["low", "medium", "high"] as const;
export type Weight = (typeof WEIGHTS)[number];

/** Field-label targets that become node attributes instead of relations. */
export const ATTRIBUTE_TARGETS = ["value", "description"] as const;

/** Relation endpoint wildcard meaning "any node type in the spec domain". */
const ANY_SPEC = "*spec";

export interface NodeTypeDef {
  name: string;
  idPrefix?: string;
  domain?: string;
  docLevels: DocLevel[];
  props: string[];
}

export interface RelationDef {
  name: string;
  from: string[];
  to: string[];
  propagate: Propagate;
  weight?: Weight;
  maxDepth?: number;
  traceability: boolean;
  props: string[];
}

export interface CitationRule {
  docLevel: DocLevel;
  pattern: string;
  relation: string;
}

export interface Schema {
  version: number;
  commonProps: string[];
  uniqueProps: string[];
  indexes: string[];
  nodeTypes: Map<string, NodeTypeDef>;
  relations: Map<string, RelationDef>;
  /** docLevel → scope (node type or "front_matter") → field label → relation name or attribute target. */
  fieldLabels: Map<DocLevel, Map<string, Map<string, string>>>;
  citations: CitationRule[];
  syncRelations: string[];
}

export class SchemaError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid ontology schema:\n- ${problems.join("\n- ")}`);
    this.name = "SchemaError";
  }
}

export function loadSchemaFile(path: string): Schema {
  return parseSchema(readFileSync(path, "utf8"));
}

export function parseSchema(source: string): Schema {
  const raw: unknown = parse(source);
  const problems: string[] = [];
  const doc = asRecord(raw, "schema root", problems);

  const nodeTypes = new Map<string, NodeTypeDef>();
  for (const [name, value] of Object.entries(asRecord(doc.node_types, "node_types", problems))) {
    const def = asRecord(value, `node_types.${name}`, problems);
    const docLevels = toList(def.doc_level).filter((level): level is DocLevel => {
      const ok = (DOC_LEVELS as readonly string[]).includes(level);
      if (!ok) problems.push(`node_types.${name}: unknown doc_level "${level}"`);
      return ok;
    });
    nodeTypes.set(name, {
      name,
      ...(typeof def.id_prefix === "string" && { idPrefix: def.id_prefix }),
      ...(typeof def.domain === "string" && { domain: def.domain }),
      docLevels,
      props: toList(def.props),
    });
  }

  const specTypes = [...nodeTypes.values()].filter((t) => t.domain === "spec").map((t) => t.name);
  const resolveEndpoints = (value: unknown, where: string): string[] =>
    toList(value).flatMap((name) => {
      if (name === ANY_SPEC) return specTypes;
      if (!nodeTypes.has(name)) problems.push(`${where}: unknown node type "${name}"`);
      return [name];
    });

  const relations = new Map<string, RelationDef>();
  for (const [name, value] of Object.entries(asRecord(doc.relations, "relations", problems))) {
    const def = asRecord(value, `relations.${name}`, problems);
    const propagate = def.propagate;
    if (!(PROPAGATIONS as readonly unknown[]).includes(propagate)) {
      problems.push(`relations.${name}: propagate must be one of ${PROPAGATIONS.join(", ")}`);
    }
    const weight = def.weight;
    if (weight !== undefined && !(WEIGHTS as readonly unknown[]).includes(weight)) {
      problems.push(`relations.${name}: weight must be one of ${WEIGHTS.join(", ")}`);
    }
    const maxDepth = def.max_depth;
    if (maxDepth !== undefined && !(Number.isInteger(maxDepth) && (maxDepth as number) > 0)) {
      problems.push(`relations.${name}: max_depth must be a positive integer`);
    }
    relations.set(name, {
      name,
      from: resolveEndpoints(def.from, `relations.${name}.from`),
      to: resolveEndpoints(def.to, `relations.${name}.to`),
      propagate: propagate as Propagate,
      ...(weight !== undefined && { weight: weight as Weight }),
      ...(maxDepth !== undefined && { maxDepth: maxDepth as number }),
      traceability: def.traceability === true,
      props: toList(def.props),
    });
  }

  const fieldLabels = new Map<DocLevel, Map<string, Map<string, string>>>();
  const citations: CitationRule[] = [];
  for (const [level, scopes] of Object.entries(asRecord(doc.field_labels, "field_labels", problems))) {
    if (!(DOC_LEVELS as readonly string[]).includes(level)) {
      problems.push(`field_labels: unknown doc level "${level}"`);
      continue;
    }
    const docLevel = level as DocLevel;
    const byScope = new Map<string, Map<string, string>>();
    for (const [scope, labels] of Object.entries(asRecord(scopes, `field_labels.${level}`, problems))) {
      const where = `field_labels.${level}.${scope}`;
      const entries = asRecord(labels, where, problems);
      if (scope === "citation") {
        const relation = String(entries.relation);
        if (!relations.has(relation)) problems.push(`${where}: unknown relation "${relation}"`);
        citations.push({ docLevel, pattern: String(entries.pattern), relation });
        continue;
      }
      if (scope !== "front_matter" && !nodeTypes.has(scope)) {
        problems.push(`${where}: unknown node type "${scope}"`);
      }
      const byLabel = new Map<string, string>();
      for (const [label, target] of Object.entries(entries)) {
        const name = String(target);
        if (!relations.has(name) && !(ATTRIBUTE_TARGETS as readonly string[]).includes(name)) {
          problems.push(`${where}."${label}": unknown relation or attribute "${name}"`);
        }
        byLabel.set(label, name);
      }
      byScope.set(scope, byLabel);
    }
    fieldLabels.set(docLevel, byScope);
  }

  const syncRelations = toList(doc.sync_relations);
  for (const name of syncRelations) {
    if (!relations.has(name)) problems.push(`sync_relations: unknown relation "${name}"`);
  }

  const uniqueProps = (Array.isArray(doc.constraints) ? doc.constraints : []).flatMap((c: unknown) =>
    isRecord(c) && typeof c.unique === "string" ? [c.unique] : [],
  );

  if (typeof doc.version !== "number") problems.push("version must be a number");
  if (problems.length > 0) throw new SchemaError(problems);

  return {
    version: doc.version as number,
    commonProps: toList(doc.common_props),
    uniqueProps,
    indexes: toList(doc.indexes),
    nodeTypes,
    relations,
    fieldLabels,
    citations,
    syncRelations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, where: string, problems: string[]): Record<string, unknown> {
  if (isRecord(value)) return value;
  problems.push(`${where} must be a mapping`);
  return {};
}

function toList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}
