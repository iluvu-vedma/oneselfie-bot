import { REPORT_TZ } from "./config";
import ru from "../locales/ru.json";

/**
 * Строки живут в locales/, в коде — только ключи.
 * Локаль одна: мультиязычность — фича, а фичи заморожены до первой оплаты.
 * Всё, что нужно второй локали, уже на месте: добавляется файл и строка в BUNDLES.
 */
export const LOCALE = "ru";

const BUNDLES: Record<string, unknown> = { ru };

/**
 * Ключи, которых не нашлось. Молча фолбэчиться нельзя, поэтому промах видно
 * трижды: в тексте (⟨key⟩), в логе и в `npm run screens`, который на непустом
 * множестве падает.
 */
export const missingKeys = new Set<string>();

function miss(key: string): string {
  missingKeys.add(key);
  console.error(`i18n: нет строки ${LOCALE}.${key}`);
  return `⟨${key}⟩`;
}

function lookup(key: string): unknown {
  let node: unknown = BUNDLES[LOCALE];
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export type Params = Record<string, string | number>;

/** Строка по ключу с подстановкой {name}. */
export function t(key: string, params?: Params): string {
  const value = lookup(key);
  if (typeof value !== "string") return miss(key);
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole
  );
}

const pluralRules = new Intl.PluralRules(LOCALE);
const numberFormat = new Intl.NumberFormat(LOCALE);

/**
 * «1 кадр» / «2 кадра» / «5 кадров».
 * Форму выбирает Intl по правилам локали, а не самодельный if (n === 1):
 * в следующей локали правила другие, а вызов остаётся тот же.
 */
export function plural(key: string, count: number): string {
  const forms = lookup(key);
  if (forms === null || typeof forms !== "object") return miss(key);
  const table = forms as Record<string, unknown>;
  const word = table[pluralRules.select(count)] ?? table.other;
  if (typeof word !== "string") return miss(`${key}.${pluralRules.select(count)}`);
  return `${num(count)} ${word}`;
}

/** Числа форматируются по локали, а не конкатенацией. */
export function num(value: number): string {
  return numberFormat.format(value);
}

/** Разделитель дробной части тоже локальный: «32,0%», а не «32.0%». */
const percentFormat = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Доля в процентах. Живёт здесь, а не рядом со статистикой, ровно по одной
 * причине: экраны админки считают проценты, а тянуть ради этого модуль,
 * который лезет в KV, им нельзя — экран обязан рисоваться без сети.
 *
 * Ноль в знаменателе даёт прочерк, а не «NaN%» и не «0%»: нечего делить —
 * значит, нечего и утверждать.
 */
export function pct(a: number, b: number): string {
  if (b <= 0) return "—";
  return `${percentFormat.format((a / b) * 100)}%`;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Всё, что пришло от пользователя, проходит через это перед parse_mode: "HTML". */
export function esc(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Дата и время в поясе отчётов. Нужны только админке: человеку время операции
 * не показывают нигде, а владельцу без него лог не разобрать.
 *
 * Пояс задан явно: Vercel считает в UTC, и «сегодня» на дашборде разъехалось бы
 * с «сегодня» в голове владельца ровно на три часа.
 */
const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
  timeZone: REPORT_TZ,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const DATE = new Intl.DateTimeFormat(LOCALE, {
  timeZone: REPORT_TZ,
  day: "2-digit",
  month: "2-digit",
});

/** «24.08, 15:15» */
export function when(at: number): string {
  return at > 0 ? DATE_TIME.format(at) : "—";
}

/** «24.08» */
export function day(at: number): string {
  return at > 0 ? DATE.format(at) : "—";
}

/** «+50» / «−50». Минус типографский: дефис в столбце чисел не читается. */
export function signed(value: number): string {
  return value < 0 ? `−${num(Math.abs(value))}` : `+${num(value)}`;
}
