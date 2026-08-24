import { InlineKeyboard } from "grammy";
import { PACKAGES, PACKAGE_ORDER, SPARKS_PER_IMAGE } from "./config";
import { esc, t } from "./i18n";
import {
  balanceOf,
  homeNeedKeyboard,
  homeReadyKeyboard,
  homeStartKeyboard,
  paywallKeyboard,
  rateLine,
  selfies,
  sparks,
  sparksNamed,
} from "./ui";

/**
 * Экраны интерфейса. Не путать со `scenes.ts` — там сценарии для промпта,
 * их пользователь не видит.
 *
 * Каждый экран — чистая функция от состояния к `{ text, reply_markup }`.
 * Ничего не «дописывается сверху»: экран всегда собирается целиком, поэтому
 * его можно нарисовать в любой момент из одного лишь состояния.
 */
export interface Screen {
  text: string;
  reply_markup?: InlineKeyboard;
}

/** Пустая строка — единственный инструмент вертикального ритма. */
function compose(...blocks: (string | string[] | undefined | false)[]): string {
  return blocks
    .filter((b): b is string | string[] => Boolean(b))
    .map((b) => (Array.isArray(b) ? b.join("\n") : b))
    .join("\n\n");
}

// ── home ─────────────────────────────────────────────────────────────────────

export type HomeStage = "start" | "need" | "ready" | "busy";

export interface HomeState {
  stage: HomeStage;
  /** Искры на балансе. */
  balance: number;
  /** Сколько селфи загружено. */
  photos: number;
  /** Имя из Telegram. Персонализация только в приветствии — больше нигде. */
  name?: string;
  /** Разовая строка о том, что только что произошло: оплата, кадр, возврат. */
  notice?: string;
}

export function home(s: HomeState): Screen {
  switch (s.stage) {
    case "busy":
      return {
        text: compose(
          s.notice,
          [t("home.busy.title"), t("home.busy.body")],
          balanceOf(s.balance),
          t("home.busy.calm")
        ),
        // Кнопок нет намеренно: пока кадр готовится, нажимать нечего,
        // а двойной тап по «Сделать кадр» physически невозможен.
      };

    case "ready":
      return {
        text: compose(
          s.notice,
          [t("home.ready.title"), t("home.ready.body", { selfies: selfies(s.photos) })],
          [balanceOf(s.balance), rateLine()],
          t("home.ready.tip"),
          t("common.bridge")
        ),
        reply_markup: homeReadyKeyboard(),
      };

    case "need":
      return {
        text: compose(
          s.notice,
          [t("home.need.title"), t("home.need.body", { selfies: selfies(s.photos) })],
          [rateLine(), balanceOf(s.balance)],
          offerBlock(),
          t("common.bridge")
        ),
        reply_markup: homeNeedKeyboard(),
      };

    case "start":
      return {
        text: compose(
          s.notice,
          [t("home.start.hello", { name: esc(s.name ?? "") }), t("home.start.lead")],
          // Баланс появляется, только когда он есть: «0 ✨» на входе выглядит как долг.
          s.balance > 0 ? [rateLine(), balanceOf(s.balance)] : rateLine(),
          [t("home.start.photos.title"), t("home.start.photos.body")],
          [t("home.start.result.title"), t("home.start.result.body")],
          t("home.start.howto"),
          t("home.start.bridge")
        ),
        reply_markup: homeStartKeyboard(),
      };
  }
}

// ── paywall ──────────────────────────────────────────────────────────────────

export function paywall(balance: number): Screen {
  return {
    text: compose(
      [t("paywall.title"), t("paywall.lead", { priceNamed: sparksNamed(SPARKS_PER_IMAGE) })],
      balanceOf(balance),
      offerBlock(),
      t("paywall.objection"),
      t("paywall.bridge")
    ),
    reply_markup: paywallKeyboard(),
  };
}

/**
 * Оффер собирается из PACKAGES, а не пишется в локали руками:
 * поменяется состав пакетов — текст поедет за ним, а не соврёт.
 * Дублируется на каждом шаге воронки оплаты.
 */
function offerBlock(): string[] | undefined {
  const list = PACKAGE_ORDER.filter((id) => PACKAGES[id].bonus > 0)
    .map((id) =>
      t("paywall.offer.item", {
        title: PACKAGES[id].title,
        bonus: sparks(PACKAGES[id].bonus),
      })
    )
    .join(", ");
  if (!list) return undefined;
  return [t("paywall.offer.title"), t("paywall.offer.body", { list })];
}
