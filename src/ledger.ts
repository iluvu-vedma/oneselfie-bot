import {
  FAILS_KEEP,
  GRANTS_KEEP,
  GrantReason,
  LEDGER_KEEP,
  ModelId,
  USER_FAILS_KEEP,
  isGrantReason,
  isModelId,
} from "./config";
import { k, num, redis } from "./kv";

/**
 * Журналы. Баланс — счётчик, и по нему не видно, откуда взялось число:
 * пока журнала нет, компенсировать зависший платёж можно только «на глаз».
 *
 * Три отдельных списка, а не один:
 *   — история операций человека нужна карточке;
 *   — общий лог сбоев отвечает на вопрос «кому вообще положена компенсация»;
 *   — лог ручных начислений отвечает на вопрос «кто и за что раздал искры».
 *
 * Все списки растут вверх (LPUSH) и подрезаются с хвоста: свежее сверху,
 * старое уезжает само. Это лог для разбора, а не бухгалтерия за всё время.
 */

// ── История операций ─────────────────────────────────────────────────────────

/**
 * `buy` — оплата, `spend` — кадр, `back` — автовозврат за сбой,
 * `grant` — ручное начисление, `take` — ручное списание.
 */
export type OpKind = "buy" | "spend" | "back" | "grant" | "take";

export interface Op {
  at: number;
  /** Со знаком: списание отрицательное. Иначе историю нельзя просто сложить. */
  delta: number;
  kind: OpKind;
  /** Подробность операции: рельс и пакет, модель, причина возврата, причина начисления. */
  ref: string;
  /** chat_id админа — только у ручных операций. */
  by?: number;
}

function isOpKind(v: unknown): v is OpKind {
  return v === "buy" || v === "spend" || v === "back" || v === "grant" || v === "take";
}

/**
 * Upstash разбирает JSON на чтении сам, заглушка в проверках — нет.
 * Поэтому строку и объект принимаем одинаково.
 */
function decode(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

async function push(key: string, entry: unknown, keep: number): Promise<void> {
  await redis.lpush(key, entry);
  await redis.ltrim(key, 0, keep - 1);
}

async function read(key: string, limit: number): Promise<unknown[]> {
  const list = await redis.lrange<unknown>(key, 0, limit - 1);
  return list ?? [];
}

/**
 * Запись операции. Ошибка журнала не должна ронять сценарий: деньги уже
 * двинулись, и падение здесь оставило бы человека без кадра и без искр.
 */
export async function record(
  chatId: number,
  kind: OpKind,
  delta: number,
  ref: string,
  by?: number
): Promise<void> {
  try {
    const op: Op = { at: Date.now(), delta, kind, ref, ...(by === undefined ? {} : { by }) };
    await push(k.ledger(chatId), op, LEDGER_KEEP);
  } catch (e) {
    console.error("ledger record failed", chatId, kind, e);
  }
}

export async function history(chatId: number, limit = LEDGER_KEEP): Promise<Op[]> {
  const rows = await read(k.ledger(chatId), limit);
  const ops: Op[] = [];
  for (const row of rows) {
    const o = decode(row);
    if (!o || !isOpKind(o.kind)) continue;
    ops.push({
      at: num(o.at),
      delta: num(o.delta),
      kind: o.kind,
      ref: o.ref === undefined || o.ref === null ? "" : String(o.ref),
      ...(o.by === undefined ? {} : { by: num(o.by) }),
    });
  }
  return ops;
}

/** Сколько всего операций сохранено. Карточка честно говорит, что показывает не всё. */
export async function historySize(chatId: number): Promise<number> {
  return num(await redis.llen(k.ledger(chatId)));
}

// ── Лог сбоев ────────────────────────────────────────────────────────────────

export interface Fail {
  at: number;
  chatId: number;
  model: ModelId | null;
  /** Сколько было списано. Столько же обычно и возвращено — но не всегда. */
  cost: number;
  /** Что именно случилось: таймаут, отказ модели, падение на старте. */
  reason: string;
  /** Ушёл ли автовозврат. false — человеку точно должны искры. */
  back: boolean;
}

/**
 * Сбой пишется дважды: в общий лог, по которому админ видит картину, и в личный,
 * по которому карточка показывает историю конкретного человека. Из общего он
 * вымоется через сотню событий, из личного — нет.
 */
export async function logFail(fail: Fail): Promise<void> {
  try {
    await push(k.fails, fail, FAILS_KEEP);
    await push(k.userFails(fail.chatId), fail, USER_FAILS_KEEP);
  } catch (e) {
    console.error("fail log failed", fail.chatId, e);
  }
}

function toFail(raw: unknown): Fail | null {
  const o = decode(raw);
  if (!o || o.chatId === undefined) return null;
  return {
    at: num(o.at),
    chatId: num(o.chatId),
    model: isModelId(o.model) ? o.model : null,
    cost: num(o.cost),
    reason: o.reason === undefined || o.reason === null ? "" : String(o.reason),
    back: o.back === true,
  };
}

export async function recentFails(limit: number): Promise<Fail[]> {
  return (await read(k.fails, limit)).map(toFail).filter((f): f is Fail => f !== null);
}

export async function failsOf(chatId: number, limit: number): Promise<Fail[]> {
  return (await read(k.userFails(chatId), limit))
    .map(toFail)
    .filter((f): f is Fail => f !== null);
}

// ── Лог ручных начислений ────────────────────────────────────────────────────

export interface Grant {
  at: number;
  /** Кто начислил. */
  admin: number;
  /** Кому. */
  chatId: number;
  /** Со знаком: списание отрицательное. */
  delta: number;
  reason: GrantReason;
  /** Баланс после операции — чтобы разбор не требовал догадок. */
  balance: number;
}

export async function logGrant(grant: Grant): Promise<void> {
  try {
    await push(k.grants, grant, GRANTS_KEEP);
  } catch (e) {
    console.error("grant log failed", grant.chatId, e);
  }
}

export async function recentGrants(limit: number): Promise<Grant[]> {
  const rows = await read(k.grants, limit);
  const grants: Grant[] = [];
  for (const row of rows) {
    const o = decode(row);
    if (!o || !isGrantReason(o.reason)) continue;
    grants.push({
      at: num(o.at),
      admin: num(o.admin),
      chatId: num(o.chatId),
      delta: num(o.delta),
      reason: o.reason,
      balance: num(o.balance),
    });
  }
  return grants;
}

/** Сколько сбоев лежит в общем логе. Дашборд рисует это число на кнопке. */
export async function failsCount(): Promise<number> {
  return num(await redis.llen(k.fails));
}
