import {
  MAX_PROMPT_LEN,
  MIN_PROMPT_LEN,
  PROMPT_PREFIX,
  PROMPT_SUFFIX,
  TEXT_LIMIT,
} from "./config";

/**
 * Промпт теперь пишет человек, а не бот. Здесь всё, что с ним делается по дороге
 * от сообщения до описания под кадром.
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

/**
 * Описание кадра уходит отдельным сообщением. Промпт человека короче лимита
 * всегда, но escape раздувает его на «&» и «<», поэтому рез всё-таки нужен.
 * Режем по границе слова: описание существует, чтобы кадр повторили, и обрубок
 * на полуслове эту работу не делает.
 *
 * На вход идёт УЖЕ экранированный текст: резать до escape нельзя — «&amp;»
 * распухает вчетверо и обрубок вылезает за лимит. Пробелов внутри HTML-сущностей
 * не бывает, поэтому рез по пробелу их не рвёт; аварийный рез по счётчику может,
 * и хвост недописанной сущности снимается отдельно.
 */
export function clip(escaped: string, limit = TEXT_LIMIT): string {
  if (escaped.length <= limit) return escaped;

  const room = limit - 1; // место под «…»
  const space = escaped.lastIndexOf(" ", room);
  const at = space > room / 2 ? space : room;
  return `${escaped.slice(0, at).replace(/&[a-z]*$/i, "").trimEnd()}…`;
}
