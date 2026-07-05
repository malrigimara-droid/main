// ─── 이벤트 로그: 타개의 척추 (append-only) ─────────────────────
//
// 원칙:
//  1. 모든 일은 이벤트로 기록된다. 수정·삭제 없음 (append-only).
//     잘못된 기록은 정정 이벤트를 추가로 쌓는다.
//  2. 세 루프(품질 감시 / 경험 수집 / 검증·전달)는 이 로그의 "뷰"다.
//  3. 동의·접근권·파기도 같은 로그에 쌓인다 — 감사 추적이 공짜로 생긴다.
//  4. v1은 JSONL 파일, v2에서 DB(append-only 테이블)로 교체.
//     스키마가 같으면 마이그레이션은 복사일 뿐이다.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Stage } from "./types.js";

const LOG_DIR = process.env.EVENT_LOG_DIR ?? ".events";
const LOG_FILE = () => path.join(LOG_DIR, "events.jsonl");

// ── 이벤트 타입 (3개 루프 + 데이터 수명주기) ──────────────────

interface Base {
  eventId: string;
  storeId: string;
  at: string;                  // ISO 8601
  actor: "system" | "operator" | "owner" | "chatbot";
}

/** 루프 0: 진단·처방 */
export type DiagnosisEvent = Base & {
  type: "diagnosis";
  industryId: string;
  scoringRuleVersion: string;
  stageScores: { stage: Stage; score: number; confidence: string }[];
  bottleneck: Stage;
  chainScore: number;
};
export type PrescriptionEvent = Base & {
  type: "prescription";
  prescriptionId: string;
  targetStage: Stage;
  action: string;
  expectedMetric: string;
  verifyAfterDays: number;
};

/** 루프 1: 콘텐츠 생성·게시·측정·수정 (품질 감시) */
export type ContentGeneratedEvent = Base & {
  type: "content_generated";
  contentId: string;
  channel: "blog" | "place_news" | "place_photo" | "place_intro" | "instagram" | "message";
  templateVariant: string;     // 구조 변형 풀 식별자 — 저품질 패턴 추적용
  targetKeyword?: string;
  model: string;               // 생성 모델 기록 (품질 비교용)
  sourceEpisodeIds: string[];  // 루프 2와의 연결고리
};
export type ContentPublishedEvent = Base & {
  type: "content_published";
  contentId: string;
  channel: ContentGeneratedEvent["channel"];
  publishedUrl?: string;
  publishMethod: "manual_delegate" | "api" | "owner_self";
};
export type MeasurementEvent = Base & {
  type: "measurement";
  contentId?: string;          // 콘텐츠 단위 측정이면
  metric: "impressions" | "inflow" | "place_views" | "bookings" | "blog_rank" | "review_count";
  value: number;
  window: "d7" | "d21" | "d30";
  source: "smartplace_stats" | "blog_stats" | "operator_input" | "owner_input";
};
export type ContentRevisedEvent = Base & {
  type: "content_revised";
  contentId: string;
  reason: "low_quality_suspected" | "no_inflow" | "owner_request";
  revisionOf: string;          // 이전 contentId
};
export type PrescriptionVerifiedEvent = Base & {
  type: "prescription_verified";
  prescriptionId: string;
  result: "hit" | "miss" | "not_executed";
  evidence: string;            // "유입 d30 +42 (기준 +20)"
};

/** 루프 2: 경험 수집 (챗봇·리뷰·사진) */
export type ChatMessageEvent = Base & {
  type: "chat_message";
  direction: "to_owner" | "from_owner";
  category?: "episode" | "photo" | "question" | "off_topic" | "risk"; // 분류기 결과
  textRef: string;             // 원문은 별도 저장(C등급), 로그에는 참조만 — 파기 용이성
};
export type EpisodeExtractedEvent = Base & {
  type: "episode_extracted";
  episodeId: string;
  source: "owner_chat" | "review" | "quarterly_meeting";
  stageRelevance: Stage;
  summary: string;             // 비식별 요약 (가게 손님 개인정보 금지)
};
export type PhotoReceivedEvent = Base & {
  type: "photo_received";
  photoId: string;
  editApplied?: "tone" | "crop" | "text_overlay" | "none";
};

/** 데이터 수명주기 (동의·접근·파기) — dataLifecycle.ts가 발행 */
export type ConsentEvent = Base & {
  type: "consent_granted" | "consent_withdrawn";
  consentId: string;
  scopeVersion: string;        // 동의서 버전 — 조항 바뀌면 버전 올림
};
export type AccessEvent = Base & {
  type: "access_granted" | "access_revoked";
  grantId: string;
  accessType: "place_member" | "meta_oauth" | "kakao_sender" | "review_raw" | "owner_chat" | "biz_info";
  grade: "A" | "B" | "C";
};
export type DestructionEvent = Base & {
  type: "data_destroyed" | "destruction_notified";
  grantIds: string[];
};

/** 루프 3: 월간 리포트 발행 */
export type ReportEvent = Base & {
  type: "monthly_report_built";
  monthIso: string;
  inflow: number;
  contentsPublished: number;
  episodesUsed: number;
};

/** 루프 1 강화: 게시 전 품질 게이트 + 누적 교훈 */
export type QualityCheckEvent = Base & {
  type: "quality_check";
  contentId: string;
  attempt: number;             // 1=초안, 2+=수정본
  passed: boolean;
  failures: string[];          // 실패 사유 (린트 규칙명·심사 항목)
  judgeScores?: { naturalness: number; specificity: number; adSmell: number };
};
export type LessonEvent = Base & {
  type: "lesson_recorded";
  lessonId: string;
  channel: string;             // "naver_blog" 등 또는 "global"
  lesson: string;              // "왁싱 글에 가격 명시하면 노출 하락" 같은 한 줄 교훈
  source: "quality_gate" | "miss_analysis" | "operator";
};

export type TagaeEvent =
  | DiagnosisEvent | PrescriptionEvent
  | ContentGeneratedEvent | ContentPublishedEvent | MeasurementEvent
  | ContentRevisedEvent | PrescriptionVerifiedEvent
  | ChatMessageEvent | EpisodeExtractedEvent | PhotoReceivedEvent
  | ConsentEvent | AccessEvent | DestructionEvent | ReportEvent
  | QualityCheckEvent | LessonEvent;

// ── 기록/조회 ───────────────────────────────────────────────

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
type NewEvent = DistributiveOmit<TagaeEvent, "eventId" | "at"> & { at?: string };

export async function appendEvent(e: NewEvent): Promise<TagaeEvent> {
  const full = { eventId: randomUUID(), at: e.at ?? new Date().toISOString(), ...e } as TagaeEvent;
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(LOG_FILE(), JSON.stringify(full) + "\n", "utf-8");
  return full;
}

export async function readEvents(filter?: {
  storeId?: string;
  types?: TagaeEvent["type"][];
  since?: string;
}): Promise<TagaeEvent[]> {
  let raw: string;
  try { raw = await readFile(LOG_FILE(), "utf-8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TagaeEvent)
    .filter((e) =>
      (!filter?.storeId || e.storeId === filter.storeId) &&
      (!filter?.types || filter.types.includes(e.type)) &&
      (!filter?.since || e.at >= filter.since));
}

// ── 뷰 1: 적중률 테이블 (타개의 해자) ────────────────────────

export async function hitRateTable(): Promise<
  { key: string; hits: number; misses: number; notExecuted: number; hitRate: number }[]
> {
  const events = await readEvents({ types: ["diagnosis", "prescription", "prescription_verified"] });
  const presc = new Map<string, { storeId: string; targetStage: Stage; industryId?: string }>();
  const industryByStore = new Map<string, string>();

  for (const e of events) {
    if (e.type === "diagnosis") industryByStore.set(e.storeId, e.industryId);
    if (e.type === "prescription") presc.set(e.prescriptionId, { storeId: e.storeId, targetStage: e.targetStage });
  }
  const agg = new Map<string, { hits: number; misses: number; notExecuted: number }>();
  for (const e of events) {
    if (e.type !== "prescription_verified") continue;
    const p = presc.get(e.prescriptionId);
    if (!p) continue;
    const key = `${industryByStore.get(p.storeId) ?? "?"}×${p.targetStage}`; // 비식별: 업종×병목 단위
    const row = agg.get(key) ?? { hits: 0, misses: 0, notExecuted: 0 };
    if (e.result === "hit") row.hits++;
    else if (e.result === "miss") row.misses++;
    else row.notExecuted++;
    agg.set(key, row);
  }
  return [...agg.entries()].map(([key, r]) => ({
    key, ...r,
    hitRate: r.hits + r.misses > 0 ? r.hits / (r.hits + r.misses) : 0,
  }));
}

// ── 뷰 2: 품질 알림 (저품질 조기 탐지) ───────────────────────

export async function qualityAlerts(thresholds = { d7MinImpressions: 10, d21MinInflow: 5 }) {
  const events = await readEvents({ types: ["content_published", "measurement", "content_revised"] });
  const published = events.filter((e) => e.type === "content_published") as ContentPublishedEvent[];
  const measures = events.filter((e) => e.type === "measurement") as MeasurementEvent[];
  const revised = new Set((events.filter((e) => e.type === "content_revised") as ContentRevisedEvent[]).map((e) => e.revisionOf));

  const alerts: { storeId: string; contentId: string; reason: string }[] = [];
  for (const p of published) {
    if (revised.has(p.contentId)) continue; // 이미 수정 들어감
    const m7 = measures.find((m) => m.contentId === p.contentId && m.window === "d7" && m.metric === "impressions");
    const m21 = measures.find((m) => m.contentId === p.contentId && m.window === "d21" && m.metric === "inflow");
    const ageDays = (Date.now() - Date.parse(p.at)) / 86400000;

    if (ageDays >= 9 && !m7) alerts.push({ storeId: p.storeId, contentId: p.contentId, reason: "d7 측정 누락 — 측정부터" });
    else if (m7 && m7.value < thresholds.d7MinImpressions)
      alerts.push({ storeId: p.storeId, contentId: p.contentId, reason: `d7 노출 ${m7.value} < ${thresholds.d7MinImpressions} — 저품질 의심, 수정 큐로` });
    else if (m21 && m21.value < thresholds.d21MinInflow)
      alerts.push({ storeId: p.storeId, contentId: p.contentId, reason: `d21 유입 ${m21.value} < ${thresholds.d21MinInflow} — 키워드/구조 재검토` });
  }
  return alerts;
}

// ── 뷰 3: 월간 리포트 데이터 (사장님 전달용) ──────────────────

export async function monthlyReportData(storeId: string, monthIso: string) {
  const since = `${monthIso}-01`;
  const events = await readEvents({ storeId, since });
  const inMonth = events.filter((e) => e.at.slice(0, 7) === monthIso);
  const sum = (metric: MeasurementEvent["metric"]) =>
    inMonth.filter((e): e is MeasurementEvent => e.type === "measurement" && e.metric === metric)
      .reduce((s, m) => s + m.value, 0);
  return {
    storeId, month: monthIso,
    episodesCollected: inMonth.filter((e) => e.type === "episode_extracted").length,
    contentsPublished: inMonth.filter((e) => e.type === "content_published").length,
    inflow: sum("inflow"),
    bookings: sum("bookings"),
    revisions: inMonth.filter((e) => e.type === "content_revised").length,
    // → 리포트 생성기(LLM)에 이 구조체를 주입: "이번 달 사장님 이야기 N개 → 콘텐츠 N건 → 유입 +N"
  };
}
