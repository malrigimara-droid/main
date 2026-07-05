// lib/llm-probe.ts — AI 답변 노출 실측 (질문 매트릭스) 스펙 초안
//
// MEPiX 정밀진단의 "질문 24 × 엔진 5 = 120셀 실측"의 타개(로컬 소상공인) 버전.
// keywordShareMap과 동형 구조: 수요=질문, 노출=등장, 점유=Share of Voice.
//
// collector 철학 계승:
//  - 질문 생성은 템플릿(결정적) — 지역×업종이 우리 문해력, LLM 확장은 옵션
//  - 등장 판정은 코드(별칭 매칭, keywordShareMap.matchEntity 재사용) — LLM 판정 금지
//  - 집계·비율 전부 코드. LLM은 "엔진에게 물어보는 것" 자체에만 사용
//  - 스냅샷은 이벤트로 적재 → 재실측 델타·예측 채점(hitRateTable)이 공짜로 따라옴
//    ← MEPiX엔 없는 검증 루프. 우리 차별축 3.
//  - 측정 못 한 것은 못 했다고 기록 (citations 없는 엔진 = unmeasured, 0% 아님)

import type { EntityAlias } from "./keywordShareMap"; // { name, aliases, isMine }

// ── 1. 질문 생성: 의도 4종 × 지역·업종 템플릿 (결정적) ─────────

export type Intent = "conversion" | "info" | "compare" | "situation";
// 전환(구매 직전) / 정보 / 비교 / 상황 — MEPiX 분류 차용, 전환 가중

export interface ProbeQuestion {
  id: string;              // 템플릿id:area 해시 — 재실측 시 동일 질문 보장 (델타 전제)
  intent: Intent;
  text: string;
}

/** 업종별 질문 템플릿. {area}/{service} 슬롯. 업종 추가 = 배열 1개. */
export const QUESTION_TEMPLATES: Record<string, { intent: Intent; tpl: string }[]> = {
  waxing: [
    { intent: "conversion", tpl: "{area} 왁싱 어디가 좋아? 예약하려고" },
    { intent: "conversion", tpl: "{area}에서 {service} 잘하는 곳 추천해줘" },
    { intent: "info",       tpl: "{area} 근처 왁싱샵 목록 알려줘" },
    { intent: "info",       tpl: "브라질리언 왁싱 처음인데 {area}에서 어디 가야 해?" },
    { intent: "compare",    tpl: "{area} 왁싱샵들 후기 좋은 순으로 비교해줘" },
    { intent: "situation",  tpl: "이번 주말에 하는 {area} 왁싱샵 있어?" },
  ],
  craft_class: [
    { intent: "conversion", tpl: "{area} 원데이클래스 예약 가능한 곳 추천해줘" },
    { intent: "info",       tpl: "{area} 공방 뭐가 있어?" },
    { intent: "compare",    tpl: "{area} 꽃 클래스 어디가 제일 괜찮아?" },
    { intent: "situation",  tpl: "이번 주말 {area}에서 데이트로 갈 만한 공방 클래스 있어?" },
  ],
  // 업종 추가 = 여기 1블록. 질문 수 6~10개 권장 (비용 × 커버리지 균형)
};

export function buildQuestions(industry: string, area: string, services: string[] = []): ProbeQuestion[] {
  const tpls = QUESTION_TEMPLATES[industry];
  if (!tpls) throw new Error(`질문 템플릿 없는 업종: ${industry}`);
  const svc = services[0] ?? "";
  return tpls.map((t, i) => ({
    id: `${industry}:${i}:${area}`,
    intent: t.intent,
    text: t.tpl.replaceAll("{area}", area).replaceAll("{service}", svc),
  }));
}

// ── 2. 엔진 어댑터: 물어보는 것만 담당 ────────────────────────

export interface EngineAnswer {
  text: string;
  citations: string[] | null;  // 출처 URL — 못 주는 엔진은 null (0개 아님, 미측정)
}
export interface EngineAdapter {
  id: "chatgpt" | "gemini" | "claude" | "perplexity" | "naver";
  ask(question: string): Promise<EngineAnswer>;
}
// v1: claude 어댑터(우리 API 키로 즉시 가능) + 나머지는 각 API 확보 시 추가.
// 엔진이 늘어도 아래 로직은 불변 — 어댑터 배열에 push만.

// ── 3. 셀 판정: 코드가 한다 (LLM 판정 금지) ───────────────────

export interface ProbeCell {
  questionId: string;
  intent: Intent;
  engine: EngineAdapter["id"];
  mentioned: boolean;          // 내 가게 등장 여부 (별칭 매칭)
  mentionRank: number | null;  // 답변 내 등장 순서 (1=맨 앞) — "고객은 맨 위만 봐요"
  competitorsMentioned: string[]; // "대신 추천된 곳"
  citedMine: boolean | null;   // 내 채널(플레이스/블로그) 인용 여부. citations null이면 null
  answerExcerpt: string;       // 증거 발췌 (실물 캡처의 텍스트판, 200자)
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export function judgeCell(
  q: ProbeQuestion, engine: EngineAdapter["id"], ans: EngineAnswer,
  entities: EntityAlias[], myUrls: string[] = [],   // 내 플레이스/블로그 URL들
): ProbeCell {
  const t = norm(ans.text);
  const hits = entities
    .map((e) => {
      const idx = [e.name, ...e.aliases].map((a) => t.indexOf(norm(a))).filter((i) => i >= 0);
      return { e, first: idx.length ? Math.min(...idx) : -1 };
    })
    .filter((h) => h.first >= 0)
    .sort((a, b) => a.first - b.first);

  const mineHit = hits.findIndex((h) => h.e.isMine);
  return {
    questionId: q.id, intent: q.intent, engine,
    mentioned: mineHit >= 0,
    mentionRank: mineHit >= 0 ? mineHit + 1 : null,
    competitorsMentioned: hits.filter((h) => !h.e.isMine).map((h) => h.e.name),
    citedMine: ans.citations === null ? null
      : ans.citations.some((u) => myUrls.some((m) => u.includes(m))),
    answerExcerpt: ans.text.slice(0, 200),
  };
}

// ── 4. 실측 실행 + 스냅샷 ────────────────────────────────────

export interface ProbeSnapshot {
  storeId: string;
  snapshotAt: string;
  area: string; industry: string;
  cells: ProbeCell[];
  agg: {
    visibility: number;            // 등장 셀 / 전체 셀 (MEPiX "AI 가시성")
    byIntent: Record<Intent, { asked: number; mentioned: number }>;
    byEngine: Record<string, { asked: number; mentioned: number }>;
    shareOfVoice: { name: string; share: number }[]; // 언급 총량 중 각 업체 몫
    missedQuestions: string[];     // 경쟁사는 나오고 나는 0회 (놓친 질문)
    firstRank: number;             // 등장 시 1등이었던 횟수
    citationCoverage: number | null; // citations 준 엔진 비율 — null 투명성
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
    }
  return { storeId: opts.storeId, snapshotAt: new Date().toISOString(),
    area: opts.area, industry: opts.industry, cells, agg: aggregate(cells, opts.entities, questions) };
}

function aggregate(cells: ProbeCell[], entities: EntityAlias[], questions: ProbeQuestion[]): ProbeSnapshot["agg"] {
  const total = cells.length || 1;
  const mentioned = cells.filter((c) => c.mentioned);

  const byIntent = {} as ProbeSnapshot["agg"]["byIntent"];
  const byEngine: ProbeSnapshot["agg"]["byEngine"] = {};
  for (const c of cells) {
    (byIntent[c.intent] ??= { asked: 0, mentioned: 0 }).asked++;
    if (c.mentioned) byIntent[c.intent].mentioned++;
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
  const missed = questions
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
    missedQuestions: missed,
    firstRank: cells.filter((c) => c.mentionRank === 1).length,
    citationCoverage: withCit > 0 ? withCit / total : null,
  };
}

// ── 5. 검증 루프 연결 (MEPiX에 없는 것 — 우리 차별축) ──────────
//
// 스냅샷을 eventLog에 적재:
//   appendEvent({ type: "measurement", metric: "ai_visibility",
//     value: Math.round(snap.agg.visibility * 100), window: "d30", ... })
// 처방("놓친 질문 콘텐츠 선점")에 expectedMetric = "ai_visibility +N"을 걸면
// 다음 스냅샷에서 verifyPrescription이 hit/miss 채점 → hitRateTable에 누적.
// → 리포트 문구: "예상 +N — 다음 진단(날짜)에서 실제로 올랐는지 채점해 보여드립니다.
//    지난달 예측 적중률 공개 중."
//
// 운영 노트:
//  - 같은 질문 id 재사용이 델타의 전제. 템플릿 수정 시 id 버전 올릴 것
//  - 비용: 질문 8 × 엔진 2(v1: claude+perplexity) = 16콜/가게/회. 월 1회면 충분
//  - LLM 답변은 비결정적 → 스냅샷은 "그 시점 표본"으로 정직 표기 (MEPiX도 동일)
