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

/** Claude + 웹검색: "검색을 켠 AI"의 대리 측정. citations 실측 가능.
 *  로컬 가게는 모델 지식엔 없고(무검색 실측으로 확인) 검색 소스에 있다 —
 *  이 열이 진짜 게임. 비용: 검색 1회 ≈ $0.01 + 토큰. */
export function claudeSearchEngine(model?: string): EngineAdapter {
  return {
    id: "claude_search",
    async ask(question: string): Promise<EngineAnswer> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model ?? "claude-sonnet-5",
          max_tokens: 1500,
          system:
            "당신은 사용자의 일상 질문에 답하는 어시스턴트다. 필요하면 웹검색으로 " +
            "실제 업체를 찾아 구체적인 업체명을 들어 답한다.",
          messages: [{ role: "user", content: question }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        }),
      });
      if (!res.ok) throw new Error(`Claude(search) API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { content: any[] };

      const text = data.content
        .filter((c) => c.type === "text").map((c) => c.text).join("");
      const urls = new Set<string>();
      for (const c of data.content) {
        if (c.type === "text")
          for (const cit of c.citations ?? []) if (cit.url) urls.add(cit.url);
        if (c.type === "web_search_tool_result")
          for (const r of Array.isArray(c.content) ? c.content : []) if (r.url) urls.add(r.url);
      }
      return { text, citations: [...urls] }; // 검색 엔진 → citations 실측
    },
  };
}

/** ChatGPT + 웹검색 (OpenAI Responses API). OPENAI_API_KEY 필요. */
export function chatgptEngine(model?: string): EngineAdapter {
  return {
    id: "chatgpt",
    async ask(question: string): Promise<EngineAnswer> {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model ?? process.env.OPENAI_PROBE_MODEL ?? "gpt-5-mini",
          instructions:
            "당신은 사용자의 일상 질문에 답하는 어시스턴트다. 필요하면 웹검색으로 " +
            "실제 업체를 찾아 구체적인 업체명을 들어 답한다.",
          input: question,
          tools: [{ type: "web_search" }],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { output?: any[] };

      let text = "";
      const urls = new Set<string>();
      for (const item of data.output ?? []) {
        if (item.type !== "message") continue;
        for (const c of item.content ?? []) {
          if (c.type === "output_text") {
            text += c.text ?? "";
            for (const a of c.annotations ?? [])
              if (a.type === "url_citation" && a.url) urls.add(a.url);
          }
        }
      }
      return { text, citations: [...urls] };
    },
  };
}

/** Gemini + 구글검색 그라운딩. GEMINI_API_KEY 필요 (aistudio.google.com/apikey). */
export function geminiEngine(model?: string): EngineAdapter {
  const m = model ?? process.env.GEMINI_PROBE_MODEL ?? "gemini-2.5-flash";
  return {
    id: "gemini",
    async ask(question: string): Promise<EngineAnswer> {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text:
              "당신은 사용자의 일상 질문에 답하는 어시스턴트다. 필요하면 검색으로 " +
              "실제 업체를 찾아 구체적인 업체명을 들어 답한다." }] },
            contents: [{ role: "user", parts: [{ text: question }] }],
            tools: [{ google_search: {} }],
          }),
        },
      );
      if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { candidates?: any[] };
      const cand = data.candidates?.[0];

      const text = (cand?.content?.parts ?? [])
        .map((p: any) => p.text ?? "").join("");
      const urls = new Set<string>();
      for (const ch of cand?.groundingMetadata?.groundingChunks ?? [])
        if (ch.web?.uri) urls.add(ch.web.uri);
      return { text, citations: urls.size ? [...urls] : null };
      // 그라운딩이 발동 안 하면 citations 없음 → null(미측정)로 정직 처리
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
