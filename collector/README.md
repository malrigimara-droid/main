# TaGae Collector — 타개 상권 데이터 수집·분석 모듈

## 구성
| 파일 | 역할 | 자동화 |
|---|---|---|
| `naverSearchAd.ts` | 키워드 월간 검색량 (검색광고 API) | 완전 자동 |
| `naverOpenApi.ts` | 블로그/지역 검색 (오픈 API, 일 25,000회) | 완전 자동 |
| `keywordShareMap.ts` | 수요×노출 합성 → 키워드 점유/기회 맵 | 완전 자동 (캐시 7일) |
| `reviewIngest.ts` | 플레이스 리뷰 붙여넣기/CSV 파싱 | **수동 수집** |
| `reviewAnalysis.ts` | 리뷰 토픽·감성·재방문 신호 분석 (Claude) | 완전 자동 |
| `actionLayer.ts` | **실행물 3종 생성**: 블로그 초안·플레이스 소개문·재방문 메시지 | 완전 자동 |
| `eventLog.ts` | **이벤트 로그(척추)**: append-only + 3개 뷰(적중률·품질알림·월간리포트) | 완전 자동 |
| `dataLifecycle.ts` | **동의 게이트·접근권 대장·해지 시 파기·감사 추적** | 완전 자동 |
| `measurement.ts` | **측정**: 통계 입력→이벤트, 마감 목록, hit/miss 검증, 델타 리포트 | 입력만 수동(30초) |
| `channelRegistry.ts` | **유입 우주 온톨로지**: 12채널 × 업종 관련도 × 즉시성 → 우선순위 계산 | 완전 자동 |
| `channelDeliverables.ts` | **채널 조건부 생성**: 병목→채널 선정→채널별 실행물(변형 회전)→이벤트 | 완전 자동 |
| `chatbot.ts` | **사장님 챗봇(루프 2)**: 병목 역산 질문, 분류 게이트(risk 차단), 에피소드 추출, 일일 상한 | 완전 자동 |
| `monthlyReport.ts` | **월간 리포트**: facts(코드)+서술(LLM)+숫자 가드+환각 폴백 → 마크다운 | 완전 자동 |
| `qualityGate.ts` | **게시 전 품질 게이트**: 린트+LLM심사 → 피드백 수정 루프(상한) → needs_human, 누적 교훈 주입, 게이트 통계 | 완전 자동 |

## 수집/분석 분리 원칙
플레이스 순위·리뷰는 공식 API가 없어 자동 크롤링은 약관·법적 리스크가 있음.
→ **수집은 사람(붙여넣기 3~5분), 분석은 기계.** 정식 데이터 경로가 생기면
`ReviewSource` 구현체만 교체하면 됨.

## 시작
```bash
npm install
cp .env.example .env   # 키 입력
npx tsx src/index.ts   # 데모 실행
```

## 비용 설계
- 점유 맵: 상권×업종 캐시 7일 → 진단 1건당 API 호출 ≈ 0
- 리뷰 분석: Haiku, temperature 0, 50건 배치, 재시도 1회 상한
- 숫자는 전부 코드가 계산, LLM은 분류·발췌만 (결정성 + 비용)
