// ─── 채널 레지스트리: 유입 우주 전체의 온톨로지 ─────────────────
//
// 문제의식: 측정하기 쉬운 채널(플레이스)만 보면 "가로등 밑에서 열쇠 찾기"가 된다.
// 소상공인 유입 요소 전체를 등재하고, 우선순위는 사람 감이 아니라 계산으로 뽑는다.
//
// 우선순위 점수 = 업종 관련도 × 병목 단계 기여도 × 즉시성 보정 × 측정가능성 보정 / 노력
//  - 업종 관련도: 이 업종에서 이 채널이 실제 유입을 만드는가 (0~1)
//  - 병목 기여도: 진단된 병목 단계(DISCOVER/CONVERT/RETAIN/REFER)에 기여하는 비중
//  - 즉시성: 효과 발현까지 걸리는 날짜 — 빠를수록 가중 (사장님 신뢰는 첫 30일에 결정된다)
//  - 측정가능성: 측정 못 하는 채널은 적중률 루프에 못 들어가므로 감점 (배제는 아님)
//  - 노력: 타개+사장님의 실행 비용
//
// 채널 추가/조정 = 데이터 1줄. 코드 변경 없음.

import type { Stage } from "./types.js";

export interface ChannelDef {
  id: string;
  label: string;
  stageContribution: Record<Stage, number>;  // 합 1.0
  immediacyDays: number;       // 실행 → 효과 체감까지 통상 일수
  effortLevel: 1 | 2 | 3;      // 1=실행물만 1회, 2=반복 운영 필요, 3=촬영·방문 등 무거움
  costLevel: 0 | 1 | 2 | 3;    // 0=무료, 3=월 수십만원
  measurability: "direct" | "proxy" | "hard";
  // direct: 숫자 직접 확보(통계/API), proxy: 간접 추정(쿠폰코드, "어떻게 오셨어요"),
  // hard: 사실상 측정 불가
  tagaeAutomation: "full" | "assisted" | "manual";
  metricHint: string;          // 무엇으로 측정하는지
}

export const CHANNELS: ChannelDef[] = [
  { id: "naver_place", label: "네이버 플레이스(지도)",
    stageContribution: { DISCOVER: 0.5, CONVERT: 0.4, RETAIN: 0.05, REFER: 0.05 },
    immediacyDays: 7, effortLevel: 1, costLevel: 0, measurability: "direct",
    tagaeAutomation: "assisted", metricHint: "플레이스 조회·스마트콜·길찾기 (통계 화면)" },
  { id: "naver_blog", label: "네이버 블로그",
    stageContribution: { DISCOVER: 0.55, CONVERT: 0.4, RETAIN: 0, REFER: 0.05 },
    immediacyDays: 21, effortLevel: 2, costLevel: 0, measurability: "direct",
    tagaeAutomation: "assisted", metricHint: "노출 순위(검색 API)·블로그 유입 통계" },
  { id: "naver_power_link", label: "네이버 검색광고(파워링크·플레이스광고)",
    stageContribution: { DISCOVER: 0.8, CONVERT: 0.2, RETAIN: 0, REFER: 0 },
    immediacyDays: 2, effortLevel: 1, costLevel: 2, measurability: "direct",
    tagaeAutomation: "full", metricHint: "광고 클릭·전환 (검색광고 API)" },
  { id: "instagram", label: "인스타그램(피드·릴스)",
    stageContribution: { DISCOVER: 0.45, CONVERT: 0.35, RETAIN: 0.1, REFER: 0.1 },
    immediacyDays: 14, effortLevel: 3, costLevel: 0, measurability: "direct",
    tagaeAutomation: "full", metricHint: "도달·프로필 방문 (Meta API)" },
  { id: "danggeun", label: "당근 비즈프로필·동네광고",
    stageContribution: { DISCOVER: 0.6, CONVERT: 0.3, RETAIN: 0.05, REFER: 0.05 },
    immediacyDays: 5, effortLevel: 1, costLevel: 1, measurability: "direct",
    tagaeAutomation: "assisted", metricHint: "조회·단골·채팅 문의 (비즈프로필 통계)" },
  { id: "kakao_channel", label: "카카오 채널·알림톡",
    stageContribution: { DISCOVER: 0, CONVERT: 0.1, RETAIN: 0.8, REFER: 0.1 },
    immediacyDays: 3, effortLevel: 1, costLevel: 1, measurability: "direct",
    tagaeAutomation: "full", metricHint: "발송·클릭·재예약 전환" },
  { id: "google_maps", label: "구글 지도·리뷰",
    stageContribution: { DISCOVER: 0.55, CONVERT: 0.4, RETAIN: 0, REFER: 0.05 },
    immediacyDays: 14, effortLevel: 1, costLevel: 0, measurability: "direct",
    tagaeAutomation: "assisted", metricHint: "비즈니스 프로필 인사이트" },
  { id: "local_community", label: "지역 카페·맘카페",
    stageContribution: { DISCOVER: 0.4, CONVERT: 0.4, RETAIN: 0, REFER: 0.2 },
    immediacyDays: 7, effortLevel: 2, costLevel: 1, measurability: "proxy",
    tagaeAutomation: "manual", metricHint: "쿠폰코드·\"어떻게 오셨어요\" 집계" },
  { id: "review_program", label: "체험단·리뷰 프로그램",
    stageContribution: { DISCOVER: 0.3, CONVERT: 0.6, RETAIN: 0, REFER: 0.1 },
    immediacyDays: 30, effortLevel: 2, costLevel: 2, measurability: "proxy",
    tagaeAutomation: "manual", metricHint: "리뷰 수 증가 → 전환율 변화" },
  { id: "referral", label: "소개·추천 프로그램(입소문 장치화)",
    stageContribution: { DISCOVER: 0.1, CONVERT: 0.2, RETAIN: 0.1, REFER: 0.6 },
    immediacyDays: 30, effortLevel: 2, costLevel: 1, measurability: "proxy",
    tagaeAutomation: "assisted", metricHint: "추천 쿠폰 사용 건수" },
  { id: "offline_signage", label: "오프라인(간판·배너·전단)",
    stageContribution: { DISCOVER: 0.7, CONVERT: 0.3, RETAIN: 0, REFER: 0 },
    immediacyDays: 7, effortLevel: 3, costLevel: 2, measurability: "hard",
    tagaeAutomation: "manual", metricHint: "\"지나가다 봤어요\" 구두 집계뿐" },
  { id: "delivery_apps", label: "배달앱(배민·쿠팡이츠)",
    stageContribution: { DISCOVER: 0.5, CONVERT: 0.4, RETAIN: 0.1, REFER: 0 },
    immediacyDays: 7, effortLevel: 2, costLevel: 3, measurability: "direct",
    tagaeAutomation: "manual", metricHint: "앱 내 주문 통계" },
];

// ── 업종별 관련도 행렬 (0~1). 업종 추가 = 1줄 ─────────────────

export const INDUSTRY_RELEVANCE: Record<string, Record<string, number>> = {
  waxing: { naver_place: 1.0, naver_blog: 0.8, naver_power_link: 0.6, instagram: 0.7,
    danggeun: 0.6, kakao_channel: 0.9, google_maps: 0.3, local_community: 0.7,
    review_program: 0.6, referral: 0.8, offline_signage: 0.3, delivery_apps: 0 },
  cafe: { naver_place: 1.0, naver_blog: 0.7, naver_power_link: 0.3, instagram: 1.0,
    danggeun: 0.5, kakao_channel: 0.4, google_maps: 0.6, local_community: 0.5,
    review_program: 0.7, referral: 0.3, offline_signage: 0.7, delivery_apps: 0.5 },
  restaurant: { naver_place: 1.0, naver_blog: 0.8, naver_power_link: 0.4, instagram: 0.8,
    danggeun: 0.4, kakao_channel: 0.3, google_maps: 0.7, local_community: 0.6,
    review_program: 0.8, referral: 0.4, offline_signage: 0.8, delivery_apps: 0.9 },
  derma_clinic: { naver_place: 0.9, naver_blog: 1.0, naver_power_link: 0.9, instagram: 0.7,
    danggeun: 0.2, kakao_channel: 0.8, google_maps: 0.4, local_community: 0.9,
    review_program: 0.3, referral: 0.7, offline_signage: 0.4, delivery_apps: 0 },
  craft_class: { naver_place: 0.7, naver_blog: 0.7, naver_power_link: 0.4, instagram: 1.0,
    danggeun: 0.9, kakao_channel: 0.7, google_maps: 0.2, local_community: 0.8,
    review_program: 0.4, referral: 0.6, offline_signage: 0.3, delivery_apps: 0 },
};

// ── 우선순위 계산 ────────────────────────────────────────────

const MEASURABILITY_FACTOR = { direct: 1.0, proxy: 0.8, hard: 0.5 };

export interface ChannelPriority {
  channelId: string;
  label: string;
  score: number;               // 0~100 정규화
  relevance: number;
  stageContribution: number;
  immediacyDays: number;
  measurability: ChannelDef["measurability"];
  rationale: string;
}

export function prioritizeChannels(
  industryId: string,
  bottleneck: Stage,
  opts?: { maxCostLevel?: 0 | 1 | 2 | 3; horizonDays?: number },
): ChannelPriority[] {
  const relevanceRow = INDUSTRY_RELEVANCE[industryId];
  if (!relevanceRow) throw new Error(`업종 관련도 미등록: ${industryId} — INDUSTRY_RELEVANCE에 1줄 추가`);
  const horizon = opts?.horizonDays ?? 30;   // 사장님 신뢰가 결정되는 기간
  const maxCost = opts?.maxCostLevel ?? 3;

  const rows = CHANNELS
    .filter((c) => c.costLevel <= maxCost && (relevanceRow[c.id] ?? 0) > 0)
    .map((c) => {
      const relevance = relevanceRow[c.id] ?? 0;
      const stageC = c.stageContribution[bottleneck];
      // 즉시성: horizon 내 효과면 1.0, 넘어가면 체감 (절벽이 아니라 경사)
      const immediacy = Math.min(1, horizon / Math.max(c.immediacyDays, 1)) ** 0.5;
      const raw = (relevance * stageC * immediacy * MEASURABILITY_FACTOR[c.measurability]) / Math.sqrt(c.effortLevel);
      return { c, relevance, stageC, raw };
    });

  const maxRaw = Math.max(...rows.map((r) => r.raw), 1e-9);
  return rows
    .map(({ c, relevance, stageC, raw }) => ({
      channelId: c.id, label: c.label,
      score: Math.round((raw / maxRaw) * 100),
      relevance, stageContribution: stageC,
      immediacyDays: c.immediacyDays, measurability: c.measurability,
      rationale: `관련도 ${relevance} × ${bottleneck} 기여 ${stageC} × 즉시성 ${c.immediacyDays}일 × 측정 ${c.measurability} ÷ 노력 ${c.effortLevel}`,
    }))
    .sort((a, b) => b.score - a.score);
}

// ── 측정 계획 생성: 우선 채널의 측정 방법까지 한 번에 ──────────
// (actionLayer가 이 결과를 받아 "어떤 채널의 실행물을 만들지" 결정하고,
//  measurement 모듈이 metricHint대로 측정 항목을 등록한다)

export function measurementPlan(priorities: ChannelPriority[], topN = 3) {
  return priorities.slice(0, topN).map((p) => {
    const def = CHANNELS.find((c) => c.id === p.channelId)!;
    return {
      channelId: p.channelId,
      how: def.metricHint,
      caveat: def.measurability === "hard"
        ? "정량 측정 불가 — 효과 주장에 쓰지 말 것. 보조 채널로만."
        : def.measurability === "proxy"
          ? "간접 측정 — 쿠폰코드/방문 경로 질문 설계 필수 (없으면 적중률 기록 불가)"
          : null,
    };
  });
}
