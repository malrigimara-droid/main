// ─── llmProbe 엔진 어댑터들 ────────────────────────────────────
//
// v1: claude (ANTHROPIC_API_KEY로 즉시) + stub (파이프라인 검증용).
// perplexity/gemini/chatgpt/naver는 각 API 키 확보 시 어댑터만 추가 —
// llmProbe 로직은 불변.

import { callClaude } from "./llm.js";
import type { EngineAdapter, EngineAnswer } from "./llmProbe.js";

/** Claude: 웹검색 없는 모델 지식 기반 답변 — citations 없음(null, 미측정) */
export function claudeEngine(model?: string): EngineAdapter {
  return {
    id: "claude",
    async ask(question: string): Promise<EngineAnswer> {
      const text = await callClaude({
        model: model ?? "claude-sonnet-5",
        maxTokens: 700,
        system:
          "당신은 사용자의 일상 질문에 답하는 어시스턴트다. " +
          "아는 범위에서 구체적인 업체명을 들어 답하고, 모르면 모른다고 말한다.",
        prompt: question,
      });
      return { text, citations: null };
    },
  };
}

/** 스텁: API 키 없이 파이프라인(판정·집계·놓친질문) 검증용.
 *  경쟁사만 언급하는 최악 시나리오를 결정적으로 재현한다. */
export function stubEngine(competitorPool: string[]): EngineAdapter {
  return {
    id: "stub",
    async ask(question: string): Promise<EngineAnswer> {
      const pick = competitorPool.filter((_, i) => (question.length + i) % 2 === 0);
      const names = (pick.length ? pick : competitorPool.slice(0, 1)).join(", ");
      return {
        text: `${names} 등을 추천드립니다. 네이버 지도에서 후기를 비교해 보시면 좋아요.`,
        citations: null,
      };
    },
  };
}
