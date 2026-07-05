// ─── 월간 리포트 생성기 (루프 3: 검증·전달) ─────────────────────
//
// 구독의 월간 결제 근거를 자동 생산하는 모듈.
// 원칙 그대로: 숫자는 전부 코드가 계산한 facts에서만 나오고, LLM은 문장만 만든다.
// 추가 안전장치 — 숫자 가드: LLM 서술에 facts에 없는 숫자가 등장하면
// 재시도 1회 → 그래도 실패하면 템플릿 문장으로 폴백 (지어낸 성과 수치 원천 차단).

import { callClaudeJson } from "./llm.js";
import { appendEvent, readEvents, monthlyReportData, qualityAlerts } from "./eventLog.js";
import type { EpisodeExtractedEvent, ContentPublishedEvent, TagaeEvent } from "./eventLog.js";
import { deltaReport, dueMeasurements } from "./measurement.js";
import { requireConsent } from "./dataLifecycle.js";
import type { StoreInfo } from "./actionLayer.js";

export interface MonthlyReport {
  storeId: string;
  monthIso: string;
  facts: ReportFacts;
  narrative: string;           // 사장님 인사말 (LLM 또는 폴백)
  narrativeSource: "llm" | "fallback";
  markdown: string;            // 전달용 본문 (알림톡 링크/PDF 변환 원본)
}

export interface ReportFacts {
  month: string;
  prevMonth: string;
  delta: { metric: string; prev: number; curr: number; diff: number; pct: number | null }[];
  contents: { channel: string; count: number }[];
  episodesCollected: number;
  episodeSummaries: string[];  // 비식별 요약 (최대 3)
  prescriptionResults: { hit: number; miss: number };
  pendingActions: number;      // 다음 달로 넘어가는 측정/검증 마감
}

// ── 1. facts 수집 (전부 결정적) ───────────────────────────────

async function collectFacts(storeId: string, monthIso: string, prevMonthIso: string): Promise<ReportFacts> {
  const [monthly, delta, events, due] = await Promise.all([
    monthlyReportData(storeId, monthIso),
    deltaReport(storeId, prevMonthIso, monthIso),
    readEvents({ storeId }),
    dueMeasurements(),
  ]);
  const inMonth = (e: TagaeEvent) => e.at.slice(0, 7) === monthIso;

  const contentsByChannel = new Map<string, number>();
  for (const e of events.filter((e): e is ContentPublishedEvent => e.type === "content_published" && inMonth(e)))
    contentsByChannel.set(e.channel, (contentsByChannel.get(e.channel) ?? 0) + 1);

  const episodes = events
    .filter((e): e is EpisodeExtractedEvent => e.type === "episode_extracted" && inMonth(e));

  let hit = 0, miss = 0;
  for (const e of events) if (e.type === "prescription_verified" && inMonth(e)) {
    if ((e as any).result === "hit") hit++;
    else if ((e as any).result === "miss") miss++;
  }

  return {
    month: monthIso, prevMonth: prevMonthIso,
    delta: delta.rows
      .filter((r) => (r as any)[prevMonthIso] > 0 || (r as any)[monthIso] > 0)
      .map((r) => ({ metric: r.metric, prev: (r as any)[prevMonthIso], curr: (r as any)[monthIso],
        diff: r.delta, pct: r.pct })),
    contents: [...contentsByChannel.entries()].map(([channel, count]) => ({ channel, count })),
    episodesCollected: monthly.episodesCollected,
    episodeSummaries: episodes.slice(0, 3).map((e) => e.summary),
    prescriptionResults: { hit, miss },
    pendingActions: due.filter((d) => d.storeId === storeId).length,
  };
}

// ── 2. 숫자 가드: 서술 속 숫자가 facts 출신인지 검증 ──────────

function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,\.]*/g) ?? []).map((n) => n.replace(/[,\.]+$/, "").replace(/,/g, ""));
}
function allowedNumbers(facts: ReportFacts): Set<string> {
  const allowed = new Set<string>();
  const add = (n: number | null) => { if (n != null) { allowed.add(String(Math.abs(n))); } };
  for (const d of facts.delta) { add(d.prev); add(d.curr); add(d.diff); add(d.pct); }
  for (const c of facts.contents) add(c.count);
  add(facts.episodesCollected); add(facts.prescriptionResults.hit); add(facts.prescriptionResults.miss);
  add(facts.pendingActions);
  // 에피소드 요약 속 숫자도 facts 출신 — 허용 ("3년 단골" 등)
  for (const s of facts.episodeSummaries) for (const n of numbersIn(s)) allowed.add(n);
  // 날짜 표기 허용 (연·월)
  for (const m of [facts.month, facts.prevMonth]) { allowed.add(m.slice(0, 4)); allowed.add(String(Number(m.slice(5, 7)))); allowed.add(m.slice(5, 7)); }
  return allowed;
}
export function narrativePassesGuard(narrative: string, facts: ReportFacts): boolean {
  const allowed = allowedNumbers(facts);
  return numbersIn(narrative).every((n) => allowed.has(n));
}

// ── 3. 폴백 템플릿 (LLM 실패/가드 위반 시) ────────────────────

const METRIC_KO: Record<string, string> = {
  place_views: "플레이스 조회", inflow: "유입", bookings: "예약", review_count: "리뷰",
};
function fallbackNarrative(store: StoreInfo, f: ReportFacts): string {
  const top = f.delta.filter((d) => d.diff > 0).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
  const lines = [`${store.name} 사장님, ${Number(f.month.slice(5, 7))}월 리포트입니다.`];
  if (top) lines.push(`${METRIC_KO[top.metric] ?? top.metric}이(가) ${top.prev} → ${top.curr}(으)로 ${top.pct != null ? `+${top.pct}%` : `+${top.diff}`} 늘었습니다.`);
  if (f.episodesCollected > 0) lines.push(`사장님이 들려주신 이야기 ${f.episodesCollected}개가 콘텐츠 원료로 쌓였습니다.`);
  const totalContents = f.contents.reduce((s, c) => s + c.count, 0);
  if (totalContents > 0) lines.push(`이번 달 게시물 ${totalContents}건이 나갔습니다.`);
  return lines.join(" ");
}

// ── 4. 메인 ──────────────────────────────────────────────────

export async function buildMonthlyReport(opts: {
  store: StoreInfo & { storeId: string };
  monthIso: string;            // "2026-06"
  prevMonthIso: string;        // "2026-05"
  llm?: typeof callClaudeJson;
}): Promise<MonthlyReport> {
  await requireConsent(opts.store.storeId);
  const llm = opts.llm ?? callClaudeJson;
  const facts = await collectFacts(opts.store.storeId, opts.monthIso, opts.prevMonthIso);

  // LLM 서술 (숫자 가드 + 재시도 1회 + 폴백)
  let narrative = "";
  let narrativeSource: "llm" | "fallback" = "fallback";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await llm<{ narrative: string }>({
        model: "claude-sonnet-4-6",   // 짧은 인사말 — Sonnet으로 충분
        maxTokens: 600,
        system:
          "월간 리포트 인사말 작성자. JSON만: {\"narrative\"}. 4~6문장, 구어체 존댓말. " +
          "제공된 facts의 숫자만 그대로 사용하고 새 숫자를 만들지 않는다. " +
          "에피소드 요약이 있으면 1개를 자연스럽게 언급한다. 과장·확신 어조 금지.",
        prompt: `가게: ${opts.store.name} (${opts.store.industry})\nfacts:\n${JSON.stringify(facts, null, 1)}`,
        validate: (o): o is { narrative: string } => typeof o?.narrative === "string" && o.narrative.length > 20,
      });
      if (narrativePassesGuard(out.narrative, facts)) {
        narrative = out.narrative; narrativeSource = "llm"; break;
      }
    } catch { /* 재시도 */ }
  }
  if (!narrative) narrative = fallbackNarrative(opts.store, facts);

  // 마크다운 본문 — 숫자 표는 100% 코드 렌더
  const md = [
    `# ${opts.store.name} — ${Number(opts.monthIso.slice(5, 7))}월 마케팅 리포트`,
    ``, narrative, ``,
    `## 한 달의 변화 (${facts.prevMonth} → ${facts.month})`,
    ...facts.delta.map((d) =>
      `- ${METRIC_KO[d.metric] ?? d.metric}: ${d.prev} → **${d.curr}** (${d.diff >= 0 ? "+" : ""}${d.diff}${d.pct != null ? `, ${d.pct >= 0 ? "+" : ""}${d.pct}%` : ""})`),
    ``,
    `## 이번 달 한 일`,
    `- 게시물 ${facts.contents.reduce((s, c) => s + c.count, 0)}건 (${facts.contents.map((c) => `${c.channel} ${c.count}`).join(", ") || "없음"})`,
    `- 사장님 이야기 수집 ${facts.episodesCollected}건${facts.episodeSummaries.length ? ` — 예: ${facts.episodeSummaries[0]}` : ""}`,
    facts.prescriptionResults.hit + facts.prescriptionResults.miss > 0
      ? `- 처방 검증: 적중 ${facts.prescriptionResults.hit} / 미달 ${facts.prescriptionResults.miss}` : ``,
    ``,
    `## 다음 달`,
    `- 예정된 측정·검증 ${facts.pendingActions}건 — 결과는 다음 리포트에서 보여드립니다.`,
  ].filter((l, i, arr) => l !== `` || (arr[i - 1] !== `` && i !== arr.length - 1)).join("\n");

  await appendEvent({
    type: "monthly_report_built", storeId: opts.store.storeId, actor: "system",
    monthIso: opts.monthIso,
    inflow: facts.delta.find((d) => d.metric === "inflow")?.curr ?? 0,
    contentsPublished: facts.contents.reduce((s, c) => s + c.count, 0),
    episodesUsed: facts.episodesCollected,
  });

  return { storeId: opts.store.storeId, monthIso: opts.monthIso, facts, narrative, narrativeSource, markdown: md };
}
