# 타개 세션 컨텍스트 — 2026-07-05 ~ 07-06

> 다음 대화 시작 시 이 파일을 먼저 읽힐 것.
> 마스터 문서는 맥(`~/dev/tagae` + 마크다운). 이 파일은 세션 인수인계용 스냅샷.
> 작업 브랜치: `malrigimara-droid/main` → `claude/epic-noether-md3wf6`

---

## 1. 타개(tagae.kr) 현재 전략 상태

- **wedge**: 동네 체험형·예약형 1인 사업자 (검증 케이스: 고고왁싱=방배·근접/재방문형, 모먼츠비올라=이매동·destination형)
- **리뉴얼 3결정 (확정)**: ① 진단 전체 무료 + 동행(월 20만, 실행 대행)만 유료 ② 리포트 A4 재구성 ③ 도표 중심 디자인
  - 파생 원칙: 도표 정직성(측정=실선/추정=점선/측정전=빗금), 갈증은 마스킹 대신 **등급 훅**으로
- **4DX 적용 방향**: 병목 1개=WIG / 동행 할일3개=선행지표 / 주간 점수판(사장님 몫 1칸 필수) / 월간→주간 책무 리듬
- **커뮤니티 구상 재정의**: "머무를 공간"은 웹사이트가 아니라 **리듬** — ① 리듬(주간 동네 상권 브리핑, 카톡 발송) ② 공간(tagae.kr=아카이브·검색/AI 유입 그릇) ③ 관계 이벤트(무료 진단). UGC 게시판은 Phase 3까지 금지(빈 식당 문제, 아프니까사장이다와 정면승부 회피)
- **정직성 가드**: 미측정 사실 단정 금지("샙니다" X), 확신 톤은 유지("가장 위험한 구멍" O). why-flow에 코드화됨

## 2. 리포트 목업 (A4 리뉴얼 v0.3)

- 파일: `docs/report-mock-v0.html` · 아티팩트 URL 유지 중 (고고왁싱 실데이터 기반)
- 반영됨: 오늘 할 일 1개(0원·10초) / 46점 계산근거 한 줄 / 측정전→해결주체 연결 / SEO·GEO·AIO 3표면 카드(약어 우선) / 4DX 주간 점수판(타개몫·사장님몫) / 게이지 경고색(46=호박색) / 다크모드 검증 팔레트(#0DA271·#C77E35, brand-fill 토큰) / A4 인쇄 CSS(print-color-adjust) / 다음 진단 날짜 푸터
- 결정: 동행 CTA에 가격 숨김
- 미검증: 실브라우저 스크린샷 검수(원격 환경에 크로미움 설치 불가) — 맥에서 다크모드 토글 + Cmd+P 인쇄 미리보기 확인 필요

## 3. MEPiX 벤치마킹 (상세: `docs/handoff-2026-07-06-mepix.md`)

- mepix.ai = GEO/AEO 진단 SaaS. 정밀진단은 **진짜 실측**(질문24×엔진5=120셀, 네이버 AI 브리핑 실물 캡처) — "무료=스크랩 요약" 초기 판단은 정밀엔 틀림(정정 기록됨)
- 훔칠 것: 입력 1개 온보딩 / 결과물 예고 카드 / 등급 훅+다음 등급까지 n점 / **인용 출처 분해**(남의 글 81%·우리 0%) / 질문 매트릭스 문법 / 효과●●●·노력●○○ / 쉬운 언어 사전
- **통합 논리(전략 핵심)**: AI가 로컬 가게 추천 시 인용 근거 = 블로그·플레이스 → **타개의 블로그·플레이스 작업이 곧 GEO 작업**. 키워드 점유 맵과 GEO가 한 처방으로 통합
- 차별축 4 (MEPiX가 못 오는 땅): ① 입구(도메인 없는 가게) ② 실행(동행 대행) ③ 검증(재실측 델타→예측 채점·적중률 공개) ④ 사슬(재방문·추천 병목)

## 4. llmProbe — AI 노출 실측 (신규 구축, 동작 확인됨)

**코드 위치**: 브랜치의 `collector/` (타개 collector 편입본)
- `src/llmProbe.ts` — 질문 템플릿(업종×지역, waxing·craft_class) × 엔진 → 별칭 매칭 판정 → 가시성·SoV·놓친질문 집계 → measurement 이벤트 적재(재실측 델타용)
- `src/probeEngines.ts` — 엔진 4종: `claude`(무검색) / `claude_search`(웹검색+citations) / `chatgpt`(Responses API+web_search) / `gemini`(google_search 그라운딩). 키 있는 엔진만 자동 편성
- `src/probeDemo.ts` — 러너. `npx tsx src/probeDemo.ts [gogowaxing|momentsviola]`
- `llm.ts` 수정: temperature 폐기 모델(sonnet-5 등) 자동 재시도 처리

**맥 실행법**:
```bash
cd ~/dev/tagae-probe && git pull && cd collector
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...
npx tsx src/probeDemo.ts gogowaxing | tee gogo-probe.txt
```

**첫 실측 발견 (claude 무검색, 11셀)**: 전원 미등장 — 우리도 경쟁사도 0. **"웹검색 없는 AI에게 동네 가게는 존재하지 않는다"** → 로컬 GEO 게임은 모델 지식이 아니라 검색 소스(블로그·플레이스) 싸움 = 통합 논리 실측 증거 1호

**결정**: probe는 API 유지(가게당 월 ~700원). 소비자 구독(Plus 등)을 API에 녹이는 공식 방법 없음, 웹 자동화는 약관 위반이라 배제. 공식 CLI(Claude Code/Codex/Gemini CLI) 어댑터는 가능하나 측정 순도·유지비 때문에 보류

**⚠ 보안**: 7/6 채팅에 Anthropic 키 전체 노출됨 → **콘솔에서 폐기·재발급 필요** (했는지 확인!)

## 5. 다음 액션 (우선순위순)

1. **[맥] 고고왁싱 4엔진 실측 실행** ← 진행 중이던 것. 결과 해석 포인트: ① 검색 열에서 고고왁싱 등장? ② "대신 추천된 곳"이 블로그 순위(포라누나 1위)와 일치? ③ citations 도메인 구성(blog.naver 비중)
2. 실측 결과 → 질문 템플릿 튜닝 + 리포트에 "무검색 vs 검색" 대비 카드 설계
3. eventLog metric에 `ai_visibility` 추가 (지금 `inflow` 임시 차용 — llmProbe.ts TODO)
4. Perplexity 어댑터 (citations 최강) — 키 확보 시
5. 모먼츠비올라 실측 → destination형 비교
6. 목업 v0.4: MEPiX 훔칠 것 반영 (예고 카드·등급 훅·효과/노력 점)
7. 맥 마스터에 핸드오프 3종 머지: `why-flow-handoff-2026-06-16.md` / `handoff-2026-07-06-mepix.md` / 이 파일

## 6. 저장소 파일 지도 (브랜치 기준)

```
lib/why-flow.ts                      병목 판정 + 서술 가드 + 사다리/속효 두 길 (초안)
docs/report-mock-v0.html             A4 리포트 목업 v0.3
docs/why-flow-handoff-2026-06-16.md  설문 A/B/C·gap 흡수·route 토글 결정
docs/handoff-2026-07-06-mepix.md     MEPiX 벤치마킹 상세
docs/session-context-2026-07-06.md   ← 이 파일
collector/                           수집·분석 모듈 + llmProbe 일체
```
