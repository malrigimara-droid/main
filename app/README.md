# 리가메디 발주 산출 사이트 (v1)

프로토타입(목업)을 실제 동작하는 사이트로 옮긴 첫 모듈. **현재고 CSV 업로드 → 안전재고 차이 산출 → 발주서 CSV 출력.**

## 실행
```bash
cd app
npm install
npm start          # http://localhost:3000
npm test           # 산출 엔진 검증
```

## 구성
| 파일 | 역할 |
|---|---|
| `server.js` | Express 서버 · API |
| `compute.js` | 산출 엔진(독립/스위칭 발주, CSV 파싱, 발주서 생성) — 서버·클라 공용 로직 |
| `data/drugs.json` | 약품 마스터(성분·상품·안전재고·리드타임·단가·향정) |
| `data/settings.json` | 안전재고 설정 덮어쓰기(영속) |
| `data/current_stock.json` | 업로드된 현재고(영속, git 제외) |
| `public/` | 웹페이지(업로드·표·안전재고 수정·발주서 다운로드) |
| `sample/현재고_샘플.csv` | 업로드 양식 샘플 |

## API
| 메서드·경로 | 설명 |
|---|---|
| `GET /api/proposal` | 현재 산출 결과(라인·요약) |
| `POST /api/upload` (multipart `file`) | 현재고 CSV 업로드 → 갱신·재산출 |
| `POST /api/settings` (`{key,safety}`) | 안전재고 설정 저장 → 재산출 |
| `GET /api/order.csv` | 발주서 CSV 다운로드 |

## 산출 규칙
- 발주는 **상품(브랜드)별 독립**: `제안 = ceil10(일평균×리드타임 + 안전재고 − 현재고)`
- **전환/스위칭 성분**: 두 브랜드 재고를 합산해 ROP와 비교 → 부족분을 **전환 대상(active) 브랜드**로 발주, 나머지 0.

## TODO (다음)
- 현재고 파일 실제 포맷(카페24/이지스) 매칭 · 약품코드 기준 매칭
- 발주서를 **SIMS 매입/매출 엑셀등록 양식**으로 출력
- 약품 마스터/설정을 MySQL로, 병원 로그인(다중 테넌트)
