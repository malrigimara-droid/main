// ─── 리뷰 수집 (수동/반자동 인제스트) ──────────────────────────
//
// 설계 원칙: 플레이스 순위·리뷰는 공식 API가 없고, 자동 크롤링은
// 상업 서비스 기준 약관·법적 리스크가 있어 "수집"과 "분석"을 분리한다.
//   - 수집: 사람이 한다 (사장님 또는 운영자가 리뷰 텍스트 붙여넣기/CSV 업로드)
//   - 분석: 기계가 한다 (reviewAnalysis.ts — 완전 자동)
// 운영자가 플레이스 리뷰 페이지에서 전체선택→복사→붙여넣기 하면
// 아래 파서가 개별 리뷰로 분해한다. 가게당 1회 3~5분 작업.
// 추후 정식 데이터 제공 계약/공식 경로가 생기면 ReviewSource 구현체만 교체.

import { randomUUID } from "node:crypto";
import type { RawReview } from "./types.js";

export interface ReviewSource {
  load(): Promise<RawReview[]>;
}

/** 붙여넣은 원문 덩어리를 리뷰 단위로 분해 */
export function parsePastedReviews(blob: string, source: RawReview["source"] = "naver_place"): RawReview[] {
  // 빈 줄 2개 이상 또는 날짜 패턴을 경계로 분할 (붙여넣기 형태가 제각각이라 보수적으로)
  const chunks = blob
    .split(/\n{2,}/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 10); // 너무 짧은 조각 제거

  return chunks.map((text) => {
    const dateMatch = text.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    const visitMatch = text.match(/(\d+)\s*번째\s*방문/);
    const ratingMatch = text.match(/별점\s*(\d(?:\.\d)?)/);
    return {
      id: randomUUID(),
      source,
      text,
      date: dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}` : undefined,
      visitCount: visitMatch ? Number(visitMatch[1]) : undefined,
      rating: ratingMatch ? Number(ratingMatch[1]) : undefined,
    };
  });
}

/** CSV 업로드 경로 (열: text, date, rating, visitCount) */
export function parseCsvReviews(csv: string): RawReview[] {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  return lines.slice(1).map((line) => {
    // 단순 CSV (쉼표 포함 텍스트는 따옴표 처리 가정 — 실서비스에서는 papaparse 사용 권장)
    const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? [];
    return {
      id: randomUUID(),
      source: "manual" as const,
      text: cols[idx("text")] ?? "",
      date: cols[idx("date")] || undefined,
      rating: cols[idx("rating")] ? Number(cols[idx("rating")]) : undefined,
      visitCount: cols[idx("visitcount")] ? Number(cols[idx("visitcount")]) : undefined,
    };
  }).filter((r) => r.text.length >= 10);
}

/** 플레이스 메타데이터도 같은 원칙: 진단 시점 운영자 1회 입력 */
export interface PlaceSnapshotInput {
  storeId: string;
  capturedAt: string;        // 입력 시각
  visitorReviewCount: number;
  blogReviewCount: number;
  rating?: number;
  rankInKeyword?: { keyword: string; rank: number }[]; // 운영자가 확인한 플레이스 순위
}

// ── 동의 게이트를 통과해야만 저장되는 경로 ──────────────────
// 파싱(위 함수들)은 순수 함수지만, "보관"은 반드시 이 함수를 통한다.
// requireConsent 실패 시 저장 자체가 일어나지 않는다.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireConsent, grantAccess } from "./dataLifecycle.js";

const REVIEW_STORE_DIR = process.env.REVIEW_STORE_DIR ?? ".store/reviews";

export async function storeReviews(storeId: string, reviews: RawReview[]): Promise<string> {
  await requireConsent(storeId);                       // 게이트 — 동의 없으면 여기서 throw
  const loc = path.join(REVIEW_STORE_DIR, storeId);
  await mkdir(loc, { recursive: true });
  const file = path.join(loc, `reviews-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(reviews, null, 2), "utf-8");
  await grantAccess({ storeId, type: "review_raw", storageLocation: loc }); // C등급 — 파기 추적 등록
  return file;
}
