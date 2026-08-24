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
  priceOf,
  sparksOf,
} from "./config";
import { k, num, redis } from "./kv";
import { modelName } from "./ui";

/** Счётчики строятся из тех же таблиц, что и экраны: список событий не разъедется. */
const EVENTS: string[] = [
  "start",
  "start_new",
  "photos_uploaded",
  "topup_shown",
  "topup_views",
  "frame_delivered",
  "gen_failed",
  "sparks_sold",
  "sparks_spent",
  "sparks_refunded",
  "stars_earned",
  ...MODEL_ORDER.map((id) => `gen_${id}`),
  ...PAY_METHOD_ORDER.flatMap((m) => PACKS.map((p) => `paid_${m}_${p.tier}`)),
];

function pct(a: number, b: number): string {
  if (b <= 0) return "—";
  return `${((a / b) * 100).toFixed(1)}%`;
}

export async function buildStats(): Promise<string> {
  const values = await redis.mget<unknown[]>(...EVENTS.map((e) => k.stat(e)));
  const s: Record<string, number> = {};
  EVENTS.forEach((e, i) => (s[e] = num(values?.[i])));

  const paid = PAY_METHOD_ORDER.reduce(
    (sum, m) => sum + PACKS.reduce((n, p) => n + s[`paid_${m}_${p.tier}`], 0),
    0
  );
  const lines: string[] = [];

  lines.push("<b>Воронка</b>");
  lines.push(`start: ${s.start} (новых: ${s.start_new})`);
  lines.push(`photos_uploaded: ${s.photos_uploaded} · ${pct(s.photos_uploaded, s.start_new)}`);
  lines.push(
    `topup_shown: ${s.topup_shown} · ${pct(s.topup_shown, s.start_new)}` +
      ` (показов всего: ${s.topup_views})`
  );
  lines.push(`paid: ${paid} · ${pct(paid, s.topup_shown)}`);
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

  // Себестоимость считается по фактическому раскладу моделей, а не по средней:
  // кадр на Pro стоит вдвое дороже кадра на GPT Image.
  const cost = MODEL_ORDER.reduce(
    (sum, id) => sum + s[`gen_${id}`] * MODELS[id].costUsd * RETRY_OVERHEAD,
    0
  );
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
