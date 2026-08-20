import { InlineKeyboard } from "grammy";
import {
  CURRENCY_EMOJI,
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
 * Пейволл. На каждой кнопке и искры, и кадры: валюта добавляет шаг пересчёта
 * в голове, и без «это 15 кадров» часть людей отваливается прямо здесь.
 */
export function paywallKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  PACKAGE_ORDER.forEach((id, i) => {
    const p = PACKAGES[id];
    const parts = [
      p.title,
      sparks(p.sparks),
      `${p.stars} ⭐`,
      `это ${frames(framesFor(p.sparks))}`,
    ];
    if (p.bonus > 0) parts.push(`+${sparks(p.bonus)} в подарок`);
    kb.text(parts.join(" · "), CB.buy(p.id));
    if (i < PACKAGE_ORDER.length - 1) kb.row();
  });
  return kb;
}

// ── Тексты ───────────────────────────────────────────────────────────────────
export const T = {
  /** Шаг 2. Про искры здесь ни слова — валюта появляется только на пейволле. */
  intro:
    "Ваши фотографии из ваших селфи.\nОписывать ничего не нужно.",

  askPhotos:
    `Пришлите от одного до четырёх селфи: лицо крупно, разные ракурсы, ` +
    `без очков и головного убора.\nЧем больше кадров — тем точнее сходство.`,

  photoAccepted: (n: number) => `${n} из ${MAX_PHOTOS} ✓`,

  photoEnough: "Уже достаточно",

  photoFailed: "Не получилось принять это фото. Пришлите ещё раз.",

  notAPhoto: "Нужно именно фото, не файл и не текст.",

  needPhotosFirst: "Сначала пришлите селфи.",

  paywall: `Один кадр стоит ${sparks(SPARKS_PER_IMAGE)}.`,

  notEnough: (balance: number) =>
    `На кадр нужно ${sparks(SPARKS_PER_IMAGE)}, у вас ${sparks(balance)}. Пополнить?`,

  paid: (added: number, balance: number) =>
    `+${sparks(added)}. Баланс: ${sparks(balance)} — это ${frames(framesFor(balance))}.`,

  balance: (balance: number) =>
    `${sparks(balance)} — это ${frames(framesFor(balance))}.`,

  ready: (balance: number) => `Баланс: ${balanceLine(balance)}`,

  generating: "Готовлю кадр, 30–60 секунд.",

  alreadyGenerating: "Кадр уже готовится",

  refunded: (cost: number) => `Кадр не получился, вернул ${sparks(cost)}.`,

  repeatedFails: "Что-то пошло не так, вернём деньги. Напишите сюда — разберёмся руками.",

  photosReset:
    "Старые селфи убрал. Пришлите новые — от одного до четырёх.",

  invoiceTitle: (title: string) => `${title}`,
  invoiceDescription: (sparksAmount: number) =>
    `${sparks(sparksAmount)} — это ${frames(framesFor(sparksAmount))}.`,
};
