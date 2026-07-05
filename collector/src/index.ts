// ─── CLI 데모: 점유 맵 + 리뷰 분석 한 번에 ─────────────────────
// 실행: npx tsx src/index.ts

import { readFile } from "node:fs/promises";
import { buildShareMap } from "./keywordShareMap.js";
import { parsePastedReviews } from "./reviewIngest.js";
import { analyzeReviews } from "./reviewAnalysis.js";
import { generateDeliverables } from "./actionLayer.js";

async function main() {
  // 1) 키워드 점유 맵 (완전 자동 — 공식 API만 사용)
  const map = await buildShareMap({
    tradeArea: "용인수지",
    industry: "waxing",
    areas: ["수지", "수지구청역", "풍덕천"],
    entities: [
      { name: "고고왁싱", aliases: ["고고 왁싱", "gogowaxing"], isMine: true },
      { name: "경쟁사A", aliases: ["A왁싱"], isMine: false },
      { name: "경쟁사B", aliases: ["B뷰티"], isMine: false },
    ],
  });

  console.log(`\n■ ${map.tradeArea} 키워드 점유 맵 (${map.keywords.length}개)\n`);
  for (const k of map.keywords) {
    const d = k.demand ? `월 ${k.demand.monthlyTotal.toLocaleString()}회` : "수요 미확인";
    const top = k.topCompetitor ? `${k.topCompetitor.name} ${(k.topCompetitor.share * 100).toFixed(0)}%` : "-";
    console.log(
      `[${k.opportunity.padEnd(16)}] ${k.keyword.padEnd(14)} ${d.padEnd(12)} ` +
      `내 점유 ${(k.myShare * 100).toFixed(0)}% / 최대 경쟁 ${top}`,
    );
  }
  const empty = map.keywords.filter((k) => k.opportunity === "EMPTY" && (k.demand?.monthlyTotal ?? 0) >= 100);
  console.log(`\n→ 공략 1순위 (수요 있음 + 무주공산): ${empty.map((k) => k.keyword).join(", ") || "없음"}`);

  // 2) 리뷰 분석 (수집은 사람: reviews.txt에 붙여넣기 → 분석은 자동)
  let analysis = null;
  try {
    const blob = await readFile("reviews.txt", "utf-8");
    const reviews = parsePastedReviews(blob);
    console.log(`\n■ 리뷰 ${reviews.length}건 분석 중...`);
    analysis = await analyzeReviews("gogowaxing", "waxing", reviews);
    console.log(JSON.stringify(analysis, null, 2));
  } catch {
    console.log("\n(reviews.txt 없음 — 리뷰 분석 건너뜀. 플레이스 리뷰를 복사해 reviews.txt로 저장하세요)");
  }

  // 3) 액션 층: 실행물 3종 생성 (블로그 초안 / 플레이스 소개문 / 재방문 메시지)
  console.log("\n■ 실행물 생성 중...");
  const pack = await generateDeliverables(
    {
      name: "고고왁싱",
      industry: "waxing",
      areaLabel: "용인 수지",
      services: ["브라질리언 왁싱", "슈가링", "남성 왁싱"],
      revisitCycleDays: [28, 42],
    },
    map,
    analysis,
  );
  console.log(`\n공략 키워드: ${pack.targetKeywords.map((t) => `${t.keyword}(월 ${t.monthlyTotal})`).join(", ")}`);
  console.log(`\n[블로그 초안] ${pack.blogPostDraft.title}\n${pack.blogPostDraft.body.slice(0, 300)}...`);
  console.log(`\n[플레이스 소개문 ${pack.placeIntro.charCount}자]\n${pack.placeIntro.text}`);
  console.log(`\n[재방문 메시지 — 시술 후 ${pack.revisitMessage.sendAfterDays}일 뒤 발송]`);
  for (const v of pack.revisitMessage.variants) console.log(`  (${v.label}) ${v.body}`);
  console.log(`\n⚠ ${pack.complianceNotes.join("\n⚠ ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
