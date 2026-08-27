import { InlineKeyboard } from "grammy";
import {
  CURRENCY_EMOJI,
  GRANT_AMOUNTS,
  GRANT_MAX,
  GrantReason,
  LEDGER_KEEP,
  PAY_METHODS,
  TAKE_REASON,
  signOf,
} from "./config";
import { day, esc, num, pct, plural, t, when } from "./i18n";
import type { ErrorNote, Fail, Op } from "./ledger";
import type { Notice, Screen } from "./screens";
import { compose } from "./screens";
import type { Dash, Health } from "./stats";
import type { Person } from "./store";
import { ACB, CB, dur, modelName, parsePayload, personName, sparks, tasks } from "./ui";

/**
 * Экраны админки. Как и продуктовые экраны — чистые функции от состояния
 * к `{ text, reply_markup }`: ни одна строка не «дописывается сверху»,
 * поэтому любой экран рисуется в любой момент из одних только данных.
 *
 * Живут отдельным файлом от `screens.ts` намеренно. Там продукт, который видит
 * покупатель, здесь — инструмент, которым чинят его проблемы. Правила вёрстки
 * общие, словарь и плотность — разные: админу нужны числа, а не уговоры.
 */

// ── Общее ────────────────────────────────────────────────────────────────────

/**
 * Новый ряд — только если в текущем что-то есть.
 *
 * Списки кончаются на `.row()`, потому что число строк в них заранее неизвестно,
 * и следующий безусловный `.row()` оставлял бы посреди клавиатуры пустой ряд.
 */
function row(kb: InlineKeyboard): InlineKeyboard {
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1];
  return last !== undefined && last.length === 0 ? kb : kb.row();
}

/** «Назад» — всегда последней строкой, отдельным рядом, всегда с одной иконкой. */
function back(kb: InlineKeyboard, to: string): InlineKeyboard {
  return row(kb).text(t("button.back"), to);
}

function refresh(kb: InlineKeyboard, to: string): InlineKeyboard {
  return row(kb).text(t("admin.button.refresh"), to);
}

/** «@slavafan» или «id 483920112» — в тексте, с экранированием. */
function nameOf(p: Person): string {
  return esc(personName(p.username, p.chatId));
}

/**
 * Лейбл кнопки-человека. Юзернейм в Telegram бывает до 32 символов, а кнопка
 * ломает ряд после 30 — поэтому имя подрезается, а баланс остаётся целиком:
 * ради него на кнопку и смотрят.
 */
function personButton(p: Person): string {
  const full = personName(p.username, p.chatId);
  const short = full.length > 14 ? `${full.slice(0, 13)}…` : full;
  return t("admin.button.person", { name: short, balance: sparks(p.balance) });
}

// ── Дашборд ──────────────────────────────────────────────────────────────────

export interface DashState extends Notice {
  dash: Dash;
  /** Сколько людей в индексе. */
  users: number;
  /** Сколько сбоев лежит в логе. Число едет прямо на кнопку. */
  fails: number;
}

/**
 * Корень админки — сразу дашборд, а не меню разделов: экран, который только
 * раздаёт ссылки, тратит нажатие и не сообщает ничего.
 *
 * Воронка меряется людьми: старт → селфи → кадр → оплата. Проценты считаются
 * от старта, а не от предыдущего шага — иначе красивый процент на последнем
 * шаге прячет то, что до него дошли трое.
 */
export function dashboard(s: DashState): Screen {
  const { people, money, frames, today } = s.dash;

  return {
    text: compose(
      s.notice,
      [
        t("admin.home.title"),
        // Склонения через плюрализацию: «1 оплата» и «3 оплаты» на дашборде
        // мозолят глаз ровно так же, как в интерфейсе покупателя.
        t("admin.home.today", {
          start: plural("unit.newcomer", today.start),
          gen: plural("unit.frame", today.gen),
          paid: plural("unit.payment", today.paid),
          stars: num(today.stars),
        }),
      ],
      [
        t("admin.home.funnel.title"),
        t("admin.home.funnel.line", {
          start: num(people.start),
          photos: num(people.photos),
          gen: num(people.gen),
          paid: num(people.paid),
        }),
        t("admin.home.funnel.rate", {
          toGen: pct(people.gen, people.start),
          toPaid: pct(people.paid, people.start),
        }),
      ],
      [
        t("admin.home.money.title"),
        t("admin.home.money.stars", {
          stars: num(money.stars),
          rub: num(Math.round(money.rub)),
        }),
        t("admin.home.money.cost", {
          cost: money.cost.toFixed(2),
          share: pct(money.cost, money.netto),
        }),
        t("admin.home.money.sparks", {
          sold: num(money.sold),
          spent: num(money.spent),
          refunded: num(money.refunded),
        }),
        t("admin.home.money.hand", {
          granted: num(money.granted),
          taken: num(money.taken),
        }),
      ],
      [
        t("admin.home.frames.title"),
        t("admin.home.frames.line", {
          done: num(frames.done),
          failed: num(frames.failed),
          share: pct(frames.failed, frames.done + frames.failed),
        }),
      ],
      t("common.bridge")
    ),
    reply_markup: dashboardKeyboard(s.fails, s.users),
  };
}

/**
 * Синяя — там, где проблема. Сбои есть — панель показывает на них; сбоев нет —
 * главным действием становится поиск человека, потому что заходят сюда ради него.
 */
function dashboardKeyboard(fails: number, users: number): InlineKeyboard {
  const kb = new InlineKeyboard().text(
    t("admin.button.fails", { count: num(fails) }),
    ACB.fails
  );
  if (fails > 0) kb.primary();
  kb.row().text(t("admin.button.find"), ACB.find);
  if (fails === 0) kb.primary();
  kb.text(t("admin.button.users", { count: num(users) }), ACB.users);
  // Здоровье отдельной строкой и без цвета: заходят сюда не за ним, а за
  // людьми и деньгами. Оно нужно ровно тогда, когда что-то идёт не так.
  kb.row().text(t("admin.button.health"), ACB.health);
  refresh(kb, ACB.home);
  return back(kb, CB.home);
}

// ── Здоровье ─────────────────────────────────────────────────────────────────

export interface HealthState extends Notice {
  health: Health;
  errors: ErrorNote[];
  /** Сколько сбоев генераций лежит в логе. Число едет на кнопку, как на дашборде. */
  fails: number;
}

/**
 * Отдельный экран от дашборда потому, что читают их в разных состояниях.
 * Дашборд смотрят с утра за кофе — он про то, как идут дела. Здоровье
 * открывают, когда пришла жалоба, и оно отвечает на один вопрос: бот сейчас
 * работает или тонет.
 *
 * Очередь стоит первой строкой: растущая очередь недобранных кадров — это
 * списанные искры без картинки, то есть самая дорогая из поломок.
 */
export function health(s: HealthState): Screen {
  const { queue, speed, errors, today } = s.health;

  const log = s.errors.map((e) =>
    t("admin.health.log.line", {
      when: when(e.at),
      where: esc(e.where),
      rid: esc(e.rid),
      detail: esc(e.detail),
    })
  );

  return {
    text: compose(
      s.notice,
      [
        t("admin.health.title"),
        queue.size === 0
          ? t("admin.health.queue.calm")
          : t("admin.health.queue.busy", {
              tasks: tasks(queue.size),
              age: dur(queue.oldestMs),
            }),
      ],
      [
        t("admin.health.speed.title"),
        speed.frameMs === 0
          ? t("admin.health.speed.empty")
          : t("admin.health.speed.line", {
              frame: dur(speed.frameMs),
              kie: dur(speed.kieMs),
            }),
      ],
      [
        t("admin.health.today.title"),
        t("admin.health.today.line", {
          gen: num(today.gen),
          done: num(today.done),
          failed: num(today.failed),
        }),
      ],
      [
        t("admin.health.errors.title"),
        t("admin.health.errors.kie", {
          today: plural("unit.time", errors.kieToday),
          total: num(errors.kie),
        }),
        t("admin.health.errors.bot", { slow: num(errors.slow), busy: num(errors.busy) }),
      ],
      [
        t("admin.health.log.title"),
        log.length === 0 ? t("admin.health.log.empty") : log.join("\n"),
      ],
      log.length > 0 && t("admin.health.log.hint"),
      t("common.bridge")
    ),
    reply_markup: healthKeyboard(s.fails),
  };
}

/**
 * Синяя — там, где проблема, ровно как на дашборде. Сбои есть — она ведёт
 * в их лог: сломавшийся бот означает людей с пустыми руками, и первое дело
 * не чинить код, а вернуть им искры. Сбоев нет — главным действием становится
 * обновление: на этот экран и приходят затем, чтобы смотреть, как меняются числа.
 */
function healthKeyboard(fails: number): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t("admin.button.fails", { count: num(fails) }), ACB.fails);
  if (fails > 0) kb.primary();
  kb.row().text(t("admin.button.refresh"), ACB.health);
  if (fails === 0) kb.primary();
  return back(kb, ACB.home);
}

// ── Сбои ─────────────────────────────────────────────────────────────────────

export interface FailRow {
  fail: Fail;
  person: Person;
}

export interface FailsState extends Notice {
  rows: FailRow[];
  /** Сколько сбоев вообще лежит в логе. */
  total: number;
  /** Люди под списком, уже без повторов. */
  people: Person[];
}

/**
 * Лог сбоев. Отвечает на единственный вопрос, ради которого сюда заходят:
 * кому сейчас должны искры. Поэтому в каждой строке стоит, ушёл ли автовозврат,
 * — сбой с возвратом это статистика, сбой без возврата это долг.
 */
export function fails(s: FailsState): Screen {
  const lines = s.rows.map((r) =>
    t("admin.fails.line", {
      when: when(r.fail.at),
      name: nameOf(r.person),
      model: r.fail.model === null ? t("admin.noModel") : modelName(r.fail.model),
      cost: sparks(r.fail.cost),
      reason: esc(r.fail.reason),
      back: t(r.fail.back ? "admin.fails.returned" : "admin.fails.owed"),
    })
  );

  return {
    text: compose(
      s.notice,
      [
        t("admin.fails.title"),
        s.rows.length === 0
          ? t("admin.fails.empty")
          : t("admin.fails.lead", { shown: num(s.rows.length), total: num(s.total) }),
      ],
      lines.length > 0 && lines,
      lines.length > 0 && t("admin.fails.hint"),
      t("common.bridge")
    ),
    reply_markup: listKeyboard(s.people, ACB.fails),
  };
}

// ── Последние люди ───────────────────────────────────────────────────────────

export interface UsersState extends Notice {
  /** Строки списка. */
  rows: Person[];
  /** Кнопки под списком: первые несколько из тех же людей. */
  people: Person[];
  total: number;
}

export function users(s: UsersState): Screen {
  const lines = s.rows.map((p) =>
    t("admin.users.line", {
      day: day(p.createdAt),
      name: nameOf(p),
      balance: sparks(p.balance),
      status: t(`admin.status.${p.status}`),
    })
  );

  return {
    text: compose(
      s.notice,
      [
        t("admin.users.title"),
        s.rows.length === 0
          ? t("admin.users.empty")
          : t("admin.users.lead", { shown: num(s.rows.length), total: num(s.total) }),
      ],
      lines.length > 0 && lines,
      t("common.bridge")
    ),
    reply_markup: listKeyboard(s.people, ACB.users),
  };
}

/**
 * Список людей кнопками. Первый — синий: сверху лежит самое свежее, и почти
 * всегда открывают именно его.
 *
 * Пустой список без кнопок-людей был бы экраном с одним «Назад», то есть
 * тупиком, поэтому поиск на нём остаётся всегда.
 */
function listKeyboard(people: Person[], self: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of people) kb.text(personButton(p), ACB.card(p.chatId)).row();
  if (people.length > 0) kb.inline_keyboard[0][0].style = "primary";
  else kb.text(t("admin.button.find"), ACB.find).primary().row();
  refresh(kb, self);
  return back(kb, ACB.home);
}

// ── Поиск ────────────────────────────────────────────────────────────────────

/**
 * Экран ввода: главное действие тут не кнопка, а сообщение, которое админ
 * сейчас напишет. Поэтому цветных кнопок нет, а мостик уводит в поле ввода.
 */
export function find(s: Notice = {}): Screen {
  return {
    text: compose(
      s.notice,
      [t("admin.find.title"), t("admin.find.body")],
      t("admin.find.objection"),
      t("admin.find.bridge")
    ),
    reply_markup: new InlineKeyboard()
      .text(t("admin.button.usersPlain"), ACB.users)
      .row()
      .text(t("button.back"), ACB.home),
  };
}

// ── Карточка ─────────────────────────────────────────────────────────────────

export interface CardState extends Notice {
  person: Person;
  ops: Op[];
  /** Сколько операций сохранено всего: карточка честно говорит, что показывает не всё. */
  opsTotal: number;
  fails: Fail[];
  /**
   * Сумма кнопки быстрого возврата — цена последнего сбоя. 0 — возвращать
   * нечего: сбоев не было либо за последний уже начислили.
   */
  owed: number;
  /**
   * Ушёл ли автовозврат по этому сбою. Меняет смысл кнопки: вернуть долг —
   * это одно, добавить сверху за испорченное впечатление — совсем другое,
   * и подписать их одинаково значит однажды заплатить дважды.
   */
  owedReturned: boolean;
  /**
   * Сколько селфи человека ещё лежит в хранилище. Ноль — кнопки просмотра нет
   * вовсе: ссылки живут около суток, и кнопка, ведущая в пустоту, хуже её
   * отсутствия.
   */
  photos: number;
  /**
   * Куда вернёт «Назад». Человека открывают из трёх мест, и выкидывать его
   * из списка сбоев на корень означает искать это место заново после каждого
   * начисления.
   */
  backTo: string;
}

/** «оплата ⭐ · пакет 2», «кадр · Nano Banana Pro», «возврат · таймаут». */
function opText(op: Op): string {
  switch (op.kind) {
    case "buy": {
      const parsed = parsePayload(op.ref);
      return parsed
        ? t("admin.op.buy", {
            method: PAY_METHODS[parsed.method].icon,
            tier: num(parsed.tier),
          })
        : t("admin.op.buyPlain");
    }
    case "spend":
      return t("admin.op.spend", { model: esc(op.ref) });
    case "back":
      return t("admin.op.back", { reason: esc(op.ref) });
    case "grant":
      return t("admin.op.grant", { reason: t(`admin.reason.${op.ref}.name`) });
    case "take":
      return t("admin.op.take", { reason: t(`admin.reason.${op.ref}.name`) });
  }
}

/** «+550 ✨» / «−20 ✨». Знак обязателен: без него история не читается. */
function opAmount(op: Op): string {
  const sign = op.delta < 0 ? "−" : "+";
  return `${sign}${num(Math.abs(op.delta))} ${CURRENCY_EMOJI}`;
}

/**
 * Всё про человека на одном экране: кто он, сколько у него, что с этим
 * происходило и что у него ломалось. Разносить это по трём экранам нельзя —
 * начислять пришлось бы по памяти, а память врёт.
 */
export function card(s: CardState): Screen {
  const p = s.person;
  const ops = s.ops.map((op) =>
    t("admin.card.op", { when: when(op.at), amount: opAmount(op), what: opText(op) })
  );
  const failLines = s.fails.map((f) =>
    t("admin.card.fail", {
      when: when(f.at),
      model: f.model === null ? t("admin.noModel") : modelName(f.model),
      cost: sparks(f.cost),
      reason: esc(f.reason),
      back: t(f.back ? "admin.fails.returned" : "admin.fails.owed"),
    })
  );

  return {
    text: compose(
      s.notice,
      [
        t("admin.card.title", { name: nameOf(p) }),
        t("admin.card.who", {
          id: String(p.chatId),
          name: p.name ? esc(p.name) : t("admin.card.noName"),
          day: day(p.createdAt),
          status: t(`admin.status.${p.status}`),
        }),
      ],
      [
        t("admin.card.balance", { balance: sparks(p.balance) }),
        p.fails > 0 ? t("admin.card.streak", { fails: num(p.fails) }) : "",
      ].filter(Boolean),
      [
        ops.length > 0
          ? t("admin.card.ops.title", { shown: num(ops.length), total: num(s.opsTotal) })
          : t("admin.card.ops.empty"),
        ...ops,
      ],
      failLines.length > 0 && [t("admin.card.fails.title"), ...failLines],
      s.opsTotal >= LEDGER_KEEP && t("admin.card.ops.trimmed", { keep: num(LEDGER_KEEP) }),
      t("common.bridge")
    ),
    reply_markup: cardKeyboard(p.chatId, s.owed, s.owedReturned, s.photos, s.backTo),
  };
}

/**
 * Быстрый возврат — единственная зелёная и первая по порядку: чаще всего сюда
 * заходят именно за ней, и трёх нажатий от корня хватает, чтобы вернуть деньги.
 * Сбоев нет — зелёной становится обычное начисление: экрана без главного
 * действия не бывает.
 */
function cardKeyboard(
  chatId: number,
  owed: number,
  owedReturned: boolean,
  photos: number,
  backTo: string
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (owed > 0) {
    kb.text(
      t(owedReturned ? "admin.button.extraFast" : "admin.button.returnFast", {
        amount: sparks(owed),
      }),
      ACB.apply(chatId, "fail", owed)
    )
      .success()
      .row();
  }
  kb.text(t("admin.button.grant"), ACB.reason(chatId));
  if (owed === 0) kb.success();
  kb.text(t("admin.button.take"), ACB.amount(chatId, TAKE_REASON)).danger();
  // Селфи — отдельным рядом и без цвета: это не действие с деньгами, а взгляд
  // на исходник. Жалоба «кадр не похож» разбирается только отсюда.
  if (photos > 0) {
    kb.row().text(t("admin.button.photos", { count: num(photos) }), ACB.photos(chatId));
  }
  refresh(kb, ACB.card(chatId));
  return back(kb, backTo);
}

// ── За что начисляем ─────────────────────────────────────────────────────────

export interface ReasonState extends Notice {
  person: Person;
  reasons: GrantReason[];
}

/**
 * Причина — обязательное поле, а не подпись «по желанию». Через месяц только
 * она и объяснит, почему баланс такой; поэтому она стоит отдельным экраном
 * до суммы, а не спрашивается после.
 */
export function reason(s: ReasonState): Screen {
  return {
    text: compose(
      s.notice,
      [
        t("admin.reason.title"),
        t("admin.reason.who", {
          name: nameOf(s.person),
          balance: sparks(s.person.balance),
        }),
      ],
      t("admin.reason.why"),
      s.reasons.map((r) =>
        t("admin.reason.item", {
          icon: t(`admin.reason.${r}.icon`),
          name: t(`admin.reason.${r}.name`),
          about: t(`admin.reason.${r}.about`),
        })
      ),
      t("common.bridge")
    ),
    reply_markup: reasonKeyboard(s.person.chatId, s.reasons),
  };
}

function reasonKeyboard(chatId: number, reasons: GrantReason[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of reasons) {
    kb.text(
      t("admin.button.reason", {
        icon: t(`admin.reason.${r}.icon`),
        name: t(`admin.reason.${r}.name`),
      }),
      ACB.amount(chatId, r)
    );
    if (r === reasons[0]) kb.success();
    kb.row();
  }
  return back(kb, ACB.card(chatId));
}

// ── Сколько ──────────────────────────────────────────────────────────────────

export interface AmountState extends Notice {
  person: Person;
  reason: GrantReason;
  amounts: number[];
}

/**
 * Отдельного экрана подтверждения нет намеренно: кому и за что написано прямо
 * тут, а сумма стоит на самой кнопке. Седьмой экран в цепочке не сделал бы
 * операцию безопаснее — он сделал бы её длиннее, и её начали бы прокликивать.
 *
 * Страховка другая: любое начисление откатывается списанием, и обе операции
 * лежат в логе рядом.
 */
export function amount(s: AmountState): Screen {
  const take = signOf(s.reason) < 0;

  return {
    text: compose(
      s.notice,
      [
        t(take ? "admin.amount.title.take" : "admin.amount.title.grant"),
        t("admin.amount.who", {
          name: nameOf(s.person),
          balance: sparks(s.person.balance),
        }),
        t("admin.amount.why", { reason: t(`admin.reason.${s.reason}.name`) }),
      ],
      t(take ? "admin.amount.calm.take" : "admin.amount.calm.grant"),
      t("admin.amount.custom", { max: sparks(GRANT_MAX) }),
      t("admin.amount.bridge")
    ),
    reply_markup: amountKeyboard(s.person.chatId, s.reason, s.amounts, take),
  };
}

/**
 * Три в ряд: лейблы короткие, а лестница из шести кнопок в столбик выдавила бы
 * с экрана и «Свою сумму», и «Назад».
 */
function amountKeyboard(
  chatId: number,
  reason: GrantReason,
  amounts: number[],
  take: boolean
): InlineKeyboard {
  const kb = new InlineKeyboard();
  amounts.forEach((n, i) => {
    kb.text(
      t(take ? "admin.button.minus" : "admin.button.plus", { amount: num(n) }),
      ACB.apply(chatId, reason, n)
    );
    if (take) kb.danger();
    else kb.success();
    if (i % 3 === 2) kb.row();
  });
  row(kb).text(t("admin.button.custom"), ACB.custom(chatId, reason));
  return back(kb, reason === TAKE_REASON ? ACB.card(chatId) : ACB.reason(chatId));
}

/** Лестница сумм. Экспортируется, чтобы роутер и превью брали её из одного места. */
export const AMOUNTS = GRANT_AMOUNTS;
