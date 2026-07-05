// ─── 채널 조건부 실행물 생성: 진단이 채널을 고르고, 채널이 형식을 고른다 ──
//
// 흐름: 병목 진단 → prioritizeChannels(업종×병목) → 상위 N 채널 →
//       채널별 맞춤 실행물 생성 → content_generated 이벤트 → 측정 계획 첨부
//
// 기존 actionLayer(블로그+소개문+메시지 고정 3종)를 대체하는 상위 모듈.
// 저품질 대응: 글 구조를 변형 풀에서 회전시킨다 (같은 템플릿 반복 = 저품질 시그니처).

import { callClaudeJson } from "./llm.js";
import { prioritizeChannels, measurementPlan, type ChannelPriority } from "./channelRegistry.js";
import { pickTargetKeywords, type StoreInfo } from "./actionLayer.js";
import { appendEvent } from "./eventLog.js";
import type { ReviewAnalysis, ShareMap, Stage } from "./types.js";
import { createHash } from "node:crypto";

export interface ChannelAsset {
  contentId: string;
  channel: string;
  kind: string;                // "블로그 초안" | "새소식" | "릴스 컷리스트" 등
  templateVariant: string;
  title?: string;
  body: string;
  extra?: Record<string, string>; // 해시태그, 발송 타이밍 등
}

export interface ExecutionPlan {
  storeId: string;
  bottleneck: Stage;
  channelRanking: ChannelPriority[];
  assets: ChannelAsset[];
  measurement: ReturnType<typeof measurementPlan>;
  generatedAt: string;
}

// ── 구조 변형 풀 (저품질 시그니처 방지) ──────────────────────

const VARIANTS: Record<string, string[]> = {
  naver_blog: ["후기형(고객 시선 1인칭 관찰)", "정보형(선택 기준 가이드)", "Q&A형(자주 묻는 질문 풀이)", "비교형(시술/옵션 비교)"],
  naver_place: ["새소식-이벤트형", "새소식-비하인드형", "새소식-계절형"],
  instagram: ["릴스-비포애프터", "릴스-과정공개", "릴스-사장님한마디"],
  danggeun: ["이웃인사형", "동네소식형", "단골혜택형"],
  kakao_channel: ["정중안내형", "혜택제안형"],
};

/** 같은 가게라도 회차마다 다른 구조 — 결정적 회전(해시 기반, 재현 가능) */
function pickVariant(channelId: string, storeId: string, seed: string): string {
  const pool = VARIANTS[channelId] ?? ["기본형"];
  const h = createHash("sha256").update(`${channelId}:${storeId}:${seed}`).digest()[0];
  return pool[h % pool.length];
}

// ── 채널별 생성 지시문 ────────────────────────────────────────

interface GenContext {
  store: StoreInfo;
  keyword: string | null;
  strengths: string[];         // 리뷰 검증 강점 (원문 인용)
  quotes: string[];
  bottleneck: Stage;
  variant: string;
}

const CHANNEL_SPECS: Record<string, (ctx: GenContext) => { kind: string; instruction: string }[]> = {
  naver_blog: (ctx) => [{
    kind: "블로그 초안",
    instruction: `'${ctx.variant}' 구조의 블로그 글. 1200~1800자, 소제목 2~3개.
키워드 '${ctx.keyword}'를 제목 1회 + 본문 3~5회 자연 삽입. 정보가치 70% + 가게 30%.
[사진 위치] 표시를 3곳 넣고 각 위치에 어떤 사진이 필요한지 괄호로 명시 (사장님 촬영 가이드).`,
  }],
  naver_place: (ctx) => [
    { kind: "플레이스 새소식", instruction: `'${ctx.variant}' 새소식 글. 300자 이내, 첫 문장에 핵심. 과장 금지.` },
    { kind: "사진 컷리스트", instruction: `플레이스용 사진 5컷 촬영 가이드. 각 컷: 무엇을/어떤 각도로/왜 이 컷이 전환에 도움되는지 1줄씩. 업종(${ctx.store.industry}) 첫 방문자의 불안 해소 관점으로.` },
  ],
  instagram: (ctx) => [{
    kind: "릴스 컷리스트+캡션",
    instruction: `'${ctx.variant}' 릴스 기획. 15초 3컷: 컷별 촬영 내용/자막 문구. AI 영상이 아니라 사장님 폰 촬영 가이드.
+ 캡션(150자 이내) + 해시태그 8개(지역+업종 조합).`,
  }],
  danggeun: (ctx) => [{
    kind: "당근 비즈프로필 소식",
    instruction: `'${ctx.variant}' 당근 소식글. 400자 이내. 이웃에게 말 걸듯, 광고 티 최소화. 동네 이름(${ctx.store.areaLabel}) 자연스럽게 1회.`,
  }],
  kakao_channel: (ctx) => [{
    kind: "재방문 메시지",
    instruction: `'${ctx.variant}' 재방문 안내 메시지 80자 이내. 광고성 표기 의무는 시스템이 별도 처리하므로 본문만.`,
  }],
  naver_power_link: (ctx) => [{
    kind: "검색광고 소재",
    instruction: `파워링크 소재: 제목 15자 이내 × 3안, 설명 45자 이내 × 2안. 키워드 '${ctx.keyword}' 포함. 과장·최상급 표현 금지(심사 반려 사유).`,
  }],
};

interface LlmAssetOut { assets: { kind: string; title?: string; body: string; extra?: Record<string, string> }[] }
const validateAssets = (o: any): o is LlmAssetOut =>
  o && Array.isArray(o.assets) && o.assets.every((a: any) => a.kind && typeof a.body === "string");

// ── 메인: 계획 수립 + 생성 + 이벤트 기록 ─────────────────────

export async function planAndGenerate(opts: {
  store: StoreInfo & { storeId: string };
  bottleneck: Stage;
  map: ShareMap | null;
  review: ReviewAnalysis | null;
  topChannels?: number;        // 기본 2 (단건 상품), 구독은 3+
  maxCostLevel?: 0 | 1 | 2 | 3;
  seed?: string;               // 회차 식별 (기본: 월) — 변형 회전용
  llm?: typeof callClaudeJson; // 테스트 주입용
}): Promise<ExecutionPlan> {
  const llm = opts.llm ?? callClaudeJson;
  const ranking = prioritizeChannels(opts.store.industry, opts.bottleneck, { maxCostLevel: opts.maxCostLevel });
  const chosen = ranking.filter((r) => CHANNEL_SPECS[r.channelId]).slice(0, opts.topChannels ?? 2);
  if (chosen.length === 0) throw new Error("생성 가능한 채널 없음 — CHANNEL_SPECS 확장 필요");

  const keyword = opts.map ? pickTargetKeywords(opts.map, 1)[0]?.keyword ?? null : null;
  const strengths = (opts.review?.topics ?? [])
    .filter((t) => t.sentiment === "positive").slice(0, 3)
    .map((t) => `${t.topic}: "${t.representativeQuote}"`);
  const quotes = opts.review?.revisitSignals.loyaltyQuotes ?? [];
  const seed = opts.seed ?? new Date().toISOString().slice(0, 7);

  const assets: ChannelAsset[] = [];
  for (const ch of chosen) {
    const variant = pickVariant(ch.channelId, opts.store.storeId, seed);
    const ctx: GenContext = { store: opts.store, keyword, strengths, quotes, bottleneck: opts.bottleneck, variant };
    const specs = CHANNEL_SPECS[ch.channelId](ctx);

    const out = await llm<LlmAssetOut>({
      model: process.env.DELIVERABLE_MODEL ?? "claude-opus-4-8",
      maxTokens: 6000,
      system:
        "당신은 소상공인 마케팅 실행물 작성자다. 유효한 JSON만 출력한다. " +
        "과장·허위·효능 단정 금지. 제공된 리뷰 발췌만 인용하고 새 후기를 지어내지 않는다. " +
        "AI 상투구(\"~하는 것이 중요합니다\" 등)와 기계적 마무리 금지.",
      prompt: `가게: ${opts.store.name} (${opts.store.areaLabel}, ${opts.store.industry})
대표 서비스: ${opts.store.services?.join(", ") ?? "미입력"}
병목 단계: ${opts.bottleneck} — 모든 실행물은 이 병목 해소에 복무해야 함
리뷰 검증 강점:\n${strengths.join("\n") || "(없음 — 정보가치 중심으로)"}
인용 가능 문장: ${quotes.map((q) => `"${q}"`).join(" / ") || "없음"}

다음 실행물을 생성해 {"assets":[{"kind","title?","body","extra?"}]} JSON으로만:
${specs.map((s, i) => `${i + 1}. [${s.kind}] ${s.instruction}`).join("\n")}`,
      validate: validateAssets,
    });

    for (const a of out.assets) {
      const contentId = createHash("sha256").update(`${opts.store.storeId}:${ch.channelId}:${a.kind}:${seed}`).digest("hex").slice(0, 12);
      assets.push({ ...a, contentId, channel: ch.channelId, templateVariant: variant });
      await appendEvent({
        type: "content_generated", storeId: opts.store.storeId, actor: "system",
        contentId, channel: toEventChannel(ch.channelId), templateVariant: variant,
        targetKeyword: keyword ?? undefined,
        model: process.env.DELIVERABLE_MODEL ?? "claude-opus-4-8",
        sourceEpisodeIds: [],    // 챗봇 에피소드 연결 시 채움 (루프 2)
      });
    }
  }

  return {
    storeId: opts.store.storeId, bottleneck: opts.bottleneck,
    channelRanking: ranking, assets,
    measurement: measurementPlan(chosen),
    generatedAt: new Date().toISOString(),
  };
}

function toEventChannel(id: string): "blog" | "place_news" | "place_photo" | "place_intro" | "instagram" | "message" {
  return ({ naver_blog: "blog", naver_place: "place_news", instagram: "instagram",
    kakao_channel: "message", danggeun: "place_news", naver_power_link: "place_news" } as const)[id] ?? "place_news";
}
