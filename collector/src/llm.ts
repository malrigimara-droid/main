// ─── 공용 Claude 호출 헬퍼 ─────────────────────────────────────

export async function callClaude(opts: {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}): Promise<string> {
  const body = {
    model: opts.model ?? process.env.REVIEW_MODEL ?? "claude-haiku-4-5-20251001",
    max_tokens: opts.maxTokens ?? 4000,
    temperature: 0 as number | undefined, // 결정성 (지원 모델에서만)
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  };

  // 최신 세대 모델은 temperature가 폐기됨 → 해당 400이면 빼고 1회 재시도
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json()) as { content: { type: string; text?: string }[] };
      return data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    }
    const errText = await res.text();
    if (res.status === 400 && errText.includes("temperature") && body.temperature !== undefined) {
      delete body.temperature;
      continue;
    }
    throw new Error(`Claude API ${res.status}: ${errText}`);
  }
  throw new Error("Claude API: 재시도 초과");
}

/** JSON 강제 출력 + 검증 + 재시도 1회 패턴 */
export async function callClaudeJson<T>(opts: {
  system: string;
  prompt: string;
  validate: (o: any) => o is T;
  model?: string;
  maxTokens?: number;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callClaude(opts);
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (opts.validate(parsed)) return parsed;
    } catch { /* 재시도 */ }
  }
  throw new Error("LLM JSON 출력 파싱 실패 (재시도 초과)");
}
