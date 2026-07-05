// ─── 측정 모듈: 통계 입력 → 이벤트 → 마감목록·델타·검증 ─────────
//
// 수집 원칙은 동일: 스마트플레이스/블로그 통계는 위임 권한으로 사람이
// 열람해 숫자만 입력한다 (화면 보고 30초). 입력된 순간부터는 전부 자동:
// measurement 이벤트 적재 → 품질 알림 → 적중률 검증 → 델타 리포트.
//
// 측정이 누락되면 적중률 테이블이 죽는다. 그래서 이 모듈의 진짜 핵심은
// dueMeasurements() — "오늘 측정할 것" 목록을 시스템이 사람에게 시키는 구조.

import { appendEvent, readEvents } from "./eventLog.js";
import type { ContentPublishedEvent, MeasurementEvent, PrescriptionEvent } from "./eventLog.js";
import { requireConsent } from "./dataLifecycle.js";

// ── 1. 입력 (운영자/사장님) ──────────────────────────────────

/** 가게 단위 월간 통계 입력 (스마트플레이스 통계 화면 → 숫자 3~4개) */
export async function recordPlaceStats(opts: {
  storeId: string;
  monthIso: string;            // "2026-06"
  placeViews: number;          // 플레이스 조회수
  inflow: number;              // 유입(스마트콜+길찾기+홈피 클릭 등 합)
  bookings?: number;           // 예약 건수 (예약 사용 가게만)
  reviewCount?: number;
  source?: MeasurementEvent["source"];
}) {
  await requireConsent(opts.storeId);
  const base = {
    storeId: opts.storeId,
    actor: "operator" as const,
    at: `${opts.monthIso}-28T23:59:59.000Z`, // 해당 월에 귀속
    window: "d30" as const,
    source: opts.source ?? ("smartplace_stats" as const),
  };
  await appendEvent({ ...base, type: "measurement", metric: "place_views", value: opts.placeViews });
  await appendEvent({ ...base, type: "measurement", metric: "inflow", value: opts.inflow });
  if (opts.bookings != null) await appendEvent({ ...base, type: "measurement", metric: "bookings", value: opts.bookings });
  if (opts.reviewCount != null) await appendEvent({ ...base, type: "measurement", metric: "review_count", value: opts.reviewCount });
}

/** 콘텐츠 단위 측정 입력 (게시물의 d7/d21 노출·유입) */
export async function recordContentMetric(opts: {
  storeId: string;
  contentId: string;
  metric: MeasurementEvent["metric"];
  value: number;
  window: MeasurementEvent["window"];
  source?: MeasurementEvent["source"];
}) {
  await requireConsent(opts.storeId);
  await appendEvent({
    type: "measurement", storeId: opts.storeId, actor: "operator",
    contentId: opts.contentId, metric: opts.metric, value: opts.value,
    window: opts.window, source: opts.source ?? "operator_input",
  });
}

// ── 2. 마감 목록: "오늘 측정/검증할 것" ──────────────────────

export interface DueItem {
  storeId: string;
  kind: "content_d7" | "content_d21" | "prescription_verify";
  refId: string;               // contentId 또는 prescriptionId
  dueSince: string;            // 언제부터 마감이었는지
  note: string;
}

export async function dueMeasurements(now = new Date()): Promise<DueItem[]> {
  const events = await readEvents();
  const published = events.filter((e): e is ContentPublishedEvent => e.type === "content_published");
  const measures = events.filter((e): e is MeasurementEvent => e.type === "measurement");
  const prescriptions = events.filter((e): e is PrescriptionEvent => e.type === "prescription");
  const verified = new Set(
    events.filter((e) => e.type === "prescription_verified").map((e: any) => e.prescriptionId));

  const due: DueItem[] = [];
  const days = (iso: string) => (now.getTime() - Date.parse(iso)) / 86400000;
  const hasWindow = (contentId: string, w: MeasurementEvent["window"]) =>
    measures.some((m) => m.contentId === contentId && m.window === w);

  for (const p of published) {
    if (days(p.at) >= 7 && !hasWindow(p.contentId, "d7"))
      due.push({ storeId: p.storeId, kind: "content_d7", refId: p.contentId,
        dueSince: new Date(Date.parse(p.at) + 7 * 86400000).toISOString().slice(0, 10),
        note: `${p.channel} 게시물 7일 노출 측정` });
    if (days(p.at) >= 21 && !hasWindow(p.contentId, "d21"))
      due.push({ storeId: p.storeId, kind: "content_d21", refId: p.contentId,
        dueSince: new Date(Date.parse(p.at) + 21 * 86400000).toISOString().slice(0, 10),
        note: `${p.channel} 게시물 21일 유입 측정` });
  }
  for (const pr of prescriptions) {
    if (!verified.has(pr.prescriptionId) && days(pr.at) >= pr.verifyAfterDays)
      due.push({ storeId: pr.storeId, kind: "prescription_verify", refId: pr.prescriptionId,
        dueSince: new Date(Date.parse(pr.at) + pr.verifyAfterDays * 86400000).toISOString().slice(0, 10),
        note: `처방 검증: ${pr.action} → ${pr.expectedMetric}` });
  }
  return due.sort((a, b) => a.dueSince.localeCompare(b.dueSince));
}

// ── 3. 처방 검증: 측정값 기반 hit/miss 판정 보조 ─────────────

/**
 * 판정 자체는 단순 규칙: 기준 대비 delta가 임계 이상이면 hit.
 * v1에서 임계는 처방별 고정값, v2에서 적중률 데이터 기반으로 조정.
 */
export async function verifyPrescription(opts: {
  storeId: string;
  prescriptionId: string;
  baseline: number;            // 처방 전 값 (예: 전월 유입)
  current: number;             // 처방 후 값
  minImprovement: number;      // hit 기준 (절대값. 예: 유입 +10)
  executed: boolean;           // 사장님/우리가 실제 실행했는가
}) {
  const delta = opts.current - opts.baseline;
  const result = !opts.executed ? "not_executed" : delta >= opts.minImprovement ? "hit" : "miss";
  await appendEvent({
    type: "prescription_verified", storeId: opts.storeId, actor: "operator",
    prescriptionId: opts.prescriptionId, result,
    evidence: `baseline ${opts.baseline} → ${opts.current} (Δ${delta >= 0 ? "+" : ""}${delta}, 기준 +${opts.minImprovement})`,
  });
  return { result, delta };
}

// ── 4. 델타 리포트: 전월 대비 변화 ───────────────────────────

export async function deltaReport(storeId: string, monthA: string, monthB: string) {
  const events = await readEvents({ storeId, types: ["measurement"] });
  const sum = (month: string, metric: MeasurementEvent["metric"]) =>
    (events as MeasurementEvent[])
      .filter((m) => m.at.slice(0, 7) === month && m.metric === metric && m.window === "d30" && !m.contentId)
      .reduce((s, m) => s + m.value, 0);

  const metrics: MeasurementEvent["metric"][] = ["place_views", "inflow", "bookings", "review_count"];
  const rows = metrics.map((metric) => {
    const a = sum(monthA, metric);
    const b = sum(monthB, metric);
    return { metric, [monthA]: a, [monthB]: b, delta: b - a,
      pct: a > 0 ? Math.round(((b - a) / a) * 100) : null };
  });
  return { storeId, from: monthA, to: monthB, rows };
  // → 월간 리포트 생성기에서 이 rows를 LLM에 주입:
  //   "플레이스 조회 1,240 → 1,610 (+30%)" 같은 사장님 문장으로 변환
}
