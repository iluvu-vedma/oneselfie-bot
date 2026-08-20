import { Redis } from "@upstash/redis";

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
export const k = {
  /** Профиль: status, sceneIndex, fails, createdAt. Баланса тут НЕТ. */
  user: (chatId: number | string) => `user:${chatId}`,
  /**
   * Баланс искр отдельным ключом-числом.
   * Только INCRBY/DECRBY — «прочитал объект, изменил поле, записал» ломается
   * на двух быстрых тапах.
   */
  balance: (chatId: number | string) => `bal:${chatId}`,
  /** Список URL селфи после заливки в kie. */
  photos: (chatId: number | string) => `photos:${chatId}`,
  /** Счётчик занятых слотов под селфи. Резервируется до загрузки. */
  photoSlots: (chatId: number | string) => `photoslots:${chatId}`,
  /** Замок «кадр уже готовится». Один тап — один кадр. */
  genLock: (chatId: number | string) => `gen:${chatId}`,
  /** Задача генерации. */
  task: (taskId: string) => `task:${taskId}`,
  /** Отметка обработанного платежа, чтобы искры не зачислились дважды. */
  payment: (chargeId: string) => `pay:${chargeId}`,
  /** Индекс незавершённых задач для аварийного добора: score = createdAt (мс). */
  pending: "pending",
  /** Счётчик события. */
  stat: (event: string) => `stat:${event}`,
};

export function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Счётчики. Ошибка статистики не должна ронять сценарий. */
export async function bump(event: string, by = 1): Promise<void> {
  try {
    await redis.incrby(k.stat(event), by);
  } catch (e) {
    console.error("stat failed", event, e);
  }
}
