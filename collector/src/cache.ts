// ─── 파일 기반 캐시 (v1: 단순 JSON, v2에서 SQLite/DB로 교체) ────

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.CACHE_DIR ?? ".cache";

function fileFor(key: string) {
  return path.join(DIR, key.replace(/[^a-zA-Z0-9가-힣:_-]/g, "_") + ".json");
}

export async function getCache<T>(key: string, ttlSeconds: number): Promise<T | null> {
  try {
    const raw = await readFile(fileFor(key), "utf-8");
    const { savedAt, value } = JSON.parse(raw) as { savedAt: number; value: T };
    if (Date.now() - savedAt > ttlSeconds * 1000) return null;
    return value;
  } catch {
    return null;
  }
}

export async function setCache<T>(key: string, value: T): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(fileFor(key), JSON.stringify({ savedAt: Date.now(), value }, null, 2), "utf-8");
}
