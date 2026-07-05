// ─── 키워드 점유 맵: 수요(검색광고) × 노출(블로그 검색) 합성 ────

import { fetchKeywordDemand } from "./naverSearchAd.js";
import { searchBlog } from "./naverOpenApi.js";
import { getCache, setCache } from "./cache.js";
import type { BlogExposure, KeywordShare, ShareMap } from "./types.js";

export interface EntityAlias {
  name: string;            // 정규 업체명 (예: "고고왁싱")
  aliases: string[];       // 블로그 제목/블로거명에서 매칭할 별칭들
  isMine: boolean;
}

/** 업종별 키워드 템플릿 — IndustryProfile에 합칠 부분 */
export const KEYWORD_TEMPLATES: Record<string, string[]> = {
  waxing: [
    "{area} 왁싱", "{area} 왁싱샵", "{area} 브라질리언왁싱",
    "{area} 남자왁싱", "{area} 슈가링", "{area} 왁싱 추천",
  ],
  cafe: ["{area} 카페", "{area} 카페 추천", "{area} 디저트카페", "{area} 브런치"],
  // 업종 추가 = 템플릿 1줄 추가
};

export function buildKeywords(industry: string, areas: string[]): string[] {
  const tpl = KEYWORD_TEMPLATES[industry];
  if (!tpl) throw new Error(`키워드 템플릿 없는 업종: ${industry}`);
  return areas.flatMap((a) => tpl.map((t) => t.replace("{area}", a)));
}

function matchEntity(text: string, entities: EntityAlias[]): string | null {
  const t = text.replace(/\s+/g, "").toLowerCase();
  for (const e of entities) {
    for (const alias of [e.name, ...e.aliases]) {
      if (t.includes(alias.replace(/\s+/g, "").toLowerCase())) return e.name;
    }
  }
  return null;
}

function classifyOpportunity(myShare: number, top: { share: number } | null, hasDemand: boolean): KeywordShare["opportunity"] {
  if (!hasDemand) return "EMPTY";
  if (myShare >= 0.3) return "OWNED";
  if (top && top.share >= 0.3) return "COMPETITOR_OWNED";
  if (myShare > 0 || (top && top.share > 0)) return "CONTESTED";
  return "EMPTY"; // 수요는 있는데 아무도 점유 못함 → 공략 1순위
}

/**
 * 상권×업종 점유 맵 생성. 캐시 TTL 7일 — 같은 상권 진단이 반복되어도
 * API 호출은 주 1회로 수렴.
 */
export async function buildShareMap(opts: {
  tradeArea: string;        // 캐시 키 (예: "용인수지")
  industry: string;
  areas: string[];          // 검색에 쓸 동네 표기들 (예: ["수지", "수지구청", "풍덕천"])
  entities: EntityAlias[];  // 내 가게 + 추적 경쟁사
  topN?: number;            // 상위 노출 측정 범위 (기본 10)
}): Promise<ShareMap> {
  const cacheKey = `sharemap:${opts.tradeArea}:${opts.industry}`;
  const cached = await getCache<ShareMap>(cacheKey, 7 * 24 * 3600);
  if (cached) return cached;

  const topN = opts.topN ?? 10;
  const keywords = buildKeywords(opts.industry, opts.areas);
  const demands = await fetchKeywordDemand(keywords);
  const demandMap = new Map(demands.map((d) => [d.keyword, d]));
  const mine = opts.entities.find((e) => e.isMine)?.name ?? "";

  const results: KeywordShare[] = [];
  for (const kw of keywords) {
    const items = await searchBlog(kw, 30);
    const exposures: BlogExposure[] = items.slice(0, topN).map((it, i) => ({
      rank: i + 1,
      title: it.title,
      link: it.link,
      bloggerName: it.bloggername,
      bloggerLink: it.bloggerlink,
      postDate: it.postdate,
      matchedEntity: matchEntity(`${it.title} ${it.bloggername}`, opts.entities),
    }));

    const shareByEntity: Record<string, number> = {};
    for (const ex of exposures) {
      if (ex.matchedEntity) shareByEntity[ex.matchedEntity] = (shareByEntity[ex.matchedEntity] ?? 0) + 1 / topN;
    }
    const myShare = shareByEntity[mine] ?? 0;
    const competitors = Object.entries(shareByEntity)
      .filter(([n]) => n !== mine)
      .sort((a, b) => b[1] - a[1]);
    const top = competitors[0] ? { name: competitors[0][0], share: competitors[0][1] } : null;
    const demand = demandMap.get(kw.replace(/\s+/g, "")) ?? null;

    results.push({
      keyword: kw,
      demand,
      exposures,
      shareByEntity,
      myShare,
      topCompetitor: top,
      opportunity: classifyOpportunity(myShare, top, (demand?.monthlyTotal ?? 0) >= 50),
    });
    await new Promise((r) => setTimeout(r, 150)); // 오픈 API rate 완충
  }

  // 수요 큰 순 정렬 — 리포트에서 "공략 키워드" 우선순위로 그대로 사용
  results.sort((a, b) => (b.demand?.monthlyTotal ?? 0) - (a.demand?.monthlyTotal ?? 0));

  const map: ShareMap = {
    tradeArea: opts.tradeArea,
    industry: opts.industry,
    myEntityName: mine,
    generatedAt: new Date().toISOString(),
    keywords: results,
  };
  await setCache(cacheKey, map);
  return map;
}
