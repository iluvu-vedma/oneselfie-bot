import {
  IMG_COST_USD,
  MODEL,
  MODEL_RESOLUTION,
  PACKAGES,
  PACKAGE_ORDER,
  RETRY_OVERHEAD,
  SPARKS_PER_IMAGE,
  STAR_PAYOUT_USD,
} from "./config";
import { CURRENCY_EMOJI } from "./config";
import { k, num, redis } from "./kv";

const EVENTS = [
  "start",
  "start_new",
  "photos_uploaded",
  "paywall_shown",
  "paywall_views",
  "paid_probe",
  "paid_set",
  "paid_big",
  "frame_delivered",
  "gen_failed",
  "sparks_sold",
  "sparks_spent",
  "sparks_refunded",
  "stars_earned",
] as const;

type Event = (typeof EVENTS)[number];

function pct(a: number, b: number): string {
  if (b <= 0) return "—";
  return `${((a / b) * 100).toFixed(1)}%`;
}

export async function buildStats(): Promise<string> {
  const values = await redis.mget<unknown[]>(...EVENTS.map((e) => k.stat(e)));
  const s = {} as Record<Event, number>;
  EVENTS.forEach((e, i) => (s[e] = num(values?.[i])));

  const paid = s.paid_probe + s.paid_set + s.paid_big;
  const stars = s.stars_earned;

  const lines: string[] = [];

  lines.push("<b>Воронка</b>");
  lines.push(`start: ${s.start} (новых: ${s.start_new})`);
  lines.push(`photos_uploaded: ${s.photos_uploaded} · ${pct(s.photos_uploaded, s.start_new)}`);
  lines.push(
    `paywall_shown: ${s.paywall_shown} · ${pct(s.paywall_shown, s.photos_uploaded)}` +
      ` (показов всего: ${s.paywall_views})`
  );
  lines.push(`paid: ${paid} · ${pct(paid, s.paywall_shown)}`);
  lines.push("");

  lines.push("<b>Пакеты</b>");
  for (const id of PACKAGE_ORDER) {
    const p = PACKAGES[id];
    const count = s[`paid_${id}` as Event];
    lines.push(`${p.title} (${p.stars} ⭐): ${count}`);
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
  lines.push(`Провалов: ${s.gen_failed} · ${pct(s.gen_failed, s.frame_delivered + s.gen_failed)}`);
  lines.push("");

  const cost = s.frame_delivered * IMG_COST_USD * RETRY_OVERHEAD;
  const netto = stars * STAR_PAYOUT_USD;
  lines.push("<b>Деньги (оценка)</b>");
  lines.push(`Звёзд получено: ${stars} ⭐`);
  lines.push(`Нетто по курсу ${STAR_PAYOUT_USD}: $${netto.toFixed(2)}`);
  lines.push(`Себестоимость выданных кадров: $${cost.toFixed(2)}`);
  lines.push(`Доля себестоимости: ${pct(cost, netto)} (правило: не выше 50%)`);
  lines.push("");
  lines.push(
    `<i>${MODEL} ${MODEL_RESOLUTION} · ${SPARKS_PER_IMAGE} ${CURRENCY_EMOJI}/кадр · ` +
      `выплата за звезду $${STAR_PAYOUT_USD}</i>`
  );

  return lines.join("\n");
}
