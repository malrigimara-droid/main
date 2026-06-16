const won = n => '₩' + (n || 0).toLocaleString('ko-KR');
const msg = m => { document.getElementById('msg').textContent = m; };
const cell = (k, v) => `<div class="c"><div class="k">${k}</div><div class="v">${v}</div></div>`;

function render(d) {
  const t = document.getElementById('rows');
  t.innerHTML = '';
  for (const l of d.lines) {
    const tr = document.createElement('tr');
    if (l.mode === 'switching') tr.className = l.active ? 'sw act' : 'sw';
    const name = l.mode === 'switching'
      ? `<b>${l.brand}</b> <small>${l.maker} · ${l.gen} · ${l.active ? '전환대상·발주' : '소진'}</small>`
      : `${l.gen} <small>${l.brand} · ${l.maker}</small>`;
    const stock = l.mode === 'switching'
      ? `${l.stock} <small>(합산 ${l.groupStock})</small>` : l.stock;
    tr.innerHTML =
      `<td class="l">${name}${l.psy ? ' <span class="psy">향정</span>' : ''}</td>
       <td>${stock}</td>
       <td><input class="safety" data-key="${l.safetyKey}" type="number" min="0" step="10" value="${l.safety}"></td>
       <td>${l.avg}</td><td>${l.rop}</td><td class="need"><b>${l.need}</b></td>`;
    t.appendChild(tr);
  }
  const s = d.summary;
  document.getElementById('summary').innerHTML =
    cell('발주 종수', s.kinds + ' 종') + cell('총 수량', s.qty + ' 정') +
    cell('예상 금액', won(s.amt)) + cell('향정 포함', s.psy + ' 종');
}

async function load() {
  const r = await fetch('/api/proposal');
  render(await r.json());
}

document.getElementById('upform').addEventListener('submit', async e => {
  e.preventDefault();
  const f = document.getElementById('file').files[0];
  if (!f) { msg('현재고 파일을 선택하세요.'); return; }
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  const d = await r.json();
  if (d.error) { msg(d.error); return; }
  msg(`✓ ${d.updated}개 품목 갱신${d.miss.length ? ` · 미매칭 ${d.miss.length}건(${d.miss.slice(0, 3).join(', ')}${d.miss.length > 3 ? ' 외' : ''})` : ''} → 발주 필요 ${d.summary.kinds}종`);
  render(d);
});

document.getElementById('rows').addEventListener('change', async e => {
  if (e.target.classList.contains('safety')) {
    const r = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: e.target.dataset.key, safety: e.target.value })
    });
    render(await r.json());
    msg('안전재고 설정 저장됨 · 재산출 완료');
  }
});

load();
