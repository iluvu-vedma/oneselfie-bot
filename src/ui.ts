import { InlineKeyboard } from "grammy";
import {
  CHANNEL_URL,
  CURRENCY_EMOJI,
  GRANT_REASONS,
  GrantReason,
  MODELS,
  MODEL_ORDER,
  MIN_PRICE,
  ModelId,
  PACKS,
  PAY_METHODS,
  PAY_METHOD_ORDER,
  PRIMARY_MODEL,
  PROMPTS_CHANNEL_URL,
  Pack,
  PayMethod,
  RECOMMENDED_METHOD,
  TAKE_REASON,
  bonusOf,
  isModelId,
  priceOf,
  sparksOf,
} from "./config";
import { num, plural, t } from "./i18n";

// ── Валюта и числа ───────────────────────────────────────────────────────────

/** «12 ✨» — значок по умолчанию. */
export function sparks(n: number): string {
  return `${num(n)} ${CURRENCY_EMOJI}`;
}

/** «12 искр ✨» — только там, где человек встречает валюту впервые. */
export function sparksNamed(n: number): string {
  return `${plural("unit.spark", n)} ${CURRENCY_EMOJI}`;
}

/** Сколько кадров этой моделью выйдет из такого количества искр. */
export function framesFor(sparksAmount: number, model: ModelId): number {
  return Math.floor(sparksAmount / MODELS[model].price);
}

export function frames(n: number): string {
  return plural("unit.frame", n);
}

export function selfies(n: number): string {
  return plural("unit.selfie", n);
}

export function tasks(n: number): string {
  return plural("unit.task", n);
}

/**
 * «42 секунды», «7 минут», «3 часа». Только для админки: человеку длительности
 * нигде не показывают.
 *
 * Единица выбирается по величине, а не пишется в вызове: время кадра меряется
 * секундами, возраст зависшей очереди — часами, и один и тот же экран обязан
 * прочитаться в обоих случаях. Ноль — прочерк, а не «0 секунд»: нечего мерить,
 * значит нечего и утверждать.
 */
export function dur(ms: number): string {
  if (ms <= 0) return t("common.none");
  if (ms < 60_000) return plural("unit.second", Math.max(1, Math.round(ms / 1000)));
  if (ms < 60 * 60_000) return plural("unit.minute", Math.round(ms / 60_000));
  return plural("unit.hour", Math.round(ms / (60 * 60_000)));
}

export function modelName(id: ModelId): string {
  return t(`model.${id}.name`);
}

/** «300 ₽», «200 ⭐», «4 USDT» — единица берётся из рельса, а не пишется руками. */
export function money(amount: number, method: PayMethod): string {
  return `${num(amount)} ${PAY_METHODS[method].unit}`;
}

// ── Сквозные строки ──────────────────────────────────────────────────────────
/**
 * Ключевой факт повторяется на каждом экране воронки: человек не должен помнить,
 * что он выбрал и сколько это стоит.
 */

/** «Кадр — от 10 ✨». Порог входа там, где модель ещё не выбрана. */
export function rateLine(): string {
  return t("common.rate", { price: sparks(MIN_PRICE) });
}

export function balanceOf(balance: number): string {
  return t("common.balance", { balance: sparks(balance) });
}

/** «Nano Banana 2 · кадр 12 ✨ · Баланс: 300 ✨» — модель, цена и баланс одной строкой. */
export function contextLine(model: ModelId, balance: number): string {
  return t("common.context", {
    model: modelName(model),
    price: sparks(MODELS[model].price),
    balance: sparks(balance),
  });
}

// ── callback_data ────────────────────────────────────────────────────────────
/**
 * Схема «домен:действие:параметр», латиница, самый длинный — `nav:model:nbpro`
 * (16 байт при лимите 64). Модель в `gen:*` не кладём: она уже в состоянии.
 *
 * Общего `nav:back` нет: цель «Назад» у каждого экрана своя, и кнопка несёт
 * адрес места назначения. Единственное, чего из адреса не видно, — откуда
 * человек пришёл в пополнение, поэтому источник едет прямо в `nav:topup:*`.
 */

/** Экраны, с которых можно уйти в пополнение и куда «Назад» обязано вернуть. */
export type Origin = "home" | "models" | ModelId;

const ORIGINS: string[] = ["home", "models", ...MODEL_ORDER];

export function isOrigin(v: unknown): v is Origin {
  return typeof v === "string" && ORIGINS.includes(v);
}

const ids = (list: readonly string[]) => `(${list.join("|")})`;

export const CB = {
  home: "nav:home",
  models: "nav:models",
  model: (id: ModelId) => `nav:model:${id}`,
  topup: (from: Origin) => `nav:topup:${from}`,
  help: "nav:help",
  earn: "nav:earn",
  genPhoto: "gen:photo",
  genText: "gen:text",
  genReset: "gen:reset",
  /** Показать присланные селфи альбомом. Модель в адрес не кладём: она в состоянии. */
  genPhotos: "gen:photos",
  pay: (m: PayMethod) => `pay:${m}`,
  buy: (m: PayMethod, tier: number) => `buy:${m}:${tier}`,

  MODEL_RE: new RegExp(`^nav:model:${ids(MODEL_ORDER)}$`),
  TOPUP_RE: new RegExp(`^nav:topup:${ids(ORIGINS)}$`),
  PAY_RE: new RegExp(`^pay:${ids(PAY_METHOD_ORDER)}$`),
  BUY_RE: new RegExp(`^buy:${ids(PAY_METHOD_ORDER)}:(\\d+)$`),
} as const;

/** callback_data экрана, который стоит за источником пополнения. */
export function originCb(from: Origin): string {
  if (from === "home") return CB.home;
  if (from === "models") return CB.models;
  return CB.model(from);
}

/** Хвост callback_data в payload счёта: `stars:3`. */
export function payloadOf(method: PayMethod, tier: number): string {
  return `${method}:${tier}`;
}

export function parsePayload(payload: string): { method: PayMethod; tier: number } | null {
  const m = /^([a-z]+):(\d+)$/.exec(payload);
  if (!m) return null;
  const method = m[1];
  if (!Object.prototype.hasOwnProperty.call(PAY_METHODS, method)) return null;
  return { method: method as PayMethod, tier: Number(m[2]) };
}

// ── Клавиатуры ───────────────────────────────────────────────────────────────
/**
 * Цвет — сигнал, а не украшение: одно главное действие на экран.
 * На экранах ввода (upload, prompt, describe) цветных нет вовсе — главное
 * действие там не кнопка, а сообщение, которое человек сейчас напишет.
 */

/** «Назад» — всегда последней строкой, отдельным рядом, всегда с одной иконкой. */
function back(kb: InlineKeyboard, to: string): InlineKeyboard {
  return kb.row().text(t("button.back"), to);
}

/** Внешняя ссылка рисуется только вместе с адресом. Значок ↗ клиент ставит сам. */
function urlRow(kb: InlineKeyboard, label: string, url: string): InlineKeyboard {
  return url ? kb.row().url(label, url) : kb;
}

export function homeKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t("button.create"), CB.models)
    .primary()
    .row()
    .text(t("button.topup"), CB.topup("home"))
    .success()
    .row()
    // Помощь и заработок равнозначны и второстепенны — поэтому парой в одном ряду.
    .text(t("button.earn"), CB.earn)
    .text(t("button.help"), CB.help);
  return urlRow(kb, t("button.channel"), CHANNEL_URL);
}

/**
 * Модели по убыванию цены. Те, на которые не хватает искр, не прячутся и не
 * переставляются: цена видна до нажатия, а дорогая наверху — это оффер.
 */
export function modelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const id of MODEL_ORDER) {
    kb.text(modelButton(id), CB.model(id));
    if (id === PRIMARY_MODEL) kb.primary();
    kb.row();
  }
  kb.text(t("button.topup"), CB.topup("models")).success();
  return back(kb, CB.home);
}

/** «🍌 Nano Banana Pro · 20 ✨» — собирается из реестра, а не пишется в локали. */
export function modelButton(id: ModelId): string {
  return t("button.model", {
    icon: MODELS[id].icon,
    name: modelName(id),
    price: sparks(MODELS[id].price),
  });
}

export function modelKeyboard(id: ModelId, needTopup: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (MODELS[id].photo) kb.text(t("button.photo"), CB.genPhoto).primary().row();
  kb.text(t("button.text"), CB.genText);
  if (!MODELS[id].photo) kb.primary();
  // Пополнение показывается, только когда искр не хватает: иначе оно отвлекает
  // от главного действия экрана.
  if (needTopup) kb.row().text(t("button.topup"), CB.topup(id)).success();
  urlRow(kb, t("button.prompts"), PROMPTS_CHANNEL_URL);
  return back(kb, CB.models);
}

export function uploadKeyboard(id: ModelId): InlineKeyboard {
  const kb = new InlineKeyboard().text(t("button.text"), CB.genText);
  return back(kb, CB.model(id));
}

/**
 * «Показать» и «Заменить» — пара равнозначных второстепенных действий, поэтому
 * они в одном ряду. Лейблы короткие нарочно: что именно показать и заменить,
 * сказано заголовком экрана («Принял 2 селфи»), и повторять это на кнопке
 * значит разорвать ряд переносом на узком экране.
 */
export function promptKeyboard(id: ModelId): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t("button.showPhotos"), CB.genPhotos)
    .text(t("button.replacePhoto"), CB.genReset);
  urlRow(kb, t("button.prompts"), PROMPTS_CHANNEL_URL);
  return back(kb, CB.model(id));
}

/**
 * Зеркальная кнопка «моё фото» тут не из карты: без неё на экране остаются
 * ссылка и «Назад», а при пустом PROMPTS_CHANNEL_URL — одно только «Назад».
 * Экран, единственная кнопка которого «Назад», запрещён.
 */
export function describeKeyboard(id: ModelId): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (MODELS[id].photo) kb.text(t("button.photo"), CB.genPhoto);
  urlRow(kb, t("button.prompts"), PROMPTS_CHANNEL_URL);
  return back(kb, CB.model(id));
}

/**
 * Зелёная одна, и это первый живой рельс. Мёртвые рельсы остаются на экране
 * серыми и отдают тост «скоро»: спрятать их — значит скрыть, что способ будет.
 */
export function topupKeyboard(from: Origin): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of PAY_METHOD_ORDER) {
    kb.text(t(`button.pay.${m}`), CB.pay(m));
    if (m === RECOMMENDED_METHOD) kb.success();
    kb.row();
  }
  return kb.text(t("button.back"), originCb(from));
}

/** Суммы по возрастанию, по одной в ряд. Скидка видна бейджем на самой кнопке. */
export function packsKeyboard(method: PayMethod, from: Origin): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const pack of PACKS) {
    kb.text(packButton(pack, method), CB.buy(method, pack.tier)).success().row();
  }
  return kb.text(t("button.back"), CB.topup(from));
}

/** «3000 ₽ · 2400 ✨ · +20%» — бейдж скидки только там, где она есть. */
export function packButton(pack: Pack, method: PayMethod): string {
  const bonus = bonusOf(pack, method);
  const key = bonus > 0 ? "button.pack.bonus" : "button.pack.plain";
  return t(key, {
    price: money(priceOf(pack, method), method),
    sparks: sparks(sparksOf(pack, method)),
    bonus: num(bonus),
  });
}

/** Из справки выход только вперёд, в целевое действие: экран с одним «Назад» — тупик. */
export function helpKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard().text(t("button.create"), CB.models).primary();
  return back(kb, CB.home);
}

export function earnKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard().text(t("button.create"), CB.models).primary();
  return back(kb, CB.home);
}

/** Источник пополнения из состояния. Мусор в KV не должен ронять «Назад». */
export function originOf(raw: string): Origin {
  if (isOrigin(raw)) return raw;
  return isModelId(raw) ? raw : "home";
}

// ── callback_data админки ────────────────────────────────────────────────────
/**
 * Отдельный префикс `adm:` — по нему роутер отсекает служебные адреса от
 * пользовательских одним взглядом, а не разбором каждого имени.
 *
 * Кого именно правим, едет прямо в адресе кнопки, а не берётся из состояния.
 * Это единственное исключение из правила «в callback только то, чего нет в
 * сессии», и оно про деньги: админ мог открыть карточку в другом чате или
 * нажать кнопку на экране, который уже уехал вверх, — сумма обязана уйти тому,
 * чьё имя он видел на этом экране.
 *
 * Самый длинный адрес — `adm:g:1234567890:bonus:10000`, 29 байт при лимите 64.
 */
const REASONS = `(${[...GRANT_REASONS, TAKE_REASON].join("|")})`;

export const ACB = {
  home: "adm:home",
  fails: "adm:fails",
  users: "adm:users",
  find: "adm:find",
  /** Очередь, скорость и отказы прямо сейчас. */
  health: "adm:health",
  /** Карточка человека. */
  card: (id: number) => `adm:u:${id}`,
  /** Селфи человека альбомом: разбор жалобы «кадр не похож» начинается с них. */
  photos: (id: number) => `adm:p:${id}`,
  /** За что начисляем. */
  reason: (id: number) => `adm:r:${id}`,
  /** Сколько. */
  amount: (id: number, reason: GrantReason) => `adm:s:${id}:${reason}`,
  /** Своя сумма: дальше ждём число сообщением. */
  custom: (id: number, reason: GrantReason) => `adm:c:${id}:${reason}`,
  /** Единственная кнопка, которая двигает баланс. */
  apply: (id: number, reason: GrantReason, amount: number) =>
    `adm:g:${id}:${reason}:${amount}`,

  CARD_RE: /^adm:u:(\d+)$/,
  PHOTOS_RE: /^adm:p:(\d+)$/,
  REASON_RE: /^adm:r:(\d+)$/,
  AMOUNT_RE: new RegExp(`^adm:s:(\\d+):${REASONS}$`),
  CUSTOM_RE: new RegExp(`^adm:c:(\\d+):${REASONS}$`),
  APPLY_RE: new RegExp(`^adm:g:(\\d+):${REASONS}:(\\d+)$`),
} as const;

/** «@slavafan» или «id 483920112» — человек без юзернейма тоже должен быть назван. */
export function personName(username: string, chatId: number): string {
  return username ? `@${username}` : t("admin.idOnly", { id: String(chatId) });
}
