import {
  CAPTION_LIMIT,
  MAX_PROMPT_LEN,
  MIN_PROMPT_LEN,
  PROMPT_PREFIX,
  PROMPT_SUFFIX,
} from "./config";

/**
 * Промпт теперь пишет человек, а не бот. Здесь всё, что с ним делается по дороге
 * от сообщения до подписи под кадром.
 */

/** Приводит присланный текст к одной строке без лишних пробелов. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type PromptCheck = "ok" | "short" | "long";

export function check(text: string): PromptCheck {
  if (text.length < MIN_PROMPT_LEN) return "short";
  if (text.length > MAX_PROMPT_LEN) return "long";
  return "ok";
}

/**
 * Преамбула про сходство приклеивается только когда есть референс-фото:
 * в режиме «словами» лица нет и держать нечего, а лишние требования к коже
 * и глазам портят кадр, в котором человека может не быть вовсе.
 */
export function buildPrompt(text: string, hasPhotos: boolean): string {
  return hasPhotos ? `${PROMPT_PREFIX} ${text} ${PROMPT_SUFFIX}` : text;
}

export interface Caption {
  /** Что уходит в подпись под кадром — не длиннее лимита Telegram. */
  head: string;
  /** Хвост, если промпт не поместился. Уезжает вторым сообщением. */
  tail: string;
}

/**
 * Подпись — 1024 символа вместе с тегами. Промпт длиннее режем по границе слова,
 * а полный текст отдаём отдельно: подпись под кадром нужна, чтобы его повторить,
 * и обрубок на полуслове эту работу не делает.
 *
 * На вход идёт УЖЕ экранированный текст: резать до escape нельзя — `&amp;`
 * распухает вчетверо и обрубок вылезает за лимит. Пробелов внутри HTML-сущностей
 * не бывает, поэтому рез по пробелу их не рвёт; аварийный рез по счётчику может,
 * и хвост недописанной сущности снимается отдельно.
 */
export function splitCaption(escaped: string, limit = CAPTION_LIMIT): Caption {
  if (escaped.length <= limit) return { head: escaped, tail: "" };

  const room = limit - 1; // место под «…»
  const space = escaped.lastIndexOf(" ", room);
  const at = space > room / 2 ? space : room;
  const head = escaped.slice(0, at).replace(/&[a-z]*$/i, "").trimEnd();
  return { head: `${head}…`, tail: escaped };
}
