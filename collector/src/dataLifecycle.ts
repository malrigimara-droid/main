// ─── 데이터 수명주기: 동의 → 접근권 → 검증 게이트 → 파기 ────────
//
// "타개_고객데이터_수명주기_관리체계.md"의 코드 구현.
// 핵심 장치:
//  1. 동의 없으면 저장 불가 — requireConsent()가 모든 수집 경로의 게이트
//  2. 모든 부여·해제·파기가 이벤트 로그에 남는다 (감사 추적 자동)
//  3. 해지 시 offboardStore() 한 번이면 해제→파기→통지 순서가 보장된다

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendEvent, readEvents } from "./eventLog.js";

const LEDGER_DIR = process.env.LEDGER_DIR ?? ".ledger";
const ledgerFile = () => path.join(LEDGER_DIR, "ledger.json");

export const CONSENT_SCOPE_VERSION = "v1.0"; // 동의서 조항 바뀌면 반드시 올릴 것

export interface ConsentRecord {
  consentId: string;
  storeId: string;
  scopeVersion: string;
  grantedAt: string;
  withdrawnAt?: string;
  signedBy: string;            // 대표자명
  method: "paper" | "kakao_confirm" | "web_form";
}

export interface AccessGrant {
  grantId: string;
  storeId: string;
  type: "place_member" | "meta_oauth" | "kakao_sender" | "review_raw" | "owner_chat" | "biz_info";
  grade: "A" | "B" | "C";
  grantedAt: string;
  consentId: string;           // 어떤 동의에 근거하는지 — 근거 없는 grant 금지
  storageLocation: string;     // 파기 시 추적: 실제 데이터가 있는 경로/테이블
  backupLocations: string[];
  status: "active" | "revoked" | "destroyed";
  revokedAt?: string;
  destroyedAt?: string;
}

interface Ledger { consents: ConsentRecord[]; grants: AccessGrant[]; }

async function loadLedger(): Promise<Ledger> {
  try { return JSON.parse(await readFile(ledgerFile(), "utf-8")); }
  catch { return { consents: [], grants: [] }; }
}
async function saveLedger(l: Ledger) {
  await mkdir(LEDGER_DIR, { recursive: true });
  await writeFile(ledgerFile(), JSON.stringify(l, null, 2), "utf-8");
}

// ── 1. 동의 ──────────────────────────────────────────────────

export async function recordConsent(opts: {
  storeId: string; signedBy: string; method: ConsentRecord["method"];
}): Promise<ConsentRecord> {
  const ledger = await loadLedger();
  const consent: ConsentRecord = {
    consentId: randomUUID(), storeId: opts.storeId,
    scopeVersion: CONSENT_SCOPE_VERSION,
    grantedAt: new Date().toISOString(),
    signedBy: opts.signedBy, method: opts.method,
  };
  ledger.consents.push(consent);
  await saveLedger(ledger);
  await appendEvent({ type: "consent_granted", storeId: opts.storeId, actor: "operator",
    consentId: consent.consentId, scopeVersion: consent.scopeVersion });
  return consent;
}

/** 게이트: 유효 동의 확인. 모든 수집·게시 함수의 첫 줄에서 호출할 것. */
export async function requireConsent(storeId: string): Promise<ConsentRecord> {
  const ledger = await loadLedger();
  const c = ledger.consents.find((c) => c.storeId === storeId && !c.withdrawnAt);
  if (!c) throw new Error(`[consent_gate] ${storeId}: 유효한 동의 없음 — 수집/게시 불가. recordConsent 먼저.`);
  if (c.scopeVersion !== CONSENT_SCOPE_VERSION)
    throw new Error(`[consent_gate] ${storeId}: 동의서 구버전(${c.scopeVersion}) — 재동의 필요.`);
  return c;
}

// ── 2. 접근권 부여 (동의 있어야만 가능) ──────────────────────

const GRADE: Record<AccessGrant["type"], AccessGrant["grade"]> = {
  place_member: "A", meta_oauth: "A", kakao_sender: "A", owner_chat: "C",
  biz_info: "B", review_raw: "C",
};

export async function grantAccess(opts: {
  storeId: string; type: AccessGrant["type"];
  storageLocation: string; backupLocations?: string[];
}): Promise<AccessGrant> {
  const consent = await requireConsent(opts.storeId); // 게이트
  const ledger = await loadLedger();
  const grant: AccessGrant = {
    grantId: randomUUID(), storeId: opts.storeId, type: opts.type,
    grade: GRADE[opts.type], grantedAt: new Date().toISOString(),
    consentId: consent.consentId,
    storageLocation: opts.storageLocation,
    backupLocations: opts.backupLocations ?? [],
    status: "active",
  };
  ledger.grants.push(grant);
  await saveLedger(ledger);
  await appendEvent({ type: "access_granted", storeId: opts.storeId, actor: "operator",
    grantId: grant.grantId, accessType: grant.type, grade: grant.grade });
  return grant;
}

// ── 3. 해지(오프보딩): 해제 → 파기 → 통지 순서 보장 ───────────

export async function offboardStore(storeId: string, opts?: {
  destroyNow?: boolean;        // true면 즉시 파기 (기본: 해제만, 파기는 30일 배치)
  notify?: (storeId: string, summary: string) => Promise<void>; // 알림톡/메일 콜백
}) {
  const ledger = await loadLedger();
  const now = new Date().toISOString();

  // D+0: 동의 철회 기록 + A등급 즉시 해제
  for (const c of ledger.consents.filter((c) => c.storeId === storeId && !c.withdrawnAt)) {
    c.withdrawnAt = now;
    await appendEvent({ type: "consent_withdrawn", storeId, actor: "operator",
      consentId: c.consentId, scopeVersion: c.scopeVersion });
  }
  const active = ledger.grants.filter((g) => g.storeId === storeId && g.status === "active");
  for (const g of active) {
    g.status = "revoked"; g.revokedAt = now;
    await appendEvent({ type: "access_revoked", storeId, actor: "operator",
      grantId: g.grantId, accessType: g.type, grade: g.grade });
    if (g.grade === "A")
      console.log(`[수동 작업 필요] ${g.type} 위임/토큰 해제: 스마트플레이스 멤버 탈퇴 또는 OAuth 폐기 → ${g.storageLocation}`);
  }
  await saveLedger(ledger);

  if (opts?.destroyNow) await destroyRevoked(storeId, 0, opts.notify);
  return { revoked: active.length };
}

/** D+30 배치(또는 즉시): revoked 상태 C등급 데이터 실제 삭제 + 통지 */
export async function destroyRevoked(
  storeId?: string,
  graceDays = 30,
  notify?: (storeId: string, summary: string) => Promise<void>,
) {
  const ledger = await loadLedger();
  const cutoff = Date.now() - graceDays * 86400000;
  const targets = ledger.grants.filter((g) =>
    g.status === "revoked" &&
    (!storeId || g.storeId === storeId) &&
    Date.parse(g.revokedAt!) <= cutoff &&
    g.grade !== "B"); // B(사업자정보)는 법정 보존 별도 — 격리 테이블에서 관리

  const byStore = new Map<string, AccessGrant[]>();
  for (const g of targets) {
    // 실제 데이터 삭제 (파일 기반 v1; DB 전환 시 이 부분만 교체)
    for (const loc of [g.storageLocation, ...g.backupLocations]) {
      try { await rm(loc, { recursive: true, force: true }); } catch { /* 이미 없음 */ }
    }
    g.status = "destroyed"; g.destroyedAt = new Date().toISOString();
    byStore.set(g.storeId, [...(byStore.get(g.storeId) ?? []), g]);
  }
  await saveLedger(ledger);

  for (const [sid, grants] of byStore) {
    await appendEvent({ type: "data_destroyed", storeId: sid, actor: "system",
      grantIds: grants.map((g) => g.grantId) });
    const summary = `위임 해제 및 데이터 파기 완료: ${grants.map((g) => g.type).join(", ")}`;
    if (notify) {
      await notify(sid, summary);
      await appendEvent({ type: "destruction_notified", storeId: sid, actor: "system",
        grantIds: grants.map((g) => g.grantId) });
    }
  }
  return { destroyed: targets.length };
}

// ── 4. 감사 리포트: "우리는 파기까지 관리합니다"의 증빙 ────────

export async function auditReport(storeId: string) {
  const ledger = await loadLedger();
  const trail = await readEvents({
    storeId,
    types: ["consent_granted", "consent_withdrawn", "access_granted", "access_revoked", "data_destroyed", "destruction_notified"],
  });
  return {
    storeId,
    consents: ledger.consents.filter((c) => c.storeId === storeId),
    grants: ledger.grants.filter((g) => g.storeId === storeId)
      .map(({ grantId, type, grade, status, grantedAt, revokedAt, destroyedAt }) =>
        ({ grantId, type, grade, status, grantedAt, revokedAt, destroyedAt })),
    auditTrail: trail.map((e) => ({ at: e.at, type: e.type })),
  };
}
