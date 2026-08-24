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

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Всё, что пришло от пользователя, проходит через это перед parse_mode: "HTML". */
export function esc(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ESCAPES[ch]);
}
