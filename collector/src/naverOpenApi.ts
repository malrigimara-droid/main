// ─── 네이버 오픈 API: 블로그/지역 검색 ──────────────────────────
// 사전 준비: developers.naver.com 애플리케이션 등록 → 검색 API 권한.
// 일일 25,000회 무료. 블로그 점유 측정은 이 API로 완전 합법 자동화 가능.

const BASE = "https://openapi.naver.com/v1/search";

function headers() {
  const { NAVER_CLIENT_ID, NAVER_CLIENT_SECRET } = process.env;
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    throw new Error("오픈 API 환경변수 누락: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET");
  }
  return { "X-Naver-Client-Id": NAVER_CLIENT_ID, "X-Naver-Client-Secret": NAVER_CLIENT_SECRET };
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

export interface BlogSearchItem {
  title: string;
  link: string;
  bloggername: string;
  bloggerlink: string;
  postdate: string;
}

/** 블로그 검색 상위 N건 (기본 30 — "상위 노출 점유" 측정 단위) */
export async function searchBlog(query: string, display = 30): Promise<BlogSearchItem[]> {
  const qs = new URLSearchParams({ query, display: String(Math.min(display, 100)), sort: "sim" });
  const res = await fetch(`${BASE}/blog.json?${qs}`, { headers: headers() });
  if (!res.ok) throw new Error(`블로그 검색 API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { items?: any[] };
  return (data.items ?? []).map((it) => ({
    title: stripTags(it.title ?? ""),
    link: it.link ?? "",
    bloggername: it.bloggername ?? "",
    bloggerlink: it.bloggerlink ?? "",
    postdate: it.postdate ?? "",
  }));
}

export interface LocalSearchItem {
  title: string;
  category: string;
  address: string;
  roadAddress: string;
  link: string;
}

/** 지역 검색 — 쿼리당 최대 5건 한계. 상권 내 동종업체 "존재 확인"용으로만 사용 */
export async function searchLocal(query: string): Promise<LocalSearchItem[]> {
  const qs = new URLSearchParams({ query, display: "5" });
  const res = await fetch(`${BASE}/local.json?${qs}`, { headers: headers() });
  if (!res.ok) throw new Error(`지역 검색 API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { items?: any[] };
  return (data.items ?? []).map((it) => ({
    title: stripTags(it.title ?? ""),
    category: it.category ?? "",
    address: it.address ?? "",
    roadAddress: it.roadAddress ?? "",
    link: it.link ?? "",
  }));
}
