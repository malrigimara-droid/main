// ─── 리뷰 내용 분석 (Claude API, 구조화 JSON 강제) ──────────────
//
// 원칙 (PART 2-C와 동일):
//  - 숫자 집계(리뷰 수, 재방문 언급 횟수 등)는 코드가 먼저 계산
//  - LLM은 토픽 분류·감성·근거 문장 추출만 담당
//  - 출력 JSON 스키마 강제 + 검증 실패 시 재시도 1회 상한
//  - 모델: 분류 작업이므로 haiku로 충분 (비용 통제)

import { callClaude } from "./llm.js";
import type { RawReview, ReviewAnalysis, ReviewTopic } from "./types.js";

const REVISIT_PATTERNS = /(재방문|또\s*방문|다시\s*방문|단골|[1-9]\d*\s*년째|n번째|믿고\s*(가|찾))/;

interface TopicRow {
  topic: string;
  sentiment: "positive" | "mixed" | "negative";
  mentionReviewIds: string[];
  representativeQuote: string;
}
interface LlmOutput {
  sentimentByReview: { id: string; sentiment: "positive" | "neutral" | "negative" }[];
  topics: TopicRow[];
  riskFlags: { topic: string; severity: "high" | "medium"; evidence: string }[];
  loyaltyQuotes: string[];
  stageEvidence: { CONVERT?: string; RETAIN?: string; REFER?: string };
  summaryForOwner: string;
}

function validate(o: any): o is LlmOutput {
  return o && Array.isArray(o.sentimentByReview) && Array.isArray(o.topics)
    && Array.isArray(o.riskFlags) && typeof o.summaryForOwner === "string";
}

const SYSTEM =
  "당신은 소상공인 리뷰 분석기다. 반드시 유효한 JSON만 출력한다. " +
  "마크다운 코드펜스, 설명문 금지. 리뷰에 없는 내용을 지어내지 않는다. " +
  "representativeQuote와 loyaltyQuotes는 리뷰 원문에서 그대로 발췌한다.";

function buildPrompt(storeId: string, industry: string, reviews: RawReview[]): string {
  const lines = reviews.map((r) => `[${r.id.slice(0, 8)}] ${r.text.replace(/\n/g, " ").slice(0, 500)}`).join("\n");
  return `업종: ${industry} / 가게: ${storeId}
아래 고객 리뷰들을 분석해 다음 JSON 스키마로만 응답하라.

{
  "sentimentByReview": [{"id": "리뷰id 앞8자", "sentiment": "positive|neutral|negative"}],
  "topics": [{"topic": "토픽명", "sentiment": "positive|mixed|negative", "mentionReviewIds": ["id"], "representativeQuote": "원문 발췌 1문장"}],
  "riskFlags": [{"topic": "토픽", "severity": "high|medium", "evidence": "원문 발췌"}],
  "loyaltyQuotes": ["재방문/신뢰를 보여주는 원문 발췌 최대 3개"],
  "stageEvidence": {"CONVERT": "첫 방문 결정에 영향 줄 요소 요약", "RETAIN": "재방문 동인 요약", "REFER": "추천 의향 신호 요약"},
  "summaryForOwner": "사장님에게 전달할 3문장 요약"
}

토픽은 5~8개로 묶어라 (예: 시술 만족도, 통증 관리, 위생/청결, 상담/친절, 예약 편의, 가격, 매장 환경).
riskFlags는 부정 언급이 2건 이상 반복되는 토픽만 포함하라.

리뷰:
${lines}`;
}

export async function analyzeReviews(
  storeId: string,
  industry: string,
  reviews: RawReview[],
): Promise<ReviewAnalysis> {
  if (reviews.length === 0) {
    // "측정 불가"를 정직하게 — 이것 자체가 진단 결과
    return {
      storeId, reviewCount: 0, analyzedAt: new Date().toISOString(),
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      topics: [], riskFlags: [],
      revisitSignals: { explicitRevisitMentions: 0, revisitRate: null, loyaltyQuotes: [] },
      stageEvidence: {},
      summaryForOwner: "분석할 리뷰가 없습니다. 리뷰 확보 자체가 1순위 처방입니다.",
    };
  }

  // ① 결정적 집계 (코드)
  const explicitRevisit = reviews.filter((r) => REVISIT_PATTERNS.test(r.text)).length;
  const withVisitCount = reviews.filter((r) => r.visitCount != null);
  const revisitRate = withVisitCount.length >= 10
    ? withVisitCount.filter((r) => (r.visitCount ?? 0) >= 2).length / withVisitCount.length
    : null;

  // ② LLM 분류 (배치: 50건씩 — 토큰·비용 통제)
  const batches: RawReview[][] = [];
  for (let i = 0; i < reviews.length; i += 50) batches.push(reviews.slice(i, i + 50));

  const merged: LlmOutput = {
    sentimentByReview: [], topics: [], riskFlags: [],
    loyaltyQuotes: [], stageEvidence: {}, summaryForOwner: "",
  };
  for (const batch of batches) {
    let parsed: LlmOutput | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const raw = await callClaude({ system: SYSTEM, prompt: buildPrompt(storeId, industry, batch) });
      try {
        const candidate = JSON.parse(raw.replace(/```json|```/g, "").trim());
        if (validate(candidate)) parsed = candidate;
      } catch { /* 재시도 1회 */ }
    }
    if (!parsed) throw new Error("리뷰 분석 LLM 출력 파싱 실패 (재시도 초과)");
    merged.sentimentByReview.push(...parsed.sentimentByReview);
    merged.topics.push(...parsed.topics);
    merged.riskFlags.push(...parsed.riskFlags);
    merged.loyaltyQuotes.push(...parsed.loyaltyQuotes);
    merged.stageEvidence = { ...merged.stageEvidence, ...parsed.stageEvidence };
    merged.summaryForOwner = parsed.summaryForOwner; // 마지막 배치 요약 사용 (v2: 별도 요약 패스)
  }

  // ③ 코드에서 최종 합성 — 비율은 LLM이 아니라 여기서 계산
  const total = merged.sentimentByReview.length || 1;
  const count = (s: string) => merged.sentimentByReview.filter((r) => r.sentiment === s).length / total;

  const topicMap = new Map<string, ReviewTopic>();
  for (const t of merged.topics) {
    const prev = topicMap.get(t.topic);
    topicMap.set(t.topic, {
      topic: t.topic,
      mentions: (prev?.mentions ?? 0) + t.mentionReviewIds.length,
      sentiment: prev && prev.sentiment !== t.sentiment ? "mixed" : t.sentiment,
      representativeQuote: prev?.representativeQuote ?? t.representativeQuote,
    });
  }

  return {
    storeId,
    reviewCount: reviews.length,
    analyzedAt: new Date().toISOString(),
    sentiment: { positive: count("positive"), neutral: count("neutral"), negative: count("negative") },
    topics: [...topicMap.values()].sort((a, b) => b.mentions - a.mentions),
    revisitSignals: {
      explicitRevisitMentions: explicitRevisit,
      revisitRate,
      loyaltyQuotes: merged.loyaltyQuotes.slice(0, 3),
    },
    riskFlags: merged.riskFlags,
    stageEvidence: merged.stageEvidence,
    summaryForOwner: merged.summaryForOwner,
  };
}
