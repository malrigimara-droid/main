// ─── 공통 타입 ───────────────────────────────────────────────

export type Stage = "DISCOVER" | "CONVERT" | "RETAIN" | "REFER";

/** 검색광고 API 키워드도구 결과 (수요) */
export interface KeywordDemand {
  keyword: string;
  monthlyPcCnt: number;
  monthlyMobileCnt: number;
  monthlyTotal: number;
  compIdx: "낮음" | "중간" | "높음" | string; // 광고 경쟁도
  fetchedAt: string;
}

/** 블로그 검색 상위 노출 1건 */
export interface BlogExposure {
  rank: number;            // 1-base
  title: string;
  link: string;
  bloggerName: string;
  bloggerLink: string;
  postDate: string;        // YYYYMMDD
  matchedEntity: string | null; // 추적 대상 업체명 (별칭 매칭 결과)
}

/** 키워드 1개에 대한 점유 분석 */
export interface KeywordShare {
  keyword: string;
  demand: KeywordDemand | null;
  exposures: BlogExposure[];
  shareByEntity: Record<string, number>; // 업체명 → 상위 N 중 점유 비율
  myShare: number;
  topCompetitor: { name: string; share: number } | null;
  opportunity: "OWNED" | "CONTESTED" | "COMPETITOR_OWNED" | "EMPTY";
  // EMPTY = 수요는 있는데 추적 업체 누구도 상위 점유 못함 → 공략 1순위
}

/** 상권×업종 키워드 점유 맵 (캐시 단위) */
export interface ShareMap {
  tradeArea: string;       // 예: "용인 수지"
  industry: string;        // 예: "waxing"
  myEntityName: string;
  generatedAt: string;
  keywords: KeywordShare[];
}

// ─── 리뷰 분석 ───────────────────────────────────────────────

/** 수동/반자동 수집된 리뷰 원본 (플레이스·영수증 리뷰 붙여넣기) */
export interface RawReview {
  id: string;
  source: "naver_place" | "naver_receipt" | "instagram" | "manual";
  text: string;
  date?: string;
  rating?: number;         // 별점이 있는 소스만
  visitCount?: number;     // "N번째 방문" 표기가 있으면
}

export interface ReviewAnalysis {
  storeId: string;
  reviewCount: number;
  analyzedAt: string;
  sentiment: { positive: number; neutral: number; negative: number }; // 비율
  topics: ReviewTopic[];
  revisitSignals: {
    explicitRevisitMentions: number;  // "재방문", "N년째", "단골" 등
    revisitRate: number | null;       // visitCount 데이터 있을 때만
    loyaltyQuotes: string[];          // 대표 문장 (리포트 인용용, 3개 이내)
  };
  riskFlags: { topic: string; severity: "high" | "medium"; evidence: string }[];
  stageEvidence: Partial<Record<Stage, string>>; // 수익 사슬 단계별 근거 요약
  summaryForOwner: string; // 사장님용 3문장 요약
}

export interface ReviewTopic {
  topic: string;           // 예: "시술 만족도", "통증 관리", "위생", "예약 편의", "가격"
  mentions: number;
  sentiment: "positive" | "mixed" | "negative";
  representativeQuote: string;
}
