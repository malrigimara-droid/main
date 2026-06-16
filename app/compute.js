// 리가메디 발주 산출 엔진 (서버·클라이언트 공용 가능한 순수 로직)
// 발주 = 기본 상품별 독립. 전환/스위칭 성분은 두 브랜드 재고를 합산해 전환 대상(active) 브랜드로 발주.
'use strict';

const ceilPack = n => Math.max(0, Math.ceil(n / 10) * 10);   // 10정 단위 올림
const norm = s => String(s).replace(/\s+/g, '').toLowerCase();

// 현재고 CSV(약품명,현재고) → { 브랜드명: 수량 }
function parseStockCSV(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return {};
  const head = lines[0].split(',').map(s => s.trim());
  const nameI = head.findIndex(h => /약품명|품명|상품명|제품명|name/i.test(h));
  const qtyI = head.findIndex(h => /현재고|재고|수량|qty|stock/i.test(h));
  const start = (nameI >= 0 && qtyI >= 0) ? 1 : 0;
  const map = {};
  for (const l of lines.slice(start)) {
    const c = l.split(',');
    const name = (nameI >= 0 ? c[nameI] : c[0] || '').trim();
    const qty = (qtyI >= 0 ? c[qtyI] : c[1] || '').trim();
    if (name) map[name] = Number(qty) || 0;
  }
  return map;
}

// 현재고 맵을 상품(브랜드)에 매칭해 stock 갱신
function applyStock(generics, stockMap) {
  const prods = [];
  generics.forEach(g => g.products.forEach(p => prods.push(p)));
  let updated = 0; const miss = [];
  for (const [name, qty] of Object.entries(stockMap)) {
    const key = norm(name);
    let p = prods.find(x => norm(x.brand) === key);
    if (!p) p = prods.find(x => key.includes(norm(x.brand)) || norm(x.brand).includes(key));
    if (p) { p.stock = Math.max(0, Number(qty) || 0); updated++; }
    else miss.push(name);
  }
  return { updated, miss };
}

// 안전재고 설정값 덮어쓰기 (스위칭=성분 id 키, 독립=브랜드 키)
function applySettings(generics, settings) {
  const safety = (settings && settings.safety) || {};
  for (const g of generics) {
    if (g.switching) { if (safety[g.id] != null) g.safety = Number(safety[g.id]); }
    else { for (const p of g.products) { if (safety[p.brand] != null) p.safety = Number(safety[p.brand]); } }
  }
}

// 발주 산출: 안전재고 설정값과 현재고의 차이 → 제안 발주량
function computeGenerics(generics) {
  const lines = [];
  for (const g of generics) {
    if (g.switching) {
      const active = g.products.find(p => p.active) || g.products[0];
      const stock = g.products.reduce((s, p) => s + (p.stock || 0), 0);
      const rop = g.avg * g.lead + g.safety;
      const need = ceilPack(rop - stock + (g.ai || 0));
      for (const p of g.products) {
        lines.push({
          gen: g.gen, brand: p.brand, maker: p.maker || '', psy: !!g.psy,
          mode: 'switching', switchKind: g.switchKind, active: p === active,
          stock: p.stock || 0, groupStock: stock, avg: g.avg, safety: g.safety, lead: g.lead,
          rop, need: p === active ? need : 0, unit: p.unit || 0, safetyKey: g.id
        });
      }
    } else {
      for (const p of g.products) {
        const rop = p.avg * p.lead + p.safety;
        const need = ceilPack(rop - p.stock + (p.ai || 0));
        lines.push({
          gen: g.gen, brand: p.brand, maker: p.maker || '', psy: !!g.psy,
          mode: 'independent', stock: p.stock || 0, avg: p.avg, safety: p.safety, lead: p.lead,
          rop, need, unit: p.unit || 0, safetyKey: p.brand
        });
      }
    }
  }
  return lines;
}

function summarize(lines) {
  let kinds = 0, qty = 0, amt = 0, psy = 0;
  for (const l of lines) {
    if (l.need > 0) { kinds++; qty += l.need; amt += l.need * l.unit; if (l.psy) psy++; }
  }
  return { kinds, qty, amt, psy };
}

// 발주서 CSV (발주량>0 품목만)
function orderCSV(lines) {
  const rows = [['성분', '상품(브랜드)', '제조사', '발주수량', '단가', '금액', '향정']];
  let total = 0;
  for (const l of lines) {
    if (l.need > 0) {
      const amt = l.need * l.unit; total += amt;
      rows.push([l.gen, l.brand, l.maker, l.need, l.unit, amt, l.psy ? 'Y' : '']);
    }
  }
  rows.push(['합계', '', '', '', '', total, '']);
  return rows.map(r => r.join(',')).join('\n');
}

module.exports = { ceilPack, parseStockCSV, applyStock, applySettings, computeGenerics, summarize, orderCSV };
