import { InlineKeyboard } from "grammy";
import {
  CURRENCY_EMOJI,
  CURRENCY_FORMS,
  MAX_PHOTOS,
  PACKAGES,
  PACKAGE_ORDER,
  SPARKS_PER_IMAGE,
} from "./config";

// ── Числа словами ────────────────────────────────────────────────────────────
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/** Валюта в интерфейсе всегда с эмодзи. */
export function sparks(n: number): string {
  return `${n} ${CURRENCY_EMOJI}`;
}

/** «12 искр ✨» — там, где валюту нужно назвать словом, а не одним значком. */
export function sparksNamed(n: number): string {
  return `${n} ${plural(n, CURRENCY_FORMS)} ${CURRENCY_EMOJI}`;
}

export function framesFor(sparksAmount: number): number {
  return Math.floor(sparksAmount / SPARKS_PER_IMAGE);
}

export function frames(n: number): string {
  return `${n} ${plural(n, ["кадр", "кадра", "кадров"])}`;
}

/** «180 ✨ · 15 кадров» — баланс всегда показывается сразу в кадрах. */
export function balanceLine(balance: number): string {
  return `${sparks(balance)} · ${frames(framesFor(balance))}`;
}

// ── Кнопки ───────────────────────────────────────────────────────────────────
export const CB = {
  begin: "begin",
  photosDone: "photos_done",
  generate: "gen",
  buy: (id: string) => `buy:${id}`,
  newPhotos: "new_photos",
} as const;

export const beginKeyboard = () => new InlineKeyboard().text("Начать", CB.begin);

export const doneKeyboard = () => new InlineKeyboard().text("Готово", CB.photosDone);

export const generateKeyboard = () =>
  new InlineKeyboard().text(
    `Сделать кадр — ${sparks(SPARKS_PER_IMAGE)}`,
    CB.generate
  );

/**
 * Пейволл. Порядок частей — «что получу → чем плачу»: решение принимается
 * по кадрам и звёздам, искры между ними служебные. Про бонус говорит текст
 * над кнопками: на кнопке «+10 ✨ в подарок» читалось как 190 вместо 180.
 */
export function paywallKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  PACKAGE_ORDER.forEach((id, i) => {
    const p = PACKAGES[id];
    const parts = [
      frames(framesFor(p.sparks)),
      sparks(p.sparks),
      `${p.stars} ⭐`,
    ];
    kb.text(parts.join(" · "), CB.buy(p.id));
    if (i < PACKAGE_ORDER.length - 1) kb.row();
  });
  return kb;
}

// ── Тексты ───────────────────────────────────────────────────────────────────
export const T = {
  /** Шаг 2. Про искры здесь ни слова — валюта появляется только на пейволле. */
  intro:
    "Пришлите свои селфи — сделаю из них фотосессию: студия, улица, вечерний город." +
    "\nПридумывать описания не нужно, сцену выбираю сам.",

  askPhotos:
    `Пришлите от одного до четырёх селфи: лицо крупно, разные ракурсы, ` +
    `без очков и головного убора.\nЧем больше селфи — тем точнее сходство.`,

  photoAccepted: (n: number) => `${n} из ${MAX_PHOTOS} ✓`,

  photoEnough: "Четырёх селфи достаточно. Если хотите заменить их — /new",

  photoFailed: "Не получилось принять это фото. Пришлите ещё раз.",

  notAPhoto: "Жду селфи фотографией — файл и текст не подойдут.",

  needPhotosFirst: "Сначала пришлите селфи.",

  paywall:
    `Один кадр — ${sparksNamed(SPARKS_PER_IMAGE)}. Искры покупаются за звёзды Telegram ⭐.` +
    `\nЧем больше пакет, тем больше искр за звезду.`,

  /** Считаем недостачу, а не остаток: «у вас 0 ✨» выглядит как сбой,
   *  а рядом с балансом в подписи под кадром остаток повторялся дважды. */
  notEnough: (balance: number) =>
    `До кадра не хватает ${sparks(SPARKS_PER_IMAGE - balance)}. Выберите пакет:`,

  paid: (added: number, balance: number) =>
    `Оплата прошла, +${sparks(added)}. Баланс: ${balanceLine(balance)}`,

  balance: (balance: number) => `Баланс: ${balanceLine(balance)}`,

  ready: (balance: number) => `Баланс: ${balanceLine(balance)}`,

  generating: "Готовлю кадр, 30–60 секунд.",

  alreadyGenerating: "Кадр уже готовится",

  refunded: (cost: number) =>
    `Кадр не получился — вернул ${sparks(cost)} на баланс. Попробуйте ещё раз, кадр будет другой.`,

  repeatedFails:
    "Кадры не получаются несколько раз подряд. Искры вернул на баланс — " +
    "напишите сюда, верну звёзды и разберусь.",

  photosReset:
    "Убрал старые селфи, искры остались на балансе. Пришлите новые — от одного до четырёх.",

  invoiceTitle: (title: string) => `OneSelfie · ${title}`,
  invoiceDescription: (sparksAmount: number) =>
    `${sparksNamed(sparksAmount)} на баланс. Один кадр — ${sparks(SPARKS_PER_IMAGE)}.`,
};
