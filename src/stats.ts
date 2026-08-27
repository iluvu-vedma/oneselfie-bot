import {
  CURRENCY_EMOJI,
  MODELS,
  MODEL_ORDER,
  MODEL_RESOLUTION,
  PACKS,
  PAY_METHODS,
  PAY_METHOD_ORDER,
  RETRY_OVERHEAD,
  STAR_PAYOUT_USD,
  USD_RUB,
  priceOf,
  sparksOf,
} from "./config";
import { pct } from "./i18n";
import { dayKey, k, num, redis } from "./kv";
import { modelName } from "./ui";

/** Счётчики строятся из тех же таблиц, что и экраны: список событий не разъедется. */
const EVENTS: string[] = [
  "start",
  "start_new",
  "photos_uploaded",
  "topup_shown",
  "topup_views",
  "gen_users",
  "paid_users",
  "frame_delivered",
  "gen_failed",
  "sparks_sold",
  "sparks_spent",
  "sparks_refunded",
  "sparks_granted",
  "sparks_taken",
  "stars_earned",
  ...MODEL_ORDER.map((id) => `gen_${id}`),
  ...PAY_METHOD_ORDER.flatMap((m) => PACKS.map((p) => `paid_${m}_${p.tier}`)),
];

export type Counters = Record<string, number>;

async function readCounters(keys: string[]): Promise<Counters> {
  const values = await redis.mget<unknown[]>(...keys);
  const out: Counters = {};
  EVENTS.forEach((e, i) => (out[e] = num(values?.[i])));
  return out;
}

/** Все счётчики за всё время. */
export async function totals(): Promise<Counters> {
  return readCounters(EVENTS.map((e) => k.stat(e)));
}

/** Все счётчики за один день пояса отчётов. */
export async function daily(day = dayKey()): Promise<Counters> {
  return readCounters(EVENTS.map((e) => k.statDay(e, day)));
}

// ── Дашборд ──────────────────────────────────────────────────────────────────

/**
 * Числа для экрана админки. Считаются здесь, а не в экране: экран умеет только
 * расставлять готовые числа по строкам, а вот «сколько нетто с одной звезды» —
 * это про экономику, и живёт оно рядом с остальной экономикой.
 *
 * Воронка меряется людьми, а не событиями: один человек с сорока кадрами не
 * должен выглядеть как сорок дошедших. Поэтому `gen_users` и `paid_users` —
 * подушевые отметки, а не счётчики запусков.
 */
export interface Dash {
  people: { start: number; photos: number; gen: number; paid: number };
  money: {
    stars: number;
    /** Нетто по звёздам, $. Ровно то, что доходит до владельца. */
    netto: number;
    /** То же в рублях по прикидочному курсу. */
    rub: number;
    /** Себестоимость запущенных кадров с накидкой на брак, $. */
    cost: number;
    sold: number;
    spent: number;
    refunded: number;
    granted: number;
    taken: number;
  };
  frames: { done: number; failed: number };
  today: { start: number; gen: number; paid: number; stars: number };
}

function costOf(s: Counters): number {
  // По фактическому раскладу моделей, а не по средней: кадр на Pro стоит вдвое
  // дороже кадра на GPT Image.
  return MODEL_ORDER.reduce(
    (sum, id) => sum + s[`gen_${id}`] * MODELS[id].costUsd * RETRY_OVERHEAD,
    0
  );
}

function paidEvents(s: Counters): number {
  return PAY_METHOD_ORDER.reduce(
    (sum, m) => sum + PACKS.reduce((n, p) => n + s[`paid_${m}_${p.tier}`], 0),
    0
  );
}

export async function buildDash(): Promise<Dash> {
  const [all, now] = await Promise.all([totals(), daily()]);
  const netto = all.stars_earned * STAR_PAYOUT_USD;

  return {
    people: {
      start: all.start_new,
      photos: all.photos_uploaded,
      gen: all.gen_users,
      paid: all.paid_users,
    },
    money: {
      stars: all.stars_earned,
      netto,
      rub: netto * USD_RUB,
      cost: costOf(all),
      sold: all.sparks_sold,
      spent: all.sparks_spent,
      refunded: all.sparks_refunded,
      granted: all.sparks_granted,
      taken: all.sparks_taken,
    },
    frames: { done: all.frame_delivered, failed: all.gen_failed },
    today: {
      start: now.start_new,
      gen: MODEL_ORDER.reduce((sum, id) => sum + now[`gen_${id}`], 0),
      paid: paidEvents(now),
      stars: now.stars_earned,
    },
  };
}

// ── /stats ───────────────────────────────────────────────────────────────────
/**
 * Полная выкладка одним сообщением. Осталась командой, а не экраном: тут нет
 * ни одного действия, зато есть всё сразу — и лимит в 4096 символов ей ближе,
 * чем любому экрану.
 */
export async function buildStats(): Promise<string> {
  const s = await totals();
  const paid = paidEvents(s);
  const lines: string[] = [];

  lines.push("<b>Воронка</b>");
  lines.push(`start: ${s.start} (новых: ${s.start_new})`);
  lines.push(`photos_uploaded: ${s.photos_uploaded} · ${pct(s.photos_uploaded, s.start_new)}`);
  lines.push(`gen_users: ${s.gen_users} · ${pct(s.gen_users, s.start_new)}`);
  lines.push(
    `topup_shown: ${s.topup_shown} · ${pct(s.topup_shown, s.start_new)}` +
      ` (показов всего: ${s.topup_views})`
  );
  lines.push(`paid: ${paid} · ${pct(paid, s.topup_shown)} (людей: ${s.paid_users})`);
  lines.push("");

  lines.push("<b>Модели</b>");
  for (const id of MODEL_ORDER) {
    const runs = s[`gen_${id}`];
    lines.push(`${modelName(id)}: ${runs} · ${MODELS[id].price} ${CURRENCY_EMOJI}/кадр`);
  }
  lines.push("");

  lines.push("<b>Пакеты</b>");
  for (const m of PAY_METHOD_ORDER) {
    const row = PACKS.map((p) => s[`paid_${m}_${p.tier}`]).join(" / ");
    const live = PAY_METHODS[m].live ? "" : " (выключен)";
    lines.push(`${m}${live}: ${row}`);
  }
  lines.push("");

  lines.push("<b>Искры</b>");
  lines.push(`Продано: ${s.sparks_sold} ${CURRENCY_EMOJI}`);
  lines.push(`Потрачено: ${s.sparks_spent} ${CURRENCY_EMOJI}`);
  lines.push(`Возвращено: ${s.sparks_refunded} ${CURRENCY_EMOJI}`);
  lines.push(
    `Начислено руками: ${s.sparks_granted} ${CURRENCY_EMOJI}` +
      ` (снято: ${s.sparks_taken} ${CURRENCY_EMOJI})`
  );
  lines.push(
    `<b>Выкуплено и потрачено: ${pct(s.sparks_spent, s.sparks_sold)}</b>` +
      (s.sparks_sold > 0 && s.sparks_spent / s.sparks_sold < 0.8
        ? " ← покупают и не тратят"
        : "")
  );
  lines.push("");

  lines.push("<b>Кадры</b>");
  lines.push(`Выдано: ${s.frame_delivered}`);
  lines.push(
    `Провалов: ${s.gen_failed} · ${pct(s.gen_failed, s.frame_delivered + s.gen_failed)}`
  );
  lines.push("");

  const cost = costOf(s);
  const netto = s.stars_earned * STAR_PAYOUT_USD;
  lines.push("<b>Деньги (оценка)</b>");
  lines.push(`Звёзд получено: ${s.stars_earned} ⭐`);
  lines.push(`Нетто по курсу ${STAR_PAYOUT_USD}: $${netto.toFixed(2)}`);
  lines.push(`Себестоимость запущенных кадров: $${cost.toFixed(2)}`);
  lines.push(`Доля себестоимости: ${pct(cost, netto)} (правило: не выше 50%)`);
  lines.push("");

  const worst = PACKS[PACKS.length - 1];
  lines.push(
    `<i>${MODEL_ORDER.length} модели · ${MODEL_RESOLUTION} · ` +
      `выплата за звезду $${STAR_PAYOUT_USD} · худший пакет ` +
      `${priceOf(worst, "stars")} ⭐ → ${sparksOf(worst, "stars")} ${CURRENCY_EMOJI}</i>`
  );

  return lines.join("\n");
}
