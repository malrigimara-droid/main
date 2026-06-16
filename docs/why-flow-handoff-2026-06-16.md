# why-flow 결정 요약 (→ 맥 마스터 md에 머지할 델타)

> ⚠️ 마스터는 맥 환경의 마크다운. 이 파일은 이번 세션에서 뽑은 *결정사항 전송용*.
> 정리일: 2026-06-16

---

## 1. 확정 결정

| # | 결정 | 비고 |
|---|---|---|
| D1 | 측정 공백 확인 → **인테이크 설문에서 미리** 받음 | 진단 화면 즉석 질문 아님 |
| D2 | 빠르게 vs 천천히 → **결과 화면 토글, 사장님이 직접** 선택 | route 질문은 설문에 안 넣음 |
| D3 | 정직성 가드 → **확신 톤 유지, '미측정 사실 단정'만 차단** | "샙니다"(미측정 단정)는 막고, "가장 위험한 구멍"(우선순위)은 허용 |
| D4 | `reach`(업종 성격)로 지리 확장 결정 | 왁싱=동 고수 / 공방=구 확장 |
| D5 | gap 질문 → **기존 `loyalty` 문항에 보기 2개 흡수 + 측정 전일 때만 조건부 노출** | 순증 문항 0, 평균 길이 감소 |

## 2. 설문 구조 (정렬 결과)

```
A. 가게 현황      q1 · q3 · q4              [내용은 맥에서 확인]
B. 막힌 단계 확인  loyalty (+gap 보기 2개)    ← 측정 전 단계 있을 때만 노출
C. 콘텐츠 재료    강점·톤·타깃 · reviews(후기)
[결제란은 설문 밖, 맨 끝]
```
순서 근거: **A(누구냐) → B(어디서 막혔나) → C(뭘로 푸나)** = 진단→처방→실행 흐름.

`loyalty` 흡수 형태:
```
"단골/재방문, 지금 어떻게 챙기세요?"
  ☐ 네이버예약·캐치테이블·전화장부로 관리 중   → managed_elsewhere (처방 아님, 데이터 연결만)
  ☐ 따로 안 함                                → true_gap (1순위 처방 후보)
```

## 3. why-flow 엔진 핵심 규칙

1. **pickBottleneck** — `true_gap`인 측정 전 단계를 최우선 승격. `managed_elsewhere`는 승격 안 함(헛다리 금지).
2. **분기**
   - 병목 = 발견/전환 → `keyword_routes` (정공법/속효 두 길 → 토글)
   - 병목 = 재방문 → `retention_loop` (측정장치부터, 키워드 확장 안 함)
   - 병목 = 추천 → `referral_loop`
   - `managed_elsewhere` → `connect_data` (데이터 연결만)
3. **expandGeo(reach, dongDemand)** — destination(공방)=구 확장 적극 / hybrid=전문성 키워드만 / proximity(왁싱)=동 고수.
4. **두 길 (buildRoutes)**
   - 정공법(organic): win_now→contest→prize, 사장님 직접, 평가 d21 blog_rank
   - 속효(amplified): 큰 키워드부터 유료 상위노출·카페, 평가 d7 inflow

## 4. 카피 톤 원칙 (정직성 가드)

- **차단**: 측정 안 한 수치·상태를 사실로 단정 — "재방문율 X% 샌다", "재방문에서 샙니다"
- **권장**: 위험·우선순위·방향을 확신 있게 — "지금 가장 위험한 구멍은 재방문", "제일 무섭다"
- measured 단계는 무엇이든 단정 OK. estimated는 "추정/참고" 명시. unmeasured는 위 권장 톤.

## 5. 맥에서 확인/배선할 것

- [ ] q1·q3·q4·loyalty **실제 문항 내용** → A/B/C 최종 배치, 중복 제거
- [ ] `loyalty`에 gap 보기 2개 흡수 + `showWhen=측정전` 조건부 렌더
- [ ] 결과 화면 정공법/속효 **토글 UI** + intake `reviews`/강점 연결 유지
- [ ] `reach`를 업종 프로필에 1줄로 (waxing=proximity, 공방/clay=destination)
- [ ] why-flow 모듈을 `lib/`에 배치 후 share-map·measurement와 배선

## 6. 참고 코드
이 세션 브랜치 `claude/epic-noether-md3wf6`의 `lib/why-flow.ts` (초안 구현). 맥으로 복사 후 정본에 맞춰 수정.
