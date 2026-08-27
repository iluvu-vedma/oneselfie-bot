import { Redis } from "@upstash/redis";
import { DAILY_TTL_SEC, REPORT_TZ } from "./config";
import { k } from "./keys";

/**
 * Key-value без схем, ORM и миграций.
 * Работает и с Upstash напрямую, и с Vercel KV (интеграция кладёт KV_REST_API_*).
 */
const url =
  process.env.UPSTASH_REDIS_REST_URL ??
  process.env.KV_REST_API_URL ??
  "";
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ??
  process.env.KV_REST_API_TOKEN ??
  "";

if (!url || !token) {
  throw new Error(
    "KV is unset: нужны UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (или KV_REST_API_URL / KV_REST_API_TOKEN)"
  );
}

export const redis = new Redis({ url, token });

// ── Ключи ────────────────────────────────────────────────────────────────────
// Карта живёт в keys.ts — ею пользуются и бот, и проверочные скрипты.
export { k };

export function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * Дата в поясе отчётов, `2026-08-24`. Именно en-CA даёт год-месяц-день —
 * ключи такого вида сортируются как строки.
 */
const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: REPORT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function dayKey(at: number = Date.now()): string {
  return DAY.format(at);
}

/**
 * Счётчики. Ошибка статистики не должна ронять сценарий.
 *
 * Пишутся два числа: за всё время и за сегодня. Срок дневному ключу ставится
 * только в момент его появления — иначе EXPIRE уходил бы на каждое событие.
 */
export async function bump(event: string, by = 1): Promise<void> {
  try {
    const day = k.statDay(event, dayKey());
    await Promise.all([
      redis.incrby(k.stat(event), by),
      (async () => {
        const total = num(await redis.incrby(day, by));
        if (total === by) await redis.expire(day, DAILY_TTL_SEC);
      })(),
    ]);
  } catch (e) {
    console.error("stat failed", event, e);
  }
}
