// ─── AI 답변 노출 실측: 질문 매트릭스 (MEPiX 120셀의 타개 버전) ──
//
// keywordShareMap과 동형: 수요=질문, 노출=등장, 점유=Share of Voice.
// 원칙:
//  - 질문 생성은 템플릿(결정적) — 지역×업종이 우리 문해력
//  - 등장 판정은 코드(별칭 매칭) — LLM 판정 금지
//  - 집계·비율 전부 코드. LLM 호출은 "엔진에게 물어보기" 단 한 곳
//  - citations 못 주는 엔진은 null(미측정) — 0%로 거짓말하지 않는다
//  - 스냅샷은 measurement 이벤트로 적재 → 재실측 델타 → 예측 채점(hitRateTable)
//    ← MEPiX(1회 스냅샷)에 없는 검증 루프. 타개 차별축.

import { appendEvent } from "./eventLog.js";
import type { EntityAlias } from "./keywordShareMap.js";

// ── 1. 질문 생성: 의도 4종 × 지역·업종 템플릿 ─────────────────

export type Intent = "conversion" | "info" | "compare" | "situation";

export interface ProbeQuestion {
  id: string;              // "industry:i:area" — 재실측 시 동일 id가 델타의 전제
  intent: Intent;
  text: string;
}

/** 업종 추가 = 1블록. 질문 6~10개 권장 (비용 × 커버리지). */
export const QUESTION_TEMPLATES: Record<string, { intent: Intent; tpl: string }[]> = {
  waxing: [
    { intent: "conversion", tpl: "{area} 왁싱 어디가 좋아? 예약하려고 하는데 추천해줘" },
    { intent: "conversion", tpl: "{area}에서 {service} 잘하는 곳 추천해줘" },
    { intent: "info",       tpl: "{area} 근처 왁싱샵 어떤 곳들이 있어?" },
    { intent: "info",       tpl: "브라질리언 왁싱 처음 받는데 {area} 쪽에서 어디로 가야 할까?" },
    { intent: "compare",    tpl: "{area} 왁싱샵들 후기 좋은 순으로 비교해줘" },
    { intent: "situation",  tpl: "이번 주말에 영업하는 {area} 왁싱샵 있어?" },
  ],
  craft_class: [
    { intent: "conversion", tpl: "{area} 원데이클래스 예약 가능한 곳 추천해줘" },
    { intent: "conversion", tpl: "{area}에서 {service} 배울 수 있는 공방 알려줘" },
    { intent: "info",       tpl: "{area} 공방 어떤 곳들이 있어?" },
    { intent: "compare",    tpl: "{area} 꽃 클래스 어디가 제일 괜찮아?" },
    { intent: "situation",  tpl: "이번 주말 {area}에서 데이트로 갈 만한 공방 클래스 있어?" },
  ],
};

export function buildQuestions(industry: string, area: string, services: string[] = []): ProbeQuestion[] {
  const tpls = QUESTION_TEMPLATES[industry];
  if (!tpls) throw new Error(`질문 템플릿 없는 업종: ${industry} — QUESTION_TEMPLATES에 1블록 추가`);
  const svc = services[0] ?? "";
  return tpls.map((t, i) => ({
    id: `${industry}:${i}:${area}`,
    intent: t.intent,
    text: t.tpl.replaceAll("{area}", area).replaceAll("{service}", svc),
  }));
}

// ── 2. 엔진 어댑터 ───────────────────────────────────────────

export interface EngineAnswer {
  text: string;
  citations: string[] | null;  // 출처 URL. 못 주는 엔진은 null (미측정)
}
export interface EngineAdapter {
  id: "chatgpt" | "gemini" | "claude" | "claude_search" | "perplexity" | "naver" | "stub";
  ask(question: string): Promise<EngineAnswer>;
}

// ── 3. 셀 판정: 코드가 한다 ──────────────────────────────────

export interface ProbeCell {
  questionId: string;
  intent: Intent;
  engine: EngineAdapter["id"];
  mentioned: boolean;
  mentionRank: number | null;      // 답변 내 등장 순서 (1 = 맨 앞)
  competitorsMentioned: string[];  // "대신 추천된 곳"
  citedMine: boolean | null;       // citations null이면 null
  answerExcerpt: string;
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export function judgeCell(
  q: ProbeQuestion, engine: EngineAdapter["id"], ans: EngineAnswer,
  entities: EntityAlias[], myUrls: string[] = [],
): ProbeCell {
  const t = norm(ans.text);
  const hits = entities
    .map((e) => {
      const idx = [e.name, ...e.aliases].map((a) => t.indexOf(norm(a))).filter((i) => i >= 0);
      return { e, first: idx.length ? Math.min(...idx) : -1 };
    })
    .filter((h) => h.first >= 0)
    .sort((a, b) => a.first - b.first);

  const mineIdx = hits.findIndex((h) => h.e.isMine);
  return {
    questionId: q.id, intent: q.intent, engine,
    mentioned: mineIdx >= 0,
    mentionRank: mineIdx >= 0 ? mineIdx + 1 : null,
    competitorsMentioned: hits.filter((h) => !h.e.isMine).map((h) => h.e.name),
    citedMine: ans.citations === null ? null
      : ans.citations.some((u) => myUrls.some((m) => u.includes(m))),
    answerExcerpt: ans.text.slice(0, 200),
  };
}

// ── 4. 실측 실행 + 집계 ──────────────────────────────────────

export interface ProbeSnapshot {
  storeId: string;
  snapshotAt: string;
  area: string; industry: string;
  engineIds: string[];
  cells: ProbeCell[];
  agg: {
    visibility: number;
    byIntent: Partial<Record<Intent, { asked: number; mentioned: number }>>;
    byEngine: Record<string, { asked: number; mentioned: number }>;
    shareOfVoice: { name: string; share: number }[];
    missedQuestions: string[];     // 경쟁사는 나오고 나는 0회
    firstRank: number;             // 등장 시 맨 앞이었던 횟수
    citationCoverage: number | null;
  };
}

export async function runProbe(opts: {
  storeId: string; industry: string; area: string;
  entities: EntityAlias[]; myUrls?: string[]; services?: string[];
  engines: EngineAdapter[];
}): Promise<ProbeSnapshot> {
  const questions = buildQuestions(opts.industry, opts.area, opts.services);
  const cells: ProbeCell[] = [];
  for (const q of questions)
    for (const eng of opts.engines) {
      const ans = await eng.ask(q.text);          // 유일한 LLM 호출 지점
      cells.push(judgeCell(q, eng.id, ans, opts.entities, opts.myUrls));
      await new Promise((r) => setTimeout(r, 200)); // rate 완충
    }

  const snap: ProbeSnapshot = {
    storeId: opts.storeId, snapshotAt: new Date().toISOString(),
    area: opts.area, industry: opts.industry,
    engineIds: opts.engines.map((e) => e.id),
    cells, agg: aggregate(cells, opts.entities, questions),
  };

  // 검증 루프 연결: 스냅샷 → measurement 이벤트 (재실측 시 델타·hit/miss가 공짜)
  await appendEvent({
    type: "measurement", storeId: opts.storeId, actor: "system",
    metric: "inflow" as any,     // v2: eventLog metric에 "ai_visibility" 추가 후 교체
    value: Math.round(snap.agg.visibility * 100),
    window: "d30", source: "operator_input",
  });
  return snap;
}

function aggregate(cells: ProbeCell[], entities: EntityAlias[], questions: ProbeQuestion[]): ProbeSnapshot["agg"] {
  const total = cells.length || 1;
  const mentioned = cells.filter((c) => c.mentioned);

  const byIntent: ProbeSnapshot["agg"]["byIntent"] = {};
  const byEngine: ProbeSnapshot["agg"]["byEngine"] = {};
  for (const c of cells) {
    (byIntent[c.intent] ??= { asked: 0, mentioned: 0 }).asked++;
    if (c.mentioned) byIntent[c.intent]!.mentioned++;
    (byEngine[c.engine] ??= { asked: 0, mentioned: 0 }).asked++;
    if (c.mentioned) byEngine[c.engine].mentioned++;
  }

  const voice = new Map<string, number>();
  for (const c of cells) {
    if (c.mentioned) voice.set("__mine__", (voice.get("__mine__") ?? 0) + 1);
    for (const n of c.competitorsMentioned) voice.set(n, (voice.get(n) ?? 0) + 1);
  }
  const voiceTotal = [...voice.values()].reduce((a, b) => a + b, 0) || 1;
  const mineName = entities.find((e) => e.isMine)?.name ?? "우리";

  const mentionedQ = new Set(mentioned.map((c) => c.questionId));
  const missedQuestions = questions
    .filter((q) => !mentionedQ.has(q.id) &&
      cells.some((c) => c.questionId === q.id && c.competitorsMentioned.length > 0))
    .map((q) => q.text);

  const withCit = cells.filter((c) => c.citedMine !== null).length;
  return {
    visibility: mentioned.length / total,
    byIntent, byEngine,
    shareOfVoice: [...voice.entries()]
      .map(([name, n]) => ({ name: name === "__mine__" ? mineName : name, share: n / voiceTotal }))
      .sort((a, b) => b.share - a.share),
    missedQuestions,
    firstRank: cells.filter((c) => c.mentionRank === 1).length,
    citationCoverage: withCit > 0 ? withCit / total : null,
  };
}
