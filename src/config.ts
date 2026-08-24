/**
 * OneSelfie — единственный файл с константами.
 * Смена модели, курса, цен и пакетов правится ТОЛЬКО здесь.
 */

// ── Валюта ───────────────────────────────────────────────────────────────────
/** Название валюты. Запасные варианты: вспышки, люмены, блики. */
export const CURRENCY_NAME = "искры";
export const CURRENCY_EMOJI = "✨";
/** Склонения названия валюты: 1 искра / 2 искры / 5 искр. */
export const CURRENCY_FORMS: [string, string, string] = ["искра", "искры", "искр"];

/** Цена одного кадра. Единственная трата в MVP. */
export const SPARKS_PER_IMAGE = 12;

// ── Модель и себестоимость ───────────────────────────────────────────────────
/** id модели в kie. Компромисс цены и качества. */
export const MODEL = "nano-banana-2";
/** Разрешение: "1K" | "2K" | "4K". Понижение до 1K — рычаг на случай плохой выплаты. */
export const MODEL_RESOLUTION = "2K";
export const MODEL_ASPECT_RATIO = "3:4";
export const MODEL_OUTPUT_FORMAT = "jpg";

/** Прайс kie, колонка «Our Price». */
export const IMG_COST_USD = 0.06;
/** +10% на брак и повторы. */
export const RETRY_OVERHEAD = 1.1;
/** Сколько реально доходит до владельца с одной звезды. ПРОВЕРИТЬ НА ЖИВОЙ ВЫПЛАТЕ. */
export const STAR_PAYOUT_USD = 0.013;
/** Цена звезды для пользователя, ₽. Только для прикидок. */
export const STAR_PRICE_RUB = 1.99;
/** Только для прикидок. */
export const USD_RUB = 85;

// ── Пакеты ───────────────────────────────────────────────────────────────────
export type PackageId = "probe" | "set" | "big";

export interface SparkPackage {
  id: PackageId;
  /** Имя в счёте Telegram и в /stats. Считается кадрами: sparks / SPARKS_PER_IMAGE. */
  title: string;
  /** Сколько звёзд платит пользователь. */
  stars: number;
  /** Сколько искр зачисляется (включая бонус). Делится на SPARKS_PER_IMAGE нацело. */
  sparks: number;
  /** Бонусные искры, уже входят в sparks. На кнопке не пишутся — см. paywallKeyboard. */
  bonus: number;
}

export const PACKAGES: Record<PackageId, SparkPackage> = {
  probe: { id: "probe", title: "5 кадров", stars: 60, sparks: 60, bonus: 0 },
  set: { id: "set", title: "15 кадров", stars: 170, sparks: 180, bonus: 10 },
  big: { id: "big", title: "30 кадров", stars: 330, sparks: 360, bonus: 30 },
};

export const PACKAGE_ORDER: PackageId[] = ["probe", "set", "big"];

// ── Загрузка селфи ───────────────────────────────────────────────────────────
export const MIN_PHOTOS = 1;
export const MAX_PHOTOS = 4;

// ── Тайминги ─────────────────────────────────────────────────────────────────
/** Через сколько секунд аварийный крон начинает добирать результат через recordInfo. */
export const SWEEP_AFTER_SEC = 90;
/** Через сколько секунд генерация считается провалившейся и искры возвращаются. */
export const TIMEOUT_SEC = 5 * 60;
/** TTL записи задачи в KV. */
export const TASK_TTL_SEC = 60 * 60;
/** Блокировка от двойного тапа. Чуть больше таймаута, чтобы возврат успел снять её сам. */
export const GEN_LOCK_TTL_SEC = TIMEOUT_SEC + 60;
/**
 * Сколько живёт message_id экрана. Чуть меньше 48 часов — после этого срока
 * Telegram всё равно не даёт ни редактировать, ни удалять сообщение.
 */
export const HUB_TTL_SEC = 47 * 60 * 60;
/** Сколько неудач подряд, прежде чем бот сам предложит возврат денег. */
export const FAILS_BEFORE_ALERT = 3;

// ── Окружение ────────────────────────────────────────────────────────────────
export const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
export const KIE_API_KEY = process.env.KIE_API_KEY ?? "";
export const KIE_BASE_URL = process.env.KIE_BASE_URL ?? "https://api.kie.ai";
/** Публичный https-адрес деплоя, без слеша на конце. */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
/** Секрет для /api/kie-callback и /api/sweep. Без него эндпоинты открыты всему интернету. */
export const CALLBACK_SECRET = process.env.CALLBACK_SECRET ?? "";
/** Секрет вебхука Telegram (X-Telegram-Bot-Api-Secret-Token). */
export const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
export const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ?? "";
/** Картинка-пример: сетка реальных результатов. Если пусто — шаг 2 уходит текстом. */
export const EXAMPLE_IMAGE_URL = process.env.EXAMPLE_IMAGE_URL ?? "";

// ── Промпт ───────────────────────────────────────────────────────────────────
/**
 * Преамбула про сходство. Это самое хрупкое место продукта:
 * если Шаг 0 показал непохожесть — крутится в первую очередь она.
 */
export const PROMPT_PREFIX =
  "Photorealistic photograph of the exact person shown in the reference images. " +
  "Preserve their face, facial proportions, bone structure, eye shape and colour, " +
  "nose, lips, skin tone, skin texture and hairline with absolute fidelity — the result " +
  "must be unmistakably the same individual. Do not beautify, slim, de-age or stylise the face.";

export const PROMPT_SUFFIX =
  "Natural skin texture with visible pores, sharp focus on the eyes, 85mm lens, shallow depth of field, " +
  "professional colour grading. No text, no logo, no watermark, no extra people, no distorted hands.";
