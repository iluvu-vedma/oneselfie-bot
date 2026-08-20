/**
 * Самопроверка экономики и пейволла. Гоняется без сети и без KV.
 * Ловит ровно те пункты приёмки, которые можно проверить арифметикой.
 */
import {
  IMG_COST_USD,
  PACKAGES,
  PACKAGE_ORDER,
  RETRY_OVERHEAD,
  SPARKS_PER_IMAGE,
  STAR_PAYOUT_USD,
  STAR_PRICE_RUB,
  USD_RUB,
} from "../src/config";
import { SCENES } from "../src/scenes";
import { framesFor, paywallKeyboard } from "../src/ui";

let failed = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failed++;
}

const imgCost = IMG_COST_USD * RETRY_OVERHEAD;
console.log(`Себестоимость кадра: $${imgCost.toFixed(3)} (${(imgCost * USD_RUB).toFixed(1)} ₽)`);
const minStars = (2 * imgCost) / STAR_PAYOUT_USD;
console.log(`Минимум звёзд за кадр по правилу 50%: ${minStars.toFixed(1)}`);
check(SPARKS_PER_IMAGE >= minStars, `SPARKS_PER_IMAGE=${SPARKS_PER_IMAGE} не ниже минимума`);
check(SCENES.length === 30, `сценариев в пуле: ${SCENES.length}`);
console.log("");

console.log("Пакет        ⭐    ✨   кадров  ⭐/кадр   нетто   с/с    доля");
for (const id of PACKAGE_ORDER) {
  const p = PACKAGES[id];
  const frames = p.sparks / SPARKS_PER_IMAGE;
  const netto = p.stars * STAR_PAYOUT_USD;
  const cost = frames * imgCost;
  const share = cost / netto;
  console.log(
    `${p.title.padEnd(10)} ${String(p.stars).padStart(4)} ${String(p.sparks).padStart(5)} ` +
      `${String(frames).padStart(6)}  ${(p.stars / frames).toFixed(1).padStart(6)} ` +
      ` $${netto.toFixed(2)}  $${cost.toFixed(2)}  ${(share * 100).toFixed(0)}%` +
      `   (${(p.stars * STAR_PRICE_RUB).toFixed(0)} ₽ юзеру)`
  );
  check(Number.isInteger(frames), `${p.title}: ${p.sparks} ✨ делится на ${SPARKS_PER_IMAGE} нацело`);
  check(share <= 0.5, `${p.title}: себестоимость ${(share * 100).toFixed(0)}% ≤ 50%`);
  check(p.sparks === p.stars + p.bonus, `${p.title}: бонус сходится (${p.stars}+${p.bonus})`);
}
console.log("");

console.log("Кнопки пейволла:");
for (const row of paywallKeyboard().inline_keyboard) {
  for (const btn of row) {
    const text = (btn as { text: string }).text;
    console.log(`  ${text}`);
    check(/✨/.test(text) && /кадр/.test(text), "на кнопке есть и искры, и кадры");
  }
}
console.log("");

// Баланс после серии покупок и генераций — сходится на бумаге.
let balance = 0;
balance += PACKAGES.set.sparks;      // купил Сет
balance -= SPARKS_PER_IMAGE * 3;     // три кадра
balance += SPARKS_PER_IMAGE;         // один провалился, вернули
balance += PACKAGES.probe.sparks;    // докупил Пробу
check(balance === 180 - 36 + 12 + 60, `баланс сходится: ${balance} ✨ = ${framesFor(balance)} кадров`);

console.log(failed === 0 ? "\nВсё сошлось." : `\nПровалено проверок: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
