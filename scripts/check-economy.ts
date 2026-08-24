/**
 * Самопроверка экономики. Гоняется без сети и без KV.
 *
 * Здесь таблицы из docs/interface-v2.md §2б и §6 становятся исполняемыми:
 * если кто-то поправит цену модели, бонус пакета или курс — проверка скажет,
 * какое правило сломалось, а не оставит это на потом.
 */
import {
  ACQUIRING_FEE,
  CHEAPEST_MODEL,
  CRYPTO_FEE,
  DEAREST_MODEL,
  MIN_PRICE,
  MODELS,
  MODEL_ORDER,
  PACKS,
  PAY_METHODS,
  PAY_METHOD_ORDER,
  PRIMARY_MODEL,
  Pack,
  PayMethod,
  RETRY_OVERHEAD,
  SPARK_PRICE_RUB,
  STAR_PAYOUT_USD,
  STAR_PRICE_RUB,
  USD_RUB,
  bonusOf,
  priceOf,
  sparksOf,
} from "../src/config";

let failed = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failed++;
}

/** Сколько долларов реально доходит до владельца с одного пакета на этом рельсе. */
function netto(pack: Pack, method: PayMethod): number {
  const price = priceOf(pack, method);
  if (method === "stars") return price * STAR_PAYOUT_USD;
  if (method === "crypto") return price * (1 - CRYPTO_FEE);
  return (price / USD_RUB) * (1 - ACQUIRING_FEE);
}

/** Выручка в долларах за одну искру — то, из чего считается цена кадра. */
function perSpark(pack: Pack, method: PayMethod): number {
  return netto(pack, method) / sparksOf(pack, method);
}

// ── Рельсы ───────────────────────────────────────────────────────────────────

console.log("Нетто за 1 ✨ по рельсам и пакетам, $\n");
console.log("рельс     пакет 1   пакет 2   пакет 3   пакет 4    худший");
let worst = Infinity;
let worstWhere = "";
for (const m of PAY_METHOD_ORDER) {
  const row = PACKS.map((p) => perSpark(p, m));
  const low = Math.min(...row);
  if (low < worst) {
    worst = low;
    worstWhere = `${m}, пакет ${PACKS[row.indexOf(low)].tier}`;
  }
  const live = PAY_METHODS[m].live ? "" : "  (выключен)";
  console.log(
    `${m.padEnd(8)} ${row.map((v) => v.toFixed(5).padStart(9)).join(" ")}  ${low.toFixed(5)}${live}`
  );
}
console.log(`\nХудший случай: $${worst.toFixed(6)} за искру (${worstWhere})\n`);

check(
  worst === Math.min(...PACKS.map((p) => perSpark(p, "stars"))),
  "худший рельс — звёзды, под них и считается цена кадра"
);

// ── Модели ───────────────────────────────────────────────────────────────────

console.log("Модель            цена ✨   выручка   с/с      доля");
for (const id of MODEL_ORDER) {
  const info = MODELS[id];
  const revenue = info.price * worst;
  const cost = info.costUsd * RETRY_OVERHEAD;
  const share = cost / revenue;
  console.log(
    `${id.padEnd(8)} ${String(info.price).padStart(12)}   $${revenue.toFixed(4)}  ` +
      `$${cost.toFixed(4)}  ${(share * 100).toFixed(1)}%`
  );
  check(share <= 0.5, `${id}: доля себестоимости ${(share * 100).toFixed(1)}% не выше 50%`);
}
console.log("");

// Порядок на экране — по убыванию: дорогая первой работает якорем.
for (let i = 1; i < MODEL_ORDER.length; i++) {
  const prev = MODELS[MODEL_ORDER[i - 1]].price;
  const cur = MODELS[MODEL_ORDER[i]].price;
  check(prev > cur, `${MODEL_ORDER[i - 1]} дороже ${MODEL_ORDER[i]} (${prev} > ${cur})`);
}
check(MODELS[CHEAPEST_MODEL].price === MIN_PRICE, `«кадр от ${MIN_PRICE} ✨» — это ${CHEAPEST_MODEL}`);
check(
  MODELS[PRIMARY_MODEL].price < MODELS[DEAREST_MODEL].price,
  "синяя кнопка не на флагмане: первый кадр новичка не должен стоить дороже всех"
);
check(
  new Set(MODEL_ORDER.map((id) => MODELS[id].kieId)).size === MODEL_ORDER.length,
  "у каждой модели свой id в kie"
);
console.log("");

// ── Пакеты ───────────────────────────────────────────────────────────────────

console.log("Пакет   ₽      USDT   ⭐      база ✨  ₽/крипта ✨  звёзды ✨");
for (const p of PACKS) {
  console.log(
    `${String(p.tier).padEnd(7)} ${String(p.rub).padStart(6)} ${String(p.usdt).padStart(6)} ` +
      `${String(p.stars).padStart(6)} ${String(p.base).padStart(8)} ` +
      `${String(sparksOf(p, "sbp")).padStart(12)} ${String(sparksOf(p, "stars")).padStart(10)}`
  );
}
console.log("");

for (const p of PACKS) {
  check(p.base === p.stars, `пакет ${p.tier}: базовый размен 1 ✨ = 1 ⭐`);
  check(
    p.rub === Math.round(p.base * SPARK_PRICE_RUB),
    `пакет ${p.tier}: ${p.rub} ₽ = ${p.base} ✨ по курсу ${SPARK_PRICE_RUB} ₽`
  );
  check(p.bonusStars <= p.bonusFiat, `пакет ${p.tier}: бонус на звёздах не выше рублёвого`);
}
for (let i = 1; i < PACKS.length; i++) {
  check(PACKS[i].rub > PACKS[i - 1].rub, `пакет ${PACKS[i].tier} дороже предыдущего`);
  check(
    PACKS[i].bonusFiat >= PACKS[i - 1].bonusFiat,
    `пакет ${PACKS[i].tier}: бонус не убывает с размером`
  );
}
console.log("");

// ── Курс ─────────────────────────────────────────────────────────────────────
/** Рубли обязаны платить лучше звёзд — иначе худшим рельсом становятся они. */
const rubPerSpark = (SPARK_PRICE_RUB / USD_RUB) * (1 - ACQUIRING_FEE);
console.log(
  `Курс: 1 ✨ = ${SPARK_PRICE_RUB} ₽ = 1 ⭐ (${STAR_PRICE_RUB} ₽ для юзера)\n` +
    `Нетто за искру без бонуса: рубли $${rubPerSpark.toFixed(5)}, ` +
    `звёзды $${STAR_PAYOUT_USD.toFixed(5)}\n`
);
check(rubPerSpark > STAR_PAYOUT_USD, "рублёвый рельс платит лучше звёздного");

// Запас по ставке эквайринга: при какой она сравняется со звёздами.
const breakEven = 1 - (STAR_PAYOUT_USD * USD_RUB) / SPARK_PRICE_RUB;
console.log(
  `Эквайринг ломает курс при ставке выше ${(breakEven * 100).toFixed(0)}% ` +
    `(заложено ${(ACQUIRING_FEE * 100).toFixed(0)}%)\n`
);
check(breakEven > 0.2, "курс держится при любой реалистичной ставке эквайринга");

console.log(failed === 0 ? "Экономика сходится." : `Провалено проверок: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
