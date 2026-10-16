import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { Review } from "./types.ts";

/** Default location inside the specs folder, so confirmations travel with the spec change (PR). */
export function defaultReviewsPath(specsDir: string): string {
  return join(specsDir, ".specflow", "reviews.yaml");
}

export function loadReviews(path: string): Review[] {
  if (!existsSync(path)) return [];
  const doc = parse(readFileSync(path, "utf8")) as { reviews?: Review[] } | null;
  return doc?.reviews ?? [];
}

export function addReview(path: string, review: Review): Review[] {
  const reviews = loadReviews(path).filter((r) => !(r.element === review.element && r.upper === review.upper));
  reviews.push(review);
  mkdirSync(dirname(path), { recursive: true });
  const header =
    '# "변경 없음" 확인 기록 (린트 L09). 상위 요소의 이 내용(upperHash)을 보고 하위 요소를 검토했다는 뜻이다.\n' +
    "# 상위 요소가 다시 바뀌면 해시가 달라져 확인이 무효가 된다.\n";
  writeFileSync(path, header + stringify({ reviews }));
  return reviews;
}
