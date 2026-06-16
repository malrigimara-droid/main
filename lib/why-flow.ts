// lib/why-flow.ts — "왜 막혔나 + 왜 이 순서로 푸나" 엔진
//
// 설계 원칙 (collector 철학 계승):
//  - 판단·순서·정직성 가드는 코드가 결정 (결정성)
//  - 헤드라인 톤은 confidence가 강제 — 단, 확신은 살리고 '가짜 측정'만 막는다
//  - 측정 공백은 즉시 처방이 아니라, 설문 답(gapAnswer)으로 갈라 처리
//  - 확장 순서는 보편 정답이 없음 → 두 길을 다 만들어 주고 선택은 사장님이
//
// 입력 의존:
//  - reach        : 업종 성격 (업종 프로필에 1줄: 왁싱=proximity, 공방=destination)
//  - readings     : 단계별 점수 + 측정 신뢰도
//  - gapAnswers   : 인테이크 설문에서 받은 "그 단계 어떻게 챙기세요?" 답
//  - candidates   : share-map 결과 (키워드별 수요·점유·내 순위)

import type { Stage } from "./types"; // "DISCOVER" | "CONVERT" | "RETAIN" | "REFER"

// ── 0. 단계 측정 상태 ────────────────────────────────────────
export type Confidence = "measured" | "estimated" | "unmeasured";

export interface StageReading {
  stage: Stage;
  label: string;                 // "재방문"
  score: number | null;          // unmeasured면 null
  confidence: Confidence;
  evidenceSource: string | null; // "플레이스 통계" | "리뷰 추정" | null
}

// ── 1. 측정 공백 해소: 설문 답이 갈래를 정한다 ────────────────
// (질문은 인테이크 설문에서 미리 받는다 — 진단 화면 즉석 질문 아님)
//   "managed_elsewhere" = 사장님이 외부(캐치테이블·전화장부 등)로 이미 관리 중 → 처방 아님, 데이터 연결만
//   "true_gap"          = 챙기는 장치 자체가 없음 → 비로소 1순위 처방 후보
export type GapResolution = "managed_elsewhere" | "true_gap";
export type GapAnswers = Partial<Record<Stage, GapResolution>>;

// 인테이크 설문 문항 생성기 (unmeasured 단계마다 1문항)
export function gapQuestion(r: StageReading): { stage: Stage; question: string; options: { label: string; resolves: GapResolution }[] } {
  return {
    stage: r.stage,
    question: `${r.label}을 지금 어떻게 챙기세요?`,
    options: [
      { label: "네이버예약/캐치테이블/전화장부 등으로 관리 중", resolves: "managed_elsewhere" },
      { label: "따로 안 함", resolves: "true_gap" },
    ],
  };
}

// ── 2. 정직성 가드: 확신은 살리고 '가짜 측정'만 막는다 ─────────
// 차단: 측정 안 한 수치/상태를 '사실'로 단정 ("재방문율 X%", "샙니다")
// 권장: 위험·우선순위·방향을 확신 있게 ("가장 위험한 구멍", "제일 무섭다")
const FABRICATED_FACT = /(\d+\s*%|\d+\s*명|\d+\s*건)\s*(샌|줄|떨어)/; // 미측정 수치+단정 동사
const DEFINITIVE_FACT = ["샙니다", "샌다", "떨어집니다", "줄고 있"];   // 미측정인데 사실 단정

export function guardNarrative(text: string, r: StageReading): { ok: boolean; reason?: string } {
  if (r.confidence === "measured") return { ok: true }; // 측정됐으면 뭐든 단정 OK
  if (FABRICATED_FACT.test(text)) return { ok: false, reason: "미측정 수치를 사실로 단정" };
  const hit = DEFINITIVE_FACT.find((w) => text.includes(w));
  return hit ? { ok: false, reason: `미측정 단계(${r.label})에 사실 단정 "${hit}"` } : { ok: true };
}

// confidence별 헤드라인 — 톤은 세게, 가짜 사실만 뺀다
function headline(r: StageReading): string {
  if (r.confidence === "measured")
    return `${r.label} 점수 ${r.score}/100 — 실측입니다.`;
  if (r.confidence === "estimated")
    return `${r.label}은 리뷰로 추정한 값이에요(${r.score}/100). 참고로 보시고, 정확한 건 측정으로 확인합니다.`;
  // unmeasured: 확신(위험·우선순위)은 살리고, "X% 샌다"(가짜 측정)만 뺀다
  return `지금 가장 위험한 구멍은 ${r.label}입니다. 측정조차 안 되고 있어요 — 새는지 보이지도 않는 게 제일 무섭습니다.`;
}

// ── 3. 병목 선정 ─────────────────────────────────────────────
// true_gap(측정장치 없음)인 unmeasured 단계를 최우선으로 승격.
// managed_elsewhere는 승격하지 않음 (사장님이 이미 하고 있으니 헛다리 금지).
export function pickBottleneck(readings: StageReading[], gaps: GapAnswers): StageReading {
  const trueGap = readings.find((r) => r.confidence === "unmeasured" && gaps[r.stage] === "true_gap");
  if (trueGap) return trueGap;
  const scored = readings.filter((r) => r.score != null);
  return scored.reduce((a, b) => (a.score! <= b.score! ? a : b));
}

// ── 4. 키워드 사다리 — 두 길을 다 만든다 (선택은 사장님) ────────
export type Reach = "proximity" | "hybrid" | "destination";
export type GeoLevel = "dong" | "gu" | "city";

export interface KeywordCandidate {
  keyword: string; geoLevel: GeoLevel; monthlyTotal: number;
  opportunity: "EMPTY" | "CONTESTED" | "COMPETITOR_OWNED" | "OWNED";
  myRank: number | null;
}

export interface LadderRung {
  order: number; keyword: string; phase: "win_now" | "contest" | "prize";
  why: string;
  execution: { channel: string; action: string; owner: "tagae" | "owner" | "both" };
  evaluation: { metric: string; window: "d7" | "d21" | "d30"; hit: string; onMiss: string };
}

export interface RouteOption {
  route: "정공법" | "속효";
  oneLiner: string;           // 토글 버튼에 보일 한 줄
  rungs: LadderRung[];
}

const DONG_DEMAND_FLOOR = 30;
const rank = (c: KeywordCandidate) => (c.opportunity === "EMPTY" ? 0 : c.opportunity === "CONTESTED" ? 1 : 2);

// 지리 확장 허용 여부 — 업종 성격이 결정 (왁싱은 동 고수, 공방은 구로 확장)
function expandGeo(reach: Reach, dongDemand: number): boolean {
  if (reach === "destination") return dongDemand < DONG_DEMAND_FLOOR * 4;
  if (reach === "hybrid") return dongDemand < DONG_DEMAND_FLOOR;
  return false; // proximity
}

function phaseOf(c: KeywordCandidate): LadderRung["phase"] {
  return c.opportunity === "EMPTY" ? "win_now" : c.opportunity === "CONTESTED" ? "contest" : "prize";
}

// 정공법: organic, 작은 것부터 쌓아 올림 (느리지만 내 자산)
function organicRung(c: KeywordCandidate, i: number): LadderRung {
  const phase = phaseOf(c);
  return {
    order: i + 1, keyword: c.keyword, phase,
    why: phase === "win_now" ? `무주공산(월 ${c.monthlyTotal}) → 직접 써서 빠른 첫 승, 신뢰 확보`
       : phase === "contest" ? `중간 경쟁 — 1칸 authority로 진입`
       : `상금(월 ${c.monthlyTotal}, 경쟁高) — 자산 쌓은 뒤 마지막`,
    execution: { channel: "naver_blog", action: `'${c.keyword}' 정보형 글 직접 1편/주 + 플레이스 반영`, owner: "both" },
    evaluation: { metric: "blog_rank", window: "d21", hit: "상위 30위 진입 or 유입 +N", onMiss: "구조 변형 회전 후 재시도" },
  };
}

// 속효: amplified(유료 상위노출·카페), 큰 것부터 즉시 (빠르지만 비용·임대)
function amplifiedRung(c: KeywordCandidate, i: number): LadderRung {
  const phase = phaseOf(c);
  return {
    order: i + 1, keyword: c.keyword, phase,
    why: `지금 효과 우선 → '${c.keyword}'(월 ${c.monthlyTotal}) 상위노출·카페로 즉시 노출 확보`,
    execution: { channel: "naver_blog+cafe", action: `'${c.keyword}' 상위노출/체험단/카페 작업(유료)`, owner: "tagae" },
    evaluation: { metric: "inflow", window: "d7", hit: "d7 유입·문의 +N", onMiss: "소재·매체 교체" },
  };
}

// 두 길을 동시에 만들어 반환 → 결과 화면에서 사장님이 토글
export function buildRoutes(candidates: KeywordCandidate[], reach: Reach, dongDemand: number): RouteOption[] {
  const expand = expandGeo(reach, dongDemand);
  const pool = (expand ? candidates : candidates.filter((c) => c.geoLevel === "dong"))
    .filter((c) => c.opportunity !== "OWNED");

  const organic = [...pool].sort((a, b) => rank(a) - rank(b) || b.monthlyTotal - a.monthlyTotal).slice(0, 3);
  const amplified = [...pool].sort((a, b) => b.monthlyTotal - a.monthlyTotal).slice(0, 2); // 큰 것부터

  return [
    { route: "정공법", oneLiner: "직접 꾸준히 써서 내 자산으로 — 느리지만 오래 갑니다", rungs: organic.map(organicRung) },
    { route: "속효", oneLiner: "상위노출·카페로 지금 효과 — 빠르지만 비용·임대입니다", rungs: amplified.map(amplifiedRung) },
  ];
}

// ── 5. 오케스트레이터 ────────────────────────────────────────
export interface WhyFlowInput {
  reach: Reach;
  readings: StageReading[];
  gapAnswers: GapAnswers;        // 인테이크에서 미리 받은 답
  candidates: KeywordCandidate[];
  dongDemand: number;
}
export interface WhyFlowResult {
  bottleneck: StageReading;
  headline: string;              // 가드 통과한 헤드라인
  prescriptionKind: "keyword_routes" | "retention_loop" | "referral_loop" | "connect_data";
  routes?: RouteOption[];        // 발견/전환 병목일 때만 — 사장님이 토글로 선택
  note: string;
}

export function whyFlow(input: WhyFlowInput): WhyFlowResult {
  const bottleneck = pickBottleneck(input.readings, input.gapAnswers);
  const headlineText = headline(bottleneck);

  // 사장님이 외부로 이미 관리 중인 단계가 병목으로 잡혔다면: 처방이 아니라 데이터 연결
  if (bottleneck.confidence === "unmeasured" && input.gapAnswers[bottleneck.stage] === "managed_elsewhere") {
    return { bottleneck, headline: headlineText, prescriptionKind: "connect_data",
      note: `${bottleneck.label}은 이미 외부 도구로 관리 중 — 그 데이터만 연결하면 측정이 살아납니다.` };
  }

  // 발견/전환 병목 → 키워드 게임 (두 길 제시)
  if (bottleneck.stage === "DISCOVER" || bottleneck.stage === "CONVERT") {
    const routes = buildRoutes(input.candidates, input.reach, input.dongDemand);
    const expanded = expandGeo(input.reach, input.dongDemand);
    return { bottleneck, headline: headlineText, prescriptionKind: "keyword_routes", routes,
      note: expanded ? "동 수요 얇음 → 구(區)까지 확장 후보 포함" : "발견은 동 단위로 충분 → 확장 보류, 동 키워드 위주" };
  }

  // 재방문/추천 병목 → 키워드 확장 안 함, 루프(측정장치)부터
  return {
    bottleneck, headline: headlineText,
    prescriptionKind: bottleneck.stage === "RETAIN" ? "retention_loop" : "referral_loop",
    note: "발견·전환은 충분. 키워드 확장보다 재방문/추천 장치부터 — 측정이 곧 처방.",
  };
}
