// ─── 품질 게이트: 게시 전 검증 루프 (분 단위 반복) ──────────────
//
// 검증 루프 3겹 구조에서 가장 안쪽(가장 빠른) 루프:
//   [안] 게시 전 게이트: 생성 → 린트+심사 → 실패 사유 피드백 → 수정 재생성 (분 단위, 최대 N회)
//   [중] 게시 후 측정: d7/d21 → 품질 알림 → content_revised (일 단위) — qualityAlerts (기존)
//   [밖] 누적 교훈: miss 분석 → lesson 기록 → 이후 모든 생성 프롬프트에 주입 (영구)
//
// 원칙:
//  - 린트(결정적 규칙)가 먼저, LLM 심사는 그 다음 — 싼 검사로 비싼 검사를 아낀다
//  - 수정 루프는 반드시 상한 (기본 2회). 무한 수정은 비용 사고 + 과적합
//  - 상한 도달 시 자동 게시 금지 → needs_human (사람이 보는 게 마지막 게이트)
//  - 모든 시도는 quality_check 이벤트로 — "몇 번 만에 통과했나" 자체가 품질 지표

import { randomUUID } from "node:crypto";
import { callClaudeJson } from "./llm.js";
import { appendEvent, readEvents } from "./eventLog.js";
import type { ContentGeneratedEvent, LessonEvent } from "./eventLog.js";
import type { ChannelAsset } from "./channelDeliverables.js";
import type { StoreInfo } from "./actionLayer.js";

// ── 1. 린트: 결정적 규칙 (0원, 즉시) ─────────────────────────

const AI_CLICHES = [
  "하는 것이 중요합니다", "라고 할 수 있습니다", "에 대해 알아보겠습니다",
  "어떠셨나요", "마무리하며", "도움이 되셨길", "함께 알아보아요",
  "최고의 선택", "완벽한", "여러분", "지금 바로",
];
const BANNED_CLAIMS = [
  "부작용 없", "100%", "보장합니다", "유일한", "최저가", "전혀 아프지 않",
  "효과를 약속", "확실하게", "1위",
];
const LENGTH_BOUNDS: Record<string, [number, number]> = {
  "블로그 초안": [1000, 2200],
  "플레이스 새소식": [80, 350],
  "당근 비즈프로필 소식": [100, 450],
  "재방문 메시지": [20, 100],
  "릴스 컷리스트+캡션": [150, 1200],
  "검색광고 소재": [30, 400],
  "사진 컷리스트": [150, 1200],
};

export interface LintResult { passed: boolean; failures: string[]; }

export function lintAsset(asset: ChannelAsset, opts?: { targetKeyword?: string | null }): LintResult {
  const failures: string[] = [];
  const text = `${asset.title ?? ""}\n${asset.body}`;

  for (const c of AI_CLICHES) if (text.includes(c)) failures.push(`AI상투구:"${c}"`);
  for (const b of BANNED_CLAIMS) if (text.includes(b)) failures.push(`금칙표현:"${b}"`);

  const bounds = LENGTH_BOUNDS[asset.kind];
  if (bounds && (asset.body.length < bounds[0] || asset.body.length > bounds[1]))
    failures.push(`길이위반:${asset.body.length}자 (허용 ${bounds[0]}~${bounds[1]})`);

  if (asset.kind === "블로그 초안" && opts?.targetKeyword) {
    const n = text.split(opts.targetKeyword.replace(/\s+/g, "")).length - 1
      + text.split(opts.targetKeyword).length - 1;
    if (n < 2) failures.push(`키워드부족:"${opts.targetKeyword}" ${n}회 (최소 2회)`);
    if (n > 8) failures.push(`키워드과다:"${opts.targetKeyword}" ${n}회 (스팸 신호)`);
  }
  return { passed: failures.length === 0, failures };
}

/** 같은 변형 연속 사용 검사 (저품질 시그니처) — 게이트와 별도로 생성 전 호출 가능 */
export async function variantFatigue(storeId: string, channel: string, variant: string): Promise<boolean> {
  const recent = (await readEvents({ storeId, types: ["content_generated"] }))
    .filter((e): e is ContentGeneratedEvent => e.type === "content_generated" && (e as any).channel === channel)
    .slice(-2);
  return recent.length === 2 && recent.every((e) => e.templateVariant === variant);
}

// ── 2. LLM 심사 (Haiku 루브릭 — 린트 통과분만) ────────────────

export interface JudgeResult {
  naturalness: number;         // 1~5: 사람이 쓴 글 같은가
  specificity: number;         // 1~5: 이 가게만의 구체성이 있는가 (어느 가게든 되는 글=1)
  adSmell: number;             // 1~5: 광고 티 (낮을수록 좋음)
  verdict: "pass" | "revise";
  reasons: string[];
}
const validateJudge = (o: any): o is JudgeResult =>
  [o?.naturalness, o?.specificity, o?.adSmell].every((n) => n >= 1 && n <= 5)
  && ["pass", "revise"].includes(o?.verdict) && Array.isArray(o?.reasons);

const PASS_BAR = { naturalness: 4, specificity: 3, adSmellMax: 2 };

async function judge(asset: ChannelAsset, store: StoreInfo, llm: typeof callClaudeJson): Promise<JudgeResult> {
  const out = await llm<JudgeResult>({
    model: process.env.REVIEW_MODEL ?? "claude-haiku-4-5-20251001",
    maxTokens: 300,
    system:
      "소상공인 콘텐츠 품질 심사관. JSON만: " +
      '{"naturalness":1-5,"specificity":1-5,"adSmell":1-5,"verdict":"pass|revise","reasons":[]}. ' +
      "naturalness: AI 티·기계적 구조면 감점. specificity: 가게명만 바꾸면 어디든 쓸 수 있는 글이면 1점. " +
      "adSmell: 광고 상투구·과장 어조일수록 높음. " +
      `기준 미달(자연 ${PASS_BAR.naturalness}↑, 구체 ${PASS_BAR.specificity}↑, 광고티 ${PASS_BAR.adSmellMax}↓ 중 하나라도 위반)이면 revise + 사유.`,
    prompt: `업종 ${store.industry}, 종류 [${asset.kind}]:\n"""${asset.body.slice(0, 1800)}"""`,
    validate: validateJudge,
  });
  // 점수와 판정의 일관성은 코드가 최종 결정 (LLM verdict는 참고)
  const failed = out.naturalness < PASS_BAR.naturalness
    || out.specificity < PASS_BAR.specificity
    || out.adSmell > PASS_BAR.adSmellMax;
  return { ...out, verdict: failed ? "revise" : "pass" };
}

// ── 3. 누적 교훈 (가장 바깥 루프 → 가장 안쪽 루프로 주입) ──────

export async function recordLesson(opts: {
  storeId: string; channel: string; lesson: string;
  source?: LessonEvent["source"];
}) {
  await appendEvent({
    type: "lesson_recorded", storeId: opts.storeId, actor: "operator",
    lessonId: randomUUID(), channel: opts.channel, lesson: opts.lesson.slice(0, 200),
    source: opts.source ?? "operator",
  });
}

/** 채널별 최신 교훈 N개 — 생성·수정 프롬프트에 주입 */
export async function topLessons(channel: string, n = 3): Promise<string[]> {
  const events = (await readEvents({ types: ["lesson_recorded"] })) as LessonEvent[];
  return events
    .filter((e) => e.channel === channel || e.channel === "global")
    .slice(-n)
    .map((e) => e.lesson);
}

// ── 4. 게이트 본체: 생성물 → 검사 → 피드백 수정 → 재검사 ──────

export interface GatedAsset extends ChannelAsset {
  gate: "passed" | "needs_human";
  attempts: number;
  lastFailures: string[];
}

export async function hardenAsset(opts: {
  asset: ChannelAsset;
  store: StoreInfo & { storeId: string };
  targetKeyword?: string | null;
  maxAttempts?: number;        // 기본 2 (초안 포함 총 3회 검사)
  llm?: typeof callClaudeJson;
}): Promise<GatedAsset> {
  const llm = opts.llm ?? callClaudeJson;
  const maxAttempts = opts.maxAttempts ?? 2;
  let current = { ...opts.asset };
  let failures: string[] = [];
  const lessons = await topLessons(current.channel);

  for (let attempt = 1; attempt <= maxAttempts + 1; attempt++) {
    // ① 린트 (무료) → ② 심사 (Haiku)
    const lint = lintAsset(current, { targetKeyword: opts.targetKeyword });
    let judgeFailures: string[] = [];
    let judgeScores: { naturalness: number; specificity: number; adSmell: number } | undefined;
    if (lint.passed) {
      const j = await judge(current, opts.store, llm);
      judgeScores = { naturalness: j.naturalness, specificity: j.specificity, adSmell: j.adSmell };
      if (j.verdict === "revise") judgeFailures = j.reasons.length ? j.reasons : ["심사 기준 미달"];
    }
    failures = [...lint.failures, ...judgeFailures];
    const passed = failures.length === 0;

    await appendEvent({
      type: "quality_check", storeId: opts.store.storeId, actor: "system",
      contentId: current.contentId, attempt, passed, failures, judgeScores,
    });

    if (passed) return { ...current, gate: "passed", attempts: attempt, lastFailures: [] };
    if (attempt > maxAttempts) break;

    // ③ 실패 사유를 명시한 수정 재생성 (피드백 루프의 핵심)
    const revised = await llm<{ title?: string; body: string }>({
      model: process.env.DELIVERABLE_MODEL ?? "claude-opus-4-8",
      maxTokens: 4000,
      system:
        "콘텐츠 수정자. JSON만: {\"title?\",\"body\"}. 지적된 문제만 고치고 검증된 사실·인용은 보존한다. " +
        "새 정보·새 숫자·새 후기를 추가하지 않는다.",
      prompt: `종류 [${current.kind}] 수정 요청.
지적 사항 (전부 해소할 것):\n${failures.map((f) => `- ${f}`).join("\n")}
${lessons.length ? `\n이 채널의 누적 교훈 (위반 금지):\n${lessons.map((l) => `- ${l}`).join("\n")}` : ""}
\n원문:\n"""${current.body}"""`,
      validate: (o): o is { title?: string; body: string } => typeof o?.body === "string" && o.body.length > 10,
    });
    current = { ...current, title: revised.title ?? current.title, body: revised.body };
  }

  // 상한 도달 — 자동 게시 금지, 사람 검토 큐로
  return { ...current, gate: "needs_human", attempts: maxAttempts + 1, lastFailures: failures };
}

/** 실행 계획 전체에 게이트 적용 */
export async function hardenPlan(opts: {
  assets: ChannelAsset[];
  store: StoreInfo & { storeId: string };
  targetKeyword?: string | null;
  llm?: typeof callClaudeJson;
}): Promise<{ passed: GatedAsset[]; needsHuman: GatedAsset[] }> {
  const results: GatedAsset[] = [];
  for (const a of opts.assets)
    results.push(await hardenAsset({ asset: a, store: opts.store, targetKeyword: opts.targetKeyword, llm: opts.llm }));
  return {
    passed: results.filter((r) => r.gate === "passed"),
    needsHuman: results.filter((r) => r.gate === "needs_human"),
  };
}

// ── 5. 게이트 통계: "몇 번 만에 통과하나" 자체가 품질 지표 ──────

export async function gateStats() {
  const checks = await readEvents({ types: ["quality_check"] });
  const byContent = new Map<string, { attempts: number; passed: boolean; failures: string[] }>();
  for (const e of checks as any[]) {
    const prev = byContent.get(e.contentId);
    byContent.set(e.contentId, {
      attempts: Math.max(prev?.attempts ?? 0, e.attempt),
      passed: e.passed || (prev?.passed ?? false),
      failures: [...(prev?.failures ?? []), ...e.failures],
    });
  }
  const rows = [...byContent.values()];
  const failureCounts = new Map<string, number>();
  for (const r of rows) for (const f of r.failures) {
    const key = f.split(":")[0]; // 규칙명 단위 집계
    failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  }
  return {
    contents: rows.length,
    firstPassRate: rows.length ? rows.filter((r) => r.attempts === 1 && r.passed).length / rows.length : 0,
    needsHumanRate: rows.length ? rows.filter((r) => !r.passed).length / rows.length : 0,
    topFailures: [...failureCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    // firstPassRate가 오르면 프롬프트·교훈이 작동 중이라는 뜻 — 시스템 자체의 KPI
  };
}
