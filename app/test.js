// 산출 엔진 검증 (의존성 없이: node test.js)
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./compute');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/drugs.json'), 'utf8')).generics;
const csv = fs.readFileSync(path.join(__dirname, 'sample/현재고_샘플.csv'), 'utf8');
const clone = () => JSON.parse(JSON.stringify(base));
const brand = (lines, b) => lines.find(l => l.brand === b);

let fail = 0;
const eq = (name, got, exp) => { const ok = got === exp; if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${name}: ${got}${ok ? '' : ' (기대 ' + exp + ')'}`); };

// 1) 기본값(업로드 전) 산출
let lines = C.computeGenerics(clone());
eq('디오피정 기본 제안', brand(lines, '디오피정').need, C.ceilPack(204 - 140));       // 70
eq('아빌리파이 기본 제안', brand(lines, '아빌리파이').need, C.ceilPack(114 - 80));      // 40
eq('클로나제팜 합산 제안(active=환인)', brand(lines, '환인클로나제팜').need, C.ceilPack(132 - 80)); // 60
eq('클로나제팜 비대상(리보트릴) 발주 0', brand(lines, '리보트릴').need, 0);

// 2) 현재고 CSV 업로드 반영 후 산출
let g = clone();
const r = C.applyStock(g, C.parseStockCSV(csv));
eq('CSV 매칭 품목 수', r.updated, 10);
eq('미매칭 0건', r.miss.length, 0);
lines = C.computeGenerics(g);
eq('디오피정 업로드후(현재고40)', brand(lines, '디오피정').need, C.ceilPack(204 - 40));   // 170
eq('클로나제팜 업로드후(20+15=35 합산)', brand(lines, '환인클로나제팜').need, C.ceilPack(132 - 35)); // 100

// 3) 안전재고 설정 덮어쓰기 → ROP 변화
g = clone();
C.applySettings(g, { safety: { '디오피정': 200 } });
eq('디오피정 안전재고 200 → ROP', brand(C.computeGenerics(g), '디오피정').rop, 200 + 42 * 2); // 284

// 4) 발주서 CSV 헤더
eq('발주서 CSV 헤더', C.orderCSV(C.computeGenerics(clone())).split('\n')[0], '성분,상품(브랜드),제조사,발주수량,단가,금액,향정');

console.log(fail === 0 ? '\n전체 통과 ✅' : `\n실패 ${fail}건 ❌`);
process.exit(fail === 0 ? 0 : 1);
