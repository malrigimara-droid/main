// 리가메디 발주 산출 사이트 (v1) — Express
// 현재고 CSV 업로드 → 안전재고 차이 산출 → 발주서 CSV 출력. 안전재고 설정은 파일로 영속.
'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const C = require('./compute');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA = path.join(__dirname, 'data');
const loadJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return def; } };
const saveJSON = (f, obj) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(obj, null, 2));
const clone = o => JSON.parse(JSON.stringify(o));

// 약품마스터 + (영속된)현재고 + 안전재고설정을 적용한 작업본 생성
function buildGenerics() {
  const generics = clone(loadJSON('drugs.json', { generics: [] }).generics);
  const stock = loadJSON('current_stock.json', {});
  if (Object.keys(stock).length) C.applyStock(generics, stock);
  C.applySettings(generics, loadJSON('settings.json', { safety: {} }));
  return generics;
}
const result = () => {
  const lines = C.computeGenerics(buildGenerics());
  return { lines, summary: C.summarize(lines) };
};

app.get('/api/proposal', (req, res) => res.json(result()));

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  const map = C.parseStockCSV(req.file.buffer.toString('utf8'));
  const generics = clone(loadJSON('drugs.json', { generics: [] }).generics);
  const r = C.applyStock(generics, map);
  const stockStore = {};
  generics.forEach(g => g.products.forEach(p => { stockStore[p.brand] = p.stock; }));
  saveJSON('current_stock.json', stockStore);   // 업로드 현재고 영속
  res.json(Object.assign({ updated: r.updated, miss: r.miss }, result()));
});

app.post('/api/settings', (req, res) => {
  const s = loadJSON('settings.json', { safety: {} });
  s.safety = s.safety || {};
  const { key, safety } = req.body || {};
  if (key != null && safety !== '' && !isNaN(Number(safety))) { s.safety[key] = Number(safety); saveJSON('settings.json', s); }
  res.json(Object.assign({ ok: true }, result()));
});

app.get('/api/order.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="order.csv"');
  res.send('﻿' + C.orderCSV(C.computeGenerics(buildGenerics())));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('리가메디 발주 산출 사이트 → http://localhost:' + PORT));
