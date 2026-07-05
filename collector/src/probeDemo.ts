// ─── llmProbe 첫 스냅샷 러너 ──────────────────────────────────
// 실행:
//   npx tsx src/probeDemo.ts             # 키 있는 엔진 전부, 두 가게 모두
//   npx tsx src/probeDemo.ts gogowaxing  # 특정 가게만 (storeId 일부 일치)
//   npx tsx src/probeDemo.ts --stub      # 강제 드라이런 (파이프라인 검증)
//
// 대상 2곳: 고고왁싱(방배, 근접형) / 모먼츠비올라(이매동, destination형).
// 경쟁 엔티티는 정밀진단·점유맵에서 확인된 실명 사용.

import { runProbe, type ProbeSnapshot } from "./llmProbe.js";
import { chatgptEngine, claudeEngine, claudeSearchEngine, geminiEngine, stubEngine } from "./probeEngines.js";

const CASES = [
  {
    storeId: "gogowaxing", industry: "waxing", area: "방배",
    services: ["브라질리언 왁싱"],
    myUrls: ["place.naver.com", "blog.naver.com/gogowaxing"], // TODO: 실제 URL로
    entities: [
      { name: "고고왁싱", aliases: ["고고 왁싱", "gogowaxing"], isMine: true },
      { name: "포라누나", aliases: ["포라누나 Family"], isMine: false },
      { name: "카카오쎈 살롱", aliases: ["카카오쎈"], isMine: false },
    ],
  },
  {
    storeId: "momentsviola", industry: "craft_class", area: "분당",
    services: ["플라워 클래스"],
    myUrls: ["litt.ly/moments.viola", "instagram.com/moments.viola"],
    entities: [
      { name: "모먼츠비올라", aliases: ["moments viola", "모먼츠 비올라"], isMine: true },
      { name: "도자기와꽃이야기", aliases: [], isMine: false },
      { name: "보들가죽공방", aliases: [], isMine: false },
    ],
  },
];

function printSnapshot(s: ProbeSnapshot) {
  console.log(`\n■ ${s.storeId} (${s.area} × ${s.industry}) — 엔진: ${s.engineIds.join(", ")}`);
  console.log(`  AI 가시성: ${(s.agg.visibility * 100).toFixed(0)}%  (등장 셀 ${s.cells.filter(c => c.mentioned).length}/${s.cells.length})`);
  console.log(`  맨 앞 등장: ${s.agg.firstRank}회 · 인용 측정: ${s.agg.citationCoverage === null ? "미측정(citations 없는 엔진)" : `${(s.agg.citationCoverage * 100).toFixed(0)}%`}`);
  console.log(`  Share of Voice:`);
  for (const v of s.agg.shareOfVoice.slice(0, 5))
    console.log(`    ${v.name.padEnd(12)} ${(v.share * 100).toFixed(0)}%`);
  console.log(`  놓친 질문 (경쟁사는 나오고 우리는 0회): ${s.agg.missedQuestions.length}개`);
  for (const q of s.agg.missedQuestions) console.log(`    - ${q}`);
  console.log(`  셀 상세:`);
  for (const c of s.cells)
    console.log(`    [${c.engine}] ${c.mentioned ? `등장(${c.mentionRank}번째)` : "미등장"} · 대신: ${c.competitorsMentioned.join(",") || "-"}${c.citedMine !== null ? ` · 내채널인용:${c.citedMine ? "O" : "X"}` : ""} · "${c.answerExcerpt.slice(0, 60)}..."`);
}

async function main() {
  const forceStub = process.argv.includes("--stub");
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const real = hasKey && !forceStub;

  // 키가 있는 엔진만 자동 편성 — 키 추가 = 열 추가
  const realEngines = [
    claudeEngine(), claudeSearchEngine(),       // 무검색 vs 검색 — 대비가 곧 발견
    ...(process.env.OPENAI_API_KEY ? [chatgptEngine()] : []),
    ...(process.env.GEMINI_API_KEY ? [geminiEngine()] : []),
  ];
  if (real) {
    console.log(`▶ 실측 모드 — 엔진 ${realEngines.length}개: ${realEngines.map((e) => e.id).join(", ")}`);
    if (!process.env.OPENAI_API_KEY) console.log("  (OPENAI_API_KEY 없음 — chatgpt 열 제외)");
    if (!process.env.GEMINI_API_KEY) console.log("  (GEMINI_API_KEY 없음 — gemini 열 제외)");
  } else {
    console.log(`▶ 드라이런 모드 (stub 엔진)${hasKey ? "" : " — ANTHROPIC_API_KEY 없음"}. 숫자는 검증용이며 실측이 아님.`);
  }

  const storeFilter = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const cases = storeFilter ? CASES.filter((c) => c.storeId.includes(storeFilter)) : CASES;
  if (cases.length === 0) throw new Error(`해당 가게 없음: ${storeFilter} (가능: ${CASES.map((c) => c.storeId).join(", ")})`);

  for (const c of cases) {
    const engines = real
      ? realEngines
      : [stubEngine(c.entities.filter((e) => !e.isMine).map((e) => e.name))];
    const snap = await runProbe({ ...c, engines });
    printSnapshot(snap);
  }
  console.log(`\n${real ? "→ 1회 실측 스냅샷 저장됨. 30일 후 재실측하면 델타가 나옵니다." : "→ 드라이런 완료. 맥에서 .env에 키 넣고 같은 명령으로 실측하세요."}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
