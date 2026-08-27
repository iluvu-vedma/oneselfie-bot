/**
 * OneSelfie — единственный файл с константами.
 * Модели, курс, цены и пакеты правятся ТОЛЬКО здесь.
 * Экраны собираются из этих таблиц, руками список нигде не дублируется.
 */

// ── Валюта ───────────────────────────────────────────────────────────────────
/** Значок валюты. Склонения живут в locales/ru.json, ключ `unit.spark`. */
export const CURRENCY_EMOJI = "✨";

// ── Модели ───────────────────────────────────────────────────────────────────
export type ModelId = "nbpro" | "sd5" | "nb2" | "gpt2";

/**
 * Семейство API. У каждого вендора своя схема `input` — общей нет:
 * nano-banana берёт `image_input` + `resolution`, seedream — `image_urls` +
 * `quality`, gpt-image — `input_urls` и без `output_format`. Сборка живёт
 * в `kie.ts`, здесь только имя семейства.
 */
export type ModelFamily = "nano" | "seedream" | "gpt";

export interface ModelInfo {
  id: ModelId;
  family: ModelFamily;
  /**
   * Слаг для кадра по описанию словами. Слаги сверены запросом к kie 27.08.2026:
   * `seedream-5-pro` и `gpt-image-2` не существуют вовсе, у них раздельные
   * эндпоинты на текст и на фото. Проверить слаг можно бесплатно —
   * createTask с `input: {}`: живая модель ответит «prompt is required»,
   * мёртвая — 422 «model name not supported».
   */
  kieText: string;
  /**
   * Слаг для кадра по фото. У nano-banana он совпадает с текстовым: там
   * референсы — необязательное поле одной и той же модели. У seedream и
   * gpt-image это отдельные модели, и слаг обязан меняться вместе с режимом.
   */
  kiePhoto: string;
  icon: string;
  /** Цена кадра в искрах. Лестница 10-12-15-20 посчитана в docs/interface-v2.md §2б. */
  price: number;
  /** Прайс kie за кадр 2K, $. Нужен только check-economy и /stats. */
  costUsd: number;
  /** Принимает ли референс-фото. false — кнопка «Использовать моё фото» не рисуется. */
  photo: boolean;
}

export const MODELS: Record<ModelId, ModelInfo> = {
  nbpro: {
    id: "nbpro",
    family: "nano",
    kieText: "nano-banana-pro",
    kiePhoto: "nano-banana-pro",
    icon: "🍌",
    price: 20,
    costUsd: 0.09,
    photo: true,
  },
  sd5: {
    id: "sd5",
    family: "seedream",
    kieText: "seedream/5-pro-text-to-image",
    kiePhoto: "seedream/5-pro-image-to-image",
    icon: "🌱",
    price: 15,
    costUsd: 0.07,
    photo: true,
  },
  nb2: {
    id: "nb2",
    family: "nano",
    kieText: "nano-banana-2",
    kiePhoto: "nano-banana-2",
    icon: "🍌",
    price: 12,
    costUsd: 0.06,
    photo: true,
  },
  gpt2: {
    id: "gpt2",
    family: "gpt",
    kieText: "gpt-image-2-text-to-image",
    kiePhoto: "gpt-image-2-image-to-image",
    icon: "🧠",
    price: 10,
    costUsd: 0.05,
    photo: true,
  },
};

/**
 * Порядок на экране — по убыванию цены. Это не список сумм (там «по возрастанию»),
 * а выбор инструмента: дорогая первой работает якорем, остальные читаются
 * как «а можно и дешевле».
 */
export const MODEL_ORDER: ModelId[] = ["nbpro", "sd5", "nb2", "gpt2"];

/**
 * Синяя кнопка на экране выбора. Не флагман: первый кадр новичка не должен
 * стоить 20 ✨ — если сходство не понравится, человек уйдёт.
 */
export const PRIMARY_MODEL: ModelId = "nb2";

export function isModelId(v: unknown): v is ModelId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(MODELS, v);
}

/** Самая дешёвая и самая дорогая: «кадр от N ✨» и разброс кадров на экранах оплаты. */
export const CHEAPEST_MODEL: ModelId = MODEL_ORDER.reduce((a, b) =>
  MODELS[a].price <= MODELS[b].price ? a : b
);
export const DEAREST_MODEL: ModelId = MODEL_ORDER.reduce((a, b) =>
  MODELS[a].price >= MODELS[b].price ? a : b
);
/** Порог входа: «Кадр — от 10 ✨». */
export const MIN_PRICE = MODELS[CHEAPEST_MODEL].price;

// ── Параметры генерации ──────────────────────────────────────────────────────
/**
 * Разрешение: "1K" | "2K" | "4K". Понижение до 1K — рычаг на случай плохой выплаты.
 * У seedream поля `resolution` нет вовсе, там это `quality`: basic = 1K, high = 2K.
 * Перевод делает `kie.ts`, четвёртой константы для этого не заводим.
 */
export const MODEL_RESOLUTION: "1K" | "2K" | "4K" = "2K";
/**
 * Продукт про людей, поэтому портрет. Выбора соотношения в интерфейсе нет.
 * 3:4 есть в enum всех четырёх моделей — менять на что-то другое можно только
 * сверившись со всеми сразу.
 */
export const MODEL_ASPECT_RATIO = "3:4";
/**
 * Формат кадра. Пишется как `jpg`, но у seedream тот же формат называется
 * `jpeg`, а gpt-image-2 поля вовсе не принимает. Разбирается в `kie.ts`.
 */
export const MODEL_OUTPUT_FORMAT: "jpg" | "png" = "jpg";

/** +10% на брак и повторы. */
export const RETRY_OVERHEAD = 1.1;
/** Сколько реально доходит до владельца с одной звезды. Подтверждено: $13 / 1000 ⭐. */
export const STAR_PAYOUT_USD = 0.013;
/** Цена звезды для пользователя, ₽. Только для прикидок. */
export const STAR_PRICE_RUB = 1.99;
/** Курс искры в рублях. На нём стоит вся таблица пакетов. */
export const SPARK_PRICE_RUB = 1.5;
/** Только для прикидок. */
export const USD_RUB = 85;
/** Ставка эквайринга рублёвого рельса. Провайдер не выбран — число предварительное. */
export const ACQUIRING_FEE = 0.05;
/** Комиссия крипто-рельса. */
export const CRYPTO_FEE = 0.01;

// ── Платёжные рельсы ─────────────────────────────────────────────────────────
export type PayMethod = "sbp" | "card" | "stars" | "crypto";

export interface PayMethodInfo {
  id: PayMethod;
  icon: string;
  /** Единица, в которой человек платит: ₽, ⭐, USDT. */
  unit: string;
  /**
   * Работает ли рельс прямо сейчас. Мёртвый отдаёт тост «скоро» и экран пакетов
   * не открывает: кнопка, ведущая в никуда, хуже отсутствующей. Внешний
   * эквайринг не подключён — живут пока только звёзды.
   */
  live: boolean;
}

export const PAY_METHODS: Record<PayMethod, PayMethodInfo> = {
  sbp: { id: "sbp", icon: "🏦", unit: "₽", live: false },
  card: { id: "card", icon: "💳", unit: "₽", live: false },
  stars: { id: "stars", icon: "⭐", unit: "⭐", live: true },
  crypto: { id: "crypto", icon: "₿", unit: "USDT", live: false },
};

/** Порядок на экране: сначала рубли — только они дают оборотные деньги сразу. */
export const PAY_METHOD_ORDER: PayMethod[] = ["sbp", "card", "stars", "crypto"];

/**
 * Зелёная — одна, и это первый ЖИВОЙ рельс: четыре зелёные кнопки не сигнал,
 * а фон, а зелень на «скоро» — обещание, которого бот не держит.
 * Включится СБП — зелёный уедет туда сам.
 */
export const RECOMMENDED_METHOD: PayMethod | undefined = PAY_METHOD_ORDER.find(
  (m) => PAY_METHODS[m].live
);

// ── Пакеты ───────────────────────────────────────────────────────────────────
/**
 * Пакет один на все рельсы, каждый рисует свою цену за одно и то же число искр.
 * Базовый размен везде 1 ✨ = 1 ⭐ = 1,5 ₽, бонус — сверху и в подарок,
 * а не другой курс.
 *
 * Потолок бонуса на звёздах +10% против +20% на рублях: при +20% нетто падает
 * до $0,0108 за искру и самая дешёвая модель пробивает правило 50%.
 */
export interface Pack {
  /** 1..4, он же параметр в callback_data: `buy:stars:3`. */
  tier: number;
  /** Искры без бонуса. */
  base: number;
  rub: number;
  usdt: number;
  stars: number;
  /** Бонус в процентах: рубли и крипта. */
  bonusFiat: number;
  /** Бонус в процентах: звёзды. */
  bonusStars: number;
}

export const PACKS: Pack[] = [
  { tier: 1, base: 200, rub: 300, usdt: 4, stars: 200, bonusFiat: 0, bonusStars: 0 },
  { tier: 2, base: 500, rub: 750, usdt: 9, stars: 500, bonusFiat: 10, bonusStars: 10 },
  { tier: 3, base: 1000, rub: 1500, usdt: 18, stars: 1000, bonusFiat: 15, bonusStars: 10 },
  { tier: 4, base: 2000, rub: 3000, usdt: 35, stars: 2000, bonusFiat: 20, bonusStars: 10 },
];

export function findPack(tier: number): Pack | undefined {
  return PACKS.find((p) => p.tier === tier);
}

/** Сколько человек платит за пакет на этом рельсе. */
export function priceOf(pack: Pack, method: PayMethod): number {
  if (method === "stars") return pack.stars;
  if (method === "crypto") return pack.usdt;
  return pack.rub;
}

/** Бонус в процентах на этом рельсе. */
export function bonusOf(pack: Pack, method: PayMethod): number {
  return method === "stars" ? pack.bonusStars : pack.bonusFiat;
}

/** Сколько искр зачислится. Считается из базы и бонуса — числа не могут разъехаться. */
export function sparksOf(pack: Pack, method: PayMethod): number {
  return Math.round(pack.base * (1 + bonusOf(pack, method) / 100));
}

// ── Загрузка селфи ───────────────────────────────────────────────────────────
/** Одного селфи уже достаточно, поэтому отдельного шага «Готово» в потоке нет. */
export const MAX_PHOTOS = 4;
/**
 * Сколько живёт список ссылок на селфи. Ссылки ведут в хранилище kie, а оно
 * временное: дока обещает то 24 часа, то 3 дня. Держать ссылку дольше самого
 * файла нельзя — человек вернётся через сутки, нажмёт «сделать кадр», и в
 * модель уедут мёртвые URL. Двадцать часов — с запасом внутри худшего обещания.
 *
 * Протухший список не ломает поток: экран промпта сам превращается в экран
 * загрузки, а startGeneration просит прислать селфи заново.
 */
export const PHOTO_TTL_SEC = 20 * 60 * 60;

// ── Промпт ───────────────────────────────────────────────────────────────────
/** Короче — почти наверняка случайное сообщение, а не описание кадра. */
export const MIN_PROMPT_LEN = 3;
/** Длиннее модели всё равно не читают целиком. */
export const MAX_PROMPT_LEN = 2000;
/**
 * Лимит текстового сообщения Telegram. Описание кадра уходит отдельным
 * сообщением и в него влезает всегда: человеческий промпт вдвое короче лимита.
 * Рез нужен на один случай — escape раздувает «&» и «<» в разы.
 */
export const TEXT_LIMIT = 4096;

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
/**
 * File Upload API kie.ai живёт на отдельном хосте — это не то же самое, что
 * api.kie.ai для задач генерации. Перепутаешь — /api/file-base64-upload
 * отдаёт 404, потому что на api.kie.ai его нет.
 */
export const KIE_UPLOAD_BASE_URL =
  process.env.KIE_UPLOAD_BASE_URL ?? "https://kieai.redpandaai.co";
/** Публичный https-адрес деплоя, без слеша на конце. */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
/** Секрет для /api/kie-callback и /api/sweep. Без него эндпоинты открыты всему интернету. */
export const CALLBACK_SECRET = process.env.CALLBACK_SECRET ?? "";
/** Секрет вебхука Telegram (X-Telegram-Bot-Api-Secret-Token). */
export const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
export const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ?? "";
/** Картинка-пример: сетка реальных результатов. Если пусто — старт уходит текстом. */
export const EXAMPLE_IMAGE_URL = process.env.EXAMPLE_IMAGE_URL ?? "";

/**
 * Внешние ссылки. Пустая — кнопка просто не рисуется:
 * кнопка, ведущая в никуда, хуже отсутствующей.
 */
function link(value: string | undefined): string {
  const url = (value ?? "").trim();
  return /^https:\/\/\S+$/.test(url) ? url : "";
}
/** Новости продукта. Кнопка на home, последней перед «Назад». */
export const CHANNEL_URL = link(process.env.CHANNEL_URL);
/** Канал с промптами. Кнопка там, где человек завис над пустым полем ввода. */
export const PROMPTS_CHANNEL_URL = link(process.env.PROMPTS_CHANNEL_URL);
/** Куда писать, если сломалось. Строка в справке появляется только вместе с адресом. */
export const SUPPORT_URL = link(process.env.SUPPORT_URL);

// ── Промпт для режима «моё фото» ─────────────────────────────────────────────
/**
 * Преамбула про сходство. Приклеивается только когда есть референс-фото:
 * в режиме «словами» лица нет и держать нечего.
 */
export const PROMPT_PREFIX =
  "Photorealistic photograph of the exact person shown in the reference images. " +
  "Preserve their face, facial proportions, bone structure, eye shape and colour, " +
  "nose, lips, skin tone, skin texture and hairline with absolute fidelity — the result " +
  "must be unmistakably the same individual. Do not beautify, slim, de-age or stylise the face.";

export const PROMPT_SUFFIX =
  "Natural skin texture with visible pores, sharp focus on the eyes, professional colour grading. " +
  "No text, no logo, no watermark, no extra people, no distorted hands.";

// ── Админка ──────────────────────────────────────────────────────────────────
/**
 * Кто, кроме владельца, видит админку. Список chat_id через запятую.
 * Пусто — админка только у OWNER_CHAT_ID.
 */
export const ADMIN_IDS: string[] = (process.env.ADMIN_IDS ?? "")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Часовой пояс отчётов. По нему считаются и дневные счётчики, и даты в карточке:
 * иначе «сегодня» на дашборде и «сегодня» в голове владельца — разные дни.
 */
export const REPORT_TZ = "Europe/Moscow";

/** Лестница ручного начисления. Экран сумм собирается из неё, руками нигде не дублируется. */
export const GRANT_AMOUNTS: number[] = [10, 20, 50, 100, 250, 500];
/** Потолок одной ручной операции. Защита от лишнего нуля в «своей сумме». */
export const GRANT_MAX = 10000;

/** За что начисляем. Причина обязательна — без неё лог через месяц ничего не объясняет. */
export type GrantReason = "fail" | "bonus" | "comp" | "fix";
/** Причины начисления. `fix` сюда не входит: это списание, и оно всегда правка. */
export const GRANT_REASONS: GrantReason[] = ["fail", "bonus", "comp"];
/** Причина списания. Одна, поэтому экрана выбора у списания нет. */
export const TAKE_REASON: GrantReason = "fix";

export function isGrantReason(v: unknown): v is GrantReason {
  return v === "fail" || v === "bonus" || v === "comp" || v === "fix";
}

/** Знак операции выводится из причины, а не едет отдельным параметром. */
export function signOf(reason: GrantReason): 1 | -1 {
  return reason === TAKE_REASON ? -1 : 1;
}

/** Сколько операций хранится в истории одного человека. */
export const LEDGER_KEEP = 50;
/** Сколько сбоев хранится в общем логе и сколько — в личном. */
export const FAILS_KEEP = 100;
export const USER_FAILS_KEEP = 10;
/** Сколько ручных начислений хранится в логе админов. */
export const GRANTS_KEEP = 100;

/** Сколько строк истории и сбоев показывает карточка. */
export const CARD_OPS = 8;
export const CARD_FAILS = 3;
/** Сколько строк в списках сбоев и людей. */
export const LIST_ROWS = 8;
/**
 * Сколько кнопок-людей под списком. Больше не влезает: сверху ещё «Обновить»
 * и «Назад», а потолок экрана — восемь кнопок.
 */
export const LIST_BUTTONS = 5;

/** Сколько живёт дневной счётчик. Больше месяца истории дашборду не нужно. */
export const DAILY_TTL_SEC = 45 * 24 * 60 * 60;
