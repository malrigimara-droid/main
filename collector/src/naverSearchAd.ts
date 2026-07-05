// ─── 네이버 검색광고 API: 키워드도구 (월간 검색량) ─────────────
// 사전 준비: searchad.naver.com 광고 계정 → 도구 > API 사용 관리에서
// API 라이선스(액세스키/비밀키)와 CUSTOMER_ID 발급. 무료.

import crypto from "node:crypto";
import type { KeywordDemand } from "./types.js";

const BASE = "https://api.searchad.naver.com";

function signature(timestamp: string, method: string, uri: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${method}.${uri}`)
    .digest("base64");
}

function headers(method: string, uri: string) {
  const ts = Date.now().toString();
  const { NAVER_AD_API_KEY, NAVER_AD_SECRET, NAVER_AD_CUSTOMER_ID } = process.env;
  if (!NAVER_AD_API_KEY || !NAVER_AD_SECRET || !NAVER_AD_CUSTOMER_ID) {
    throw new Error("검색광고 API 환경변수 누락: NAVER_AD_API_KEY / NAVER_AD_SECRET / NAVER_AD_CUSTOMER_ID");
  }
  return {
    "X-Timestamp": ts,
    "X-API-KEY": NAVER_AD_API_KEY,
    "X-Customer": NAVER_AD_CUSTOMER_ID,
    "X-Signature": signature(ts, method, uri, NAVER_AD_SECRET),
    "Content-Type": "application/json; charset=UTF-8",
  };
}

/** "< 10" 같은 문자열 응답을 숫자로 정규화 */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.includes("<") ? 5 : Number(v.replace(/[^0-9]/g, "")) || 0;
  return 0;
}

/**
 * 키워드 수요 조회. hintKeywords는 호출당 최대 5개 — 자동으로 배치 분할.
 * 키워드는 공백 제거 필요 ("수지 왁싱" → "수지왁싱").
 */
export async function fetchKeywordDemand(keywords: string[]): Promise<KeywordDemand[]> {
  const uri = "/keywordstool";
  const out: KeywordDemand[] = [];
  const cleaned = [...new Set(keywords.map((k) => k.replace(/\s+/g, "")))];

  for (let i = 0; i < cleaned.length; i += 5) {
    const batch = cleaned.slice(i, i + 5);
    const qs = new URLSearchParams({ hintKeywords: batch.join(","), showDetail: "1" });
    const res = await fetch(`${BASE}${uri}?${qs}`, { headers: headers("GET", uri) });
    if (!res.ok) throw new Error(`검색광고 API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { keywordList?: any[] };

    for (const k of batch) {
      // API는 연관 키워드까지 반환 → 요청 키워드와 정확히 일치하는 행만 사용
      const row = (data.keywordList ?? []).find((r) => r.relKeyword === k);
      if (!row) continue;
      const pc = num(row.monthlyPcQcCnt);
      const mo = num(row.monthlyMobileQcCnt);
      out.push({
        keyword: k,
        monthlyPcCnt: pc,
        monthlyMobileCnt: mo,
        monthlyTotal: pc + mo,
        compIdx: row.compIdx ?? "?",
        fetchedAt: new Date().toISOString(),
      });
    }
    if (i + 5 < cleaned.length) await new Promise((r) => setTimeout(r, 300)); // rate 완충
  }
  return out;
}
