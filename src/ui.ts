import { InlineKeyboard } from "grammy";
import {
  CURRENCY_EMOJI,
  PACKAGES,
  PACKAGE_ORDER,
  SPARKS_PER_IMAGE,
} from "./config";
import { num, plural, t } from "./i18n";

// ── Валюта ───────────────────────────────────────────────────────────────────

/** «12 ✨» — значок по умолчанию. */
export function sparks(n: number): string {
  return `${num(n)} ${CURRENCY_EMOJI}`;
}

/** «12 искр ✨» — только там, где человек встречает валюту впервые. */
export function sparksNamed(n: number): string {
  return `${plural("unit.spark", n)} ${CURRENCY_EMOJI}`;
}

export function framesFor(sparksAmount: number): number {
  return Math.floor(sparksAmount / SPARKS_PER_IMAGE);
}

export function frames(n: number): string {
  return plural("unit.frame", n);
}

export function selfies(n: number): string {
  return plural("unit.selfie", n);
}

/** «180 ✨ · 15 кадров» — баланс всегда сразу в кадрах. */
export function balanceLine(balance: number): string {
  return `${sparks(balance)} · ${frames(framesFor(balance))}`;
}

/** Цена кадра и порог входа. Повторяется на каждом экране воронки. */
export function rateLine(): string {
  return t("common.rate", {
    price: sparks(SPARKS_PER_IMAGE),
    minStars: num(PACKAGES[PACKAGE_ORDER[0]].stars),
  });
}

export function balanceOf(balance: number): string {
  return t("common.balance", { balance: balanceLine(balance) });
}

// ── callback_data ────────────────────────────────────────────────────────────
/**
 * Схема «домен:действие:параметр», латиница, самый длинный — `pay:buy:probe`
 * (13 байт при лимите 64). В callback не кладётся ничего, что есть в KV.
 */
export const CB = {
  home: "nav:home",
  paywall: "nav:pay",
  generate: "act:gen",
  reset: "act:reset",
  buy: (id: string) => `pay:buy:${id}`,
  BUY_RE: /^pay:buy:(probe|set|big)$/,
} as const;

// ── Клавиатуры ───────────────────────────────────────────────────────────────
/**
 * Цвет — сигнал: ровно одно главное действие на экран.
 * На `ready` главное — снять кадр (primary), пополнение уходит в серые:
 * два цветных ряда схлопывают иерархию.
 */

export function homeStartKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("button.topupFirst", { stars: num(PACKAGES[PACKAGE_ORDER[0]].stars) }), CB.paywall)
    .success();
}

export function homeNeedKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("button.topup"), CB.paywall)
    .success()
    .row()
    .text(t("button.reset"), CB.reset);
}

export function homeReadyKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("button.generate", { price: sparks(SPARKS_PER_IMAGE) }), CB.generate)
    .primary()
    .row()
    .text(t("button.topup"), CB.paywall)
    .text(t("button.reset"), CB.reset);
}

/**
 * Пакеты по возрастанию, по одному в ряд. Порядок частей — «что получу → чем плачу».
 * Бонус на кнопку не пишется: `sparks` уже включает его, и «180 ✨ … +10 ✨»
 * читалось как 190. Про бонус говорит текст над кнопками.
 */
export function paywallKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const id of PACKAGE_ORDER) {
    const p = PACKAGES[id];
    kb.text(
      t("button.package", {
        frames: frames(framesFor(p.sparks)),
        sparks: sparks(p.sparks),
        stars: num(p.stars),
      }),
      CB.buy(p.id)
    )
      .success()
      .row();
  }
  return kb.text(t("button.back"), CB.home);
}
