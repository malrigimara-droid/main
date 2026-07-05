// ─── 액션 층: 실행물 생성 (4층) ────────────────────────────────
//
// 원칙:
//  - 키워드 선정은 코드가 한다 (점유 맵의 EMPTY → CONTESTED 순, 수요 내림차순)
//  - LLM은 선정된 키워드와 리뷰 근거를 받아 "문장"만 만든다
//  - 리뷰 인용은 분석 단계에서 발췌된 원문만 사용 (지어내기 차단)
//  - 산출물 3종: 블로그 초안 / 플레이스 소개문 / 재방문 알림 메시지

import { callClaudeJson } from "./llm.js";
import type { KeywordShare, ReviewAnalysis, ShareMap, Stage } from "./types.js";

export interface StoreInfo {
  name: string;
  industry: string;          // "waxing" 등
  areaLabel: string;         // "용인 수지"
  services?: string[];       // 대표 시술/상품
  revisitCycleDays?: [number, number]; // IndustryProfile에서 주입 (왁싱 [28,42])
}

export interface DeliverablePack {
  generatedAt: string;
  targetKeywords: { keyword: string; monthlyTotal: number; reason: string }[];
  blogPostDraft: { targetKeyword: string; title: string; body: string };
  placeIntro: { text: string; charCount: number };
  revisitMessage: {
    sendAfterDays: number;   // 재방문 주기 하한 - 7일 (코드 계산)
    variants: { label: string; body: string }[];
  };
  complianceNotes: string[];
}

// ① 결정적 키워드 선정 — LLM 개입 없음
export function pickTargetKeywords(map: ShareMap, n = 2): KeywordShare[] {
  const byPriority = (k: KeywordShare) =>
    k.opportunity === "EMPTY" ? 0 : k.opportunity === "CONTESTED" ? 1 : 2;
  return [...map.keywords]
    .filter((k) => (k.demand?.monthlyTotal ?? 0) >= 100 && k.opportunity !== "OWNED")
    .sort((a, b) => byPriority(a) - byPriority(b) || (b.demand?.monthlyTotal ?? 0) - (a.demand?.monthlyTotal ?? 0))
    .slice(0, n);
}

interface LlmDeliverables {
  blogPostDraft: { title: string; body: string };
  placeIntro: { text: string };
  revisitVariants: { label: string; body: string }[];
}
function validate(o: any): o is LlmDeliverables {
  return o?.blogPostDraft?.title && o?.blogPostDraft?.body
    && o?.placeIntro?.text && Array.isArray(o?.revisitVariants);
}

export async function generateDeliverables(
  store: StoreInfo,
  map: ShareMap,
  review: ReviewAnalysis | null,
  bottleneck?: Stage,
): Promise<DeliverablePack> {
  const targets = pickTargetKeywords(map);
  if (targets.length === 0) throw new Error("공략 키워드 없음 — 점유 맵 먼저 생성 필요");
  const primary = targets[0];

  const quotes = review?.revisitSignals.loyaltyQuotes ?? [];
  const strengths = (review?.topics ?? [])
    .filter((t) => t.sentiment === "positive")
    .slice(0, 3)
    .map((t) => `${t.topic}: "${t.representativeQuote}"`);
  const risks = (review?.riskFlags ?? []).map((r) => r.topic);

  const out = await callClaudeJson<LlmDeliverables>({
    model: process.env.DELIVERABLE_MODEL ?? "claude-opus-4-8", // 고객에게 나가는 글 → Sonnet
    maxTokens: 6000,
    system:
      "당신은 소상공인 마케팅 실행물 작성자다. 반드시 유효한 JSON만 출력한다. " +
      "과장·허위·효능 단정 문구 금지(부작용 없음, 100% 보장 등). " +
      "제공된 리뷰 발췌만 인용하고 새 후기를 지어내지 않는다. " +
      "자연스러운 한국어 구어체, 광고 티 나는 상투구 최소화.",
    prompt: `가게: ${store.name} (${store.areaLabel}, 업종 ${store.industry})
대표 서비스: ${store.services?.join(", ") ?? "미입력"}
리뷰에서 검증된 강점:
${strengths.join("\n") || "(리뷰 데이터 없음 — 강점 주장 대신 정보성 내용 위주로)"}
주의할 약점(글에서 정면 대응하지 말고 회피): ${risks.join(", ") || "없음"}
인용 가능한 고객 문장: ${quotes.map((q) => `"${q}"`).join(" / ") || "없음"}

다음 3종을 생성해 JSON으로만 응답하라:
{
  "blogPostDraft": {
    "title": "공략 키워드 '${primary.keyword}'가 자연스럽게 들어간 제목",
    "body": "1200~1800자. '${primary.keyword}'를 본문에 3~5회 자연스럽게 포함. ${targets[1] ? `보조 키워드 '${targets[1].keyword}'도 1~2회.` : ""} 정보 가치(시술 전 알아야 할 것, 선택 기준) 70% + 가게 소개 30%. 소제목 2~3개 포함."
  },
  "placeIntro": {
    "text": "네이버 플레이스 소개글. 700자 이내. 첫 두 문장에 핵심(지역+업종+차별점). 검증된 강점 반영."
  },
  "revisitVariants": [
    {"label": "정중한 안내형", "body": "재방문 시기 안내 메시지, 80자 이내"},
    {"label": "혜택 제안형", "body": "재방문 유도 + 가벼운 혜택 언급, 80자 이내"}
  ]
}`,
    validate,
  });

  // ③ 코드가 계산하는 부분: 발송 타이밍
  const cycleLow = store.revisitCycleDays?.[0] ?? 28;

  return {
    generatedAt: new Date().toISOString(),
    targetKeywords: targets.map((t) => ({
      keyword: t.keyword,
      monthlyTotal: t.demand?.monthlyTotal ?? 0,
      reason: t.opportunity === "EMPTY"
        ? "월 검색수요 있음 + 상위노출 무주공산"
        : `경쟁 중 (최대 점유 ${t.topCompetitor ? `${t.topCompetitor.name} ${(t.topCompetitor.share * 100).toFixed(0)}%` : "-"})`,
    })),
    blogPostDraft: { targetKeyword: primary.keyword, ...out.blogPostDraft },
    placeIntro: { text: out.placeIntro.text, charCount: out.placeIntro.text.length },
    revisitMessage: { sendAfterDays: Math.max(cycleLow - 7, 7), variants: out.revisitVariants },
    complianceNotes: [
      "재방문 메시지를 알림톡/문자로 보낼 경우 광고성 정보는 '(광고)' 표기 + 수신동의 + 무료수신거부 안내가 필요합니다.",
      "블로그 초안의 효능·효과 표현은 게시 전 사장님이 사실 여부를 확인하세요.",
    ],
  };
}
