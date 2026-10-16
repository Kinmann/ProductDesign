import { execFileSync } from "node:child_process";
import type { GraphSnapshot, Schema } from "@specflow/core";
import { lint, staleLinkFindings, withFindings, type LintFinding, type LintResult } from "@specflow/lint";
import { parseSpecs } from "@specflow/parser";
import {
  loadLinkFile,
  loadReviews,
  planIngest,
  planLinks,
  type GraphStore,
  type IngestPlan,
  type LinkPlan,
  type StoredElement,
} from "@specflow/store";

export interface IngestInput {
  /** Specs root first, then overlays. */
  roots: string[];
  project: string;
  schema: Schema;
  store: GraphStore;
  reviewsPath?: string;
  specVersion?: string;
  /** Plan and lint only; never write. */
  dryRun?: boolean;
}

export interface IngestOutcome {
  snapshot: GraphSnapshot;
  plan: IngestPlan;
  lint: LintResult;
  applied: boolean;
}

/**
 * Parse → plan against the stored graph → lint (snapshot rules + L05 + L09) → apply when clean.
 * This is the "merge to main" step of the 1a pipeline: a spec change with errors never reaches the store.
 */
export async function runIngest(input: IngestInput): Promise<IngestOutcome> {
  const { roots, project, schema, store } = input;
  const snapshot = parseSpecs(roots, { project, schema });
  const stored = await store.load(project);
  const plan = planIngest(stored, snapshot, {
    schema,
    reviews: input.reviewsPath ? loadReviews(input.reviewsPath) : [],
    specVersion: input.specVersion ?? specVersionOf(roots),
  });
  const result = withFindings(lint(snapshot, { schema }), [
    ...plan.removed.map(removedFinding),
    ...staleLinkFindings(plan.stale, snapshot.nodes),
  ]);
  const applied = !input.dryRun && result.errors === 0;
  if (applied) await store.applyIngest(plan);
  return { snapshot, plan, lint: result, applied };
}

export async function runLink(store: GraphStore, linksPath: string, schema: Schema, dryRun = false) {
  const file = loadLinkFile(linksPath);
  const plan: LinkPlan = planLinks(await store.load(file.project), file, schema);
  const applied = !dryRun && plan.problems.length === 0;
  if (applied) await store.applyLinks(plan);
  return { plan, applied };
}

function removedFinding(element: StoredElement): LintFinding {
  const [file = "", line = "0"] = element.source.split(/:(?=\d+$)/);
  return {
    code: "L05",
    severity: "error",
    message: `기존 요소가 사라졌습니다: ${element.id}. 삭제하지 말고 "- 상태: deprecated"로 폐기하세요`,
    source: { file, line: Number(line) },
    element: element.id,
  };
}

/** Short commit SHA of the specs folder (`-dirty` with local edits, `+overlay` with overlays); a timestamp outside Git. */
export function specVersionOf(roots: string[]): string {
  const [root] = roots;
  try {
    const sha = execFileSync("git", ["-C", root!, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", root!, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim();
    return `${sha}${dirty ? "-dirty" : ""}${roots.length > 1 ? "+overlay" : ""}`;
  } catch {
    return new Date().toISOString();
  }
}
