import { InlineKeyboard } from "grammy";
import {
  CHEAPEST_MODEL,
  MAX_PHOTOS,
  MODELS,
  MODEL_ORDER,
  PACKS,
  PRIMARY_MODEL,
  PayMethod,
  SUPPORT_URL,
  ModelId,
  bonusOf,
  priceOf,
  sparksOf,
} from "./config";
import { esc, num, t } from "./i18n";
import {
  Origin,
  balanceOf,
  contextLine,
  describeKeyboard,
  earnKeyboard,
  frames,
  framesFor,
  helpKeyboard,
  homeKeyboard,
  modelKeyboard,
  modelName,
  modelsKeyboard,
  money,
  packsKeyboard,
  priceLine,
  promptKeyboard,
  rateLine,
  selfies,
  sparks,
  topupKeyboard,
  uploadKeyboard,
} from "./ui";

/**
 * Экраны интерфейса. Каждый — чистая функция от состояния к `{ text, reply_markup }`.
 * Ничего не «дописывается сверху»: экран всегда собирается целиком, поэтому его
 * можно нарисовать в любой момент из одного лишь состояния.
 */
export interface Screen {
  text: string;
  reply_markup?: InlineKeyboard;
}

/** Пустая строка — единственный инструмент вертикального ритма. */
export function compose(...blocks: (string | string[] | undefined | false)[]): string {
  return blocks
    .filter((b): b is string | string[] => Boolean(b))
    .map((b) => (Array.isArray(b) ? b.join("\n") : b))
    .join("\n\n");
}

/** Разовая строка о том, что только что произошло. Часть состояния, не «дописка». */
export interface Notice {
  notice?: string;
}

/**
 * Потолок бонуса. Считается из реестра пакетов, а не пишется в локали: обещание
 * «до +20%» обязано меняться вместе с таблицей, иначе экран врёт молча.
 */
const MAX_BONUS_FIAT = Math.max(...PACKS.map((p) => p.bonusFiat));
const MAX_BONUS_STARS = Math.max(...PACKS.map((p) => p.bonusStars));

// ── home ─────────────────────────────────────────────────────────────────────

export interface HomeState extends Notice {
  balance: number;
  /** Имя из Telegram. Персонализация только в приветствии — больше нигде. */
  name?: string;
}

export function home(s: HomeState): Screen {
  return {
    text: compose(
      s.notice,
      [t("home.hello", { name: esc(s.name ?? "") }), t("home.lead")],
      // Оффер начинается здесь, а не на экране оплаты: воронка стартует со входа,
      // и акция обязана дожить до неё, а не ждать, пока человек сам дойдёт.
      //
      // Блоков «Сделать кадр» и «Искры — валюта бота» тут больше нет: их заголовки
      // слово в слово повторяли кнопки, стоящие на два сантиметра ниже.
      [
        t("home.offer", {
          price: sparks(MODELS[CHEAPEST_MODEL].price),
          bonus: num(MAX_BONUS_FIAT),
        }),
        // Баланс появляется, только когда он есть: «0 ✨» на входе выглядит как долг.
        ...(s.balance > 0 ? [balanceOf(s.balance)] : []),
        t("home.calm"),
      ],
      t("common.bridge")
    ),
    reply_markup: homeKeyboard(),
  };
}

// ── models ───────────────────────────────────────────────────────────────────

export interface ModelsState extends Notice {
  balance: number;
}

/**
 * Модель выбирают не по названию, а по одной фразе «чем она берёт»: цена у всех
 * разная, и человек сравнивает не характеристики, а «за что я плачу больше».
 *
 * Четыре модели — четыре строки одним блоком. Цену строка не повторяет: она уже
 * стоит на кнопке, а до нажатия видна и там.
 */
export function models(s: ModelsState): Screen {
  const items = MODEL_ORDER.map((id) =>
    t("models.item", {
      icon: MODELS[id].icon,
      name: modelName(id),
      pick: t(`model.${id}.pick`),
    })
  );

  return {
    text: compose(
      s.notice,
      [t("models.title"), t("models.lead")],
      items,
      // Абстрактная валюта переводится в кадры. По одной модели, а не по двум:
      // вторая половина строки объясняла ровно то же самое второй раз.
      s.balance > 0
        ? t("models.balance", {
            balance: sparks(s.balance),
            cheap: frames(framesFor(s.balance, PRIMARY_MODEL)),
            cheapName: modelName(PRIMARY_MODEL),
          })
        : rateLine(),
      t("common.bridge")
    ),
    reply_markup: modelsKeyboard(),
  };
}

// ── model:<id> ───────────────────────────────────────────────────────────────

export interface ModelState extends Notice {
  model: ModelId;
  balance: number;
}

/**
 * Один шаблон на четыре модели. Строка `weak` — честное ограничение: четыре
 * одинаково прекрасные модели не объясняют разницу в цене, а ограничение объясняет.
 * Она стоит вплотную к `about`, а не отдельным блоком: это одна мысль о модели,
 * а не две.
 *
 * Строк «пришли селфи» и «опиши словами» тут нет: они дублировали две кнопки,
 * стоящие прямо под текстом, и слово в слово.
 */
export function model(s: ModelState): Screen {
  const info = MODELS[s.model];
  const needTopup = s.balance < info.price;

  return {
    text: compose(
      s.notice,
      [
        t("models.plain", { icon: info.icon, name: modelName(s.model) }),
        t(`model.${s.model}.about`),
        t(`model.${s.model}.weak`),
      ],
      priceLine(s.model, s.balance),
      t("common.bridge")
    ),
    reply_markup: modelKeyboard(s.model, needTopup),
  };
}

// ── upload ───────────────────────────────────────────────────────────────────

export interface UploadState extends Notice {
  model: ModelId;
  balance: number;
}

/**
 * Главное действие тут не кнопка, а фотография, поэтому мостик уводит в поле ввода.
 *
 * Возражение снимается там, где возникает: человека просят прислать собственное
 * лицо, и первый вопрос в голове — что с ним будет дальше. Отвечать на него
 * в разделе помощи поздно — до помощи он не дойдёт, он просто не пришлёт фото.
 */
export function upload(s: UploadState): Screen {
  return {
    text: compose(
      s.notice,
      [t("upload.title"), t("upload.body")],
      t("upload.howto"),
      // Ключевой факт и возражение — одним блоком: обе строки про одно и то же,
      // про цену вопроса.
      [contextLine(s.model, s.balance), t("upload.calm")],
      t("upload.bridge")
    ),
    reply_markup: uploadKeyboard(s.model),
  };
}

// ── prompt ───────────────────────────────────────────────────────────────────

export interface PromptState extends Notice {
  model: ModelId;
  balance: number;
  photos: number;
}

export function prompt(s: PromptState): Screen {
  const full = s.photos >= MAX_PHOTOS;
  return {
    text: compose(
      s.notice,
      // Сколько селфи принято и можно ли ещё — одной строкой: это один факт.
      t(full ? "prompt.full" : "prompt.more", { selfies: selfies(s.photos) }),
      // Пример — часть просьбы, а не отдельная мысль: между ними пустой строки нет.
      [t("prompt.ask.title"), t("prompt.ask.body"), t("prompt.example")],
      contextLine(s.model, s.balance),
      t("prompt.bridge")
    ),
    reply_markup: promptKeyboard(s.model),
  };
}

// ── describe ─────────────────────────────────────────────────────────────────

export interface DescribeState extends Notice {
  model: ModelId;
  balance: number;
}

export function describe(s: DescribeState): Screen {
  return {
    text: compose(
      s.notice,
      [t("describe.title"), t("describe.body"), t("describe.example")],
      t("describe.howto"),
      contextLine(s.model, s.balance),
      t("describe.bridge")
    ),
    reply_markup: describeKeyboard(s.model),
  };
}

// ── busy ─────────────────────────────────────────────────────────────────────

export interface BusyState extends Notice {
  model: ModelId;
  balance: number;
  cost: number;
}

/**
 * Клавиатуры нет намеренно: пока кадр готовится, нажимать нечего, и двойной тап
 * физически невозможен. Мостика тоже нет — показывать ⌄ в пустоту нельзя.
 */
export function busy(s: BusyState): Screen {
  return {
    text: compose(
      s.notice,
      [t("busy.title"), t("busy.body")],
      [
        t("busy.context", {
          model: modelName(s.model),
          cost: sparks(s.cost),
          balance: sparks(s.balance),
        }),
        t("busy.calm"),
      ]
    ),
  };
}

// ── topup ────────────────────────────────────────────────────────────────────

export interface TopupState extends Notice {
  balance: number;
  /** Экран, с которого пришли. Иначе человек вылетает на корень и теряет выбор модели. */
  from: Origin;
}

/**
 * Правду про потолок бонуса экран говорит сразу, а не прячет до рельса со звёздами:
 * человек, увидевший меньший бонус уже после выбора, чувствует себя обманутым.
 */
export function topup(s: TopupState): Screen {
  return {
    text: compose(
      s.notice,
      [t("topup.title"), t("topup.lead", { price: sparks(MODELS[CHEAPEST_MODEL].price) })],
      [
        t("topup.offer", { fiat: num(MAX_BONUS_FIAT), stars: num(MAX_BONUS_STARS) }),
        balanceOf(s.balance),
        t("topup.objection"),
      ],
      t("common.bridge")
    ),
    reply_markup: topupKeyboard(s.from),
  };
}

// ── packs:<method> ───────────────────────────────────────────────────────────

export interface PacksState extends Notice {
  method: PayMethod;
  balance: number;
  from: Origin;
}

/**
 * Один шаблон на четыре рельса. Скидка показывается дважды: бейджем на кнопке
 * и кадрами в тексте — в процентах она абстрактна, в кадрах это товар.
 *
 * Лестницы «200 ✨ · 550 ✨ · 1 100 ✨» в тексте нет намеренно: она слово в слово
 * повторяла кнопки под собой и занимала место, на котором должен стоять перевод
 * искр в кадры.
 *
 * На звёздах бонус упирается в потолок +10% и с размером пакета не растёт,
 * поэтому и строка оффера, и строка про большой пакет там другие: обещать
 * растущую скидку там, где её нет, дороже потерянного процента конверсии.
 */
export function packs(s: PacksState): Screen {
  const best = PACKS[PACKS.length - 1];
  const grows = bonusOf(best, s.method) > bonusOf(PACKS[1], s.method);

  return {
    text: compose(
      s.notice,
      [
        t(`packs.${s.method}.title`),
        t("packs.lead", {
          price: sparks(MODELS[CHEAPEST_MODEL].price),
          balance: sparks(s.balance),
        }),
      ],
      [
        t(grows ? "packs.offer.grow" : "packs.offer.flat", {
          bonus: num(bonusOf(best, s.method)),
        }),
        t(grows ? "packs.best.grow" : "packs.best.flat", {
          price: money(priceOf(best, s.method), s.method),
          cheap: frames(framesFor(sparksOf(best, s.method), CHEAPEST_MODEL)),
          cheapName: modelName(CHEAPEST_MODEL),
        }),
      ],
      t(`packs.${s.method}.objection`),
      t("packs.bridge")
    ),
    reply_markup: packsKeyboard(s.method, s.from),
  };
}

// ── help ─────────────────────────────────────────────────────────────────────

export function help(s: Notice = {}): Screen {
  return {
    text: compose(
      s.notice,
      // Весь путь — одним блоком из трёх строк. Два блока с заголовками
      // «Как сделать кадр» и «Сколько ждать» пересказывали ровно его.
      [t("help.title"), t("help.lead"), t("help.calm")],
      // Строка про поддержку появляется только вместе с кнопкой: без адреса
      // обещать канал связи нечем. Ссылки в ней нет — она под кнопкой, и
      // второй адрес на том же экране только раздваивает клик.
      t("help.faq.text", { support: SUPPORT_URL ? t("help.faq.support") : "" }),
      t("common.bridge")
    ),
    reply_markup: helpKeyboard(),
  };
}

// ── earn ─────────────────────────────────────────────────────────────────────

/**
 * Экран заморожен: рефералка — фича, а фичи не трогаются до первой оплаты.
 * Поэтому тут честное «ещё нет» без процентов и сроков, а не обещание.
 */
export function earn(s: Notice = {}): Screen {
  return {
    text: compose(
      s.notice,
      [t("earn.title"), t("earn.lead")],
      t("earn.honest"),
      t("common.bridge")
    ),
    reply_markup: earnKeyboard(),
  };
}
