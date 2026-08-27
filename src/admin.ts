import { Bot, Context, NextFunction } from "grammy";
import {
  CARD_FAILS,
  CARD_OPS,
  GRANT_AMOUNTS,
  GRANT_MAX,
  GRANT_REASONS,
  GrantReason,
  LEDGER_KEEP,
  LIST_BUTTONS,
  LIST_ROWS,
  isGrantReason,
  signOf,
} from "./config";
import * as admin from "./admin-screens";
import { currentRef, move as moveUser } from "./flow";
import * as hub from "./hub";
import { t } from "./i18n";
import { bump } from "./kv";
import * as ledger from "./ledger";
import { isAdmin } from "./owner";
import type { Screen } from "./screens";
import { buildDash } from "./stats";
import * as store from "./store";
import { bot as telegram } from "./telegram";
import { ACB, sparks } from "./ui";

/**
 * Админка: дашборд, лог сбоев, карточка человека и ручное движение искр.
 *
 * Живёт отдельным роутером, а не ветками в `bot.ts`, ровно по одной причине:
 * весь доступ проверяется в одном месте — на входе. Забыть проверку в одной
 * ветке из десяти нельзя, потому что веток снаружи нет.
 *
 * Навигация та же, что у продукта: нажатие правит то самое сообщение, на котором
 * стоит клавиатура. Новое сообщение появляется дважды — когда админ написал
 * что-то текстом (экран переезжает под его сообщение) и когда человек получает
 * уведомление о начислении.
 */

// ── Адреса ───────────────────────────────────────────────────────────────────

type Ref =
  | { id: "home" }
  | { id: "fails" }
  | { id: "users" }
  | { id: "find" }
  | { id: "card"; target: number }
  | { id: "reason"; target: number }
  | { id: "amount"; target: number; reason: GrantReason };

interface Extra {
  notice?: string;
}

/**
 * Собирает экран целиком из KV. Как и у продукта, отдельного флага «где мы
 * сейчас» нет: адрес приходит с кнопкой, всё остальное выводится из данных.
 */
async function render(adminId: number, ref: Ref, extra: Extra = {}): Promise<Screen> {
  const notice = extra.notice;

  switch (ref.id) {
    case "home": {
      const [dash, users, fails] = await Promise.all([
        buildDash(),
        store.usersCount(),
        ledger.failsCount(),
      ]);
      return admin.dashboard({ dash, users, fails, notice });
    }

    case "fails": {
      const [list, total] = await Promise.all([
        ledger.recentFails(LIST_ROWS),
        ledger.failsCount(),
      ]);
      // Один человек — одна кнопка, даже если сбоев у него пять: два адреса
      // с одинаковым callback_data на одном экране — это одна кнопка-призрак.
      const ids = [...new Set(list.map((f) => f.chatId))];
      const people = await store.getPeople(ids);
      const byId = new Map(people.map((p) => [p.chatId, p]));
      return admin.fails({
        rows: list.map((fail) => ({ fail, person: byId.get(fail.chatId)! })),
        people: people.slice(0, LIST_BUTTONS),
        total,
        notice,
      });
    }

    case "users": {
      const [ids, total] = await Promise.all([
        store.recentUsers(LIST_ROWS),
        store.usersCount(),
      ]);
      const rows = await store.getPeople(ids);
      return admin.users({ rows, people: rows.slice(0, LIST_BUTTONS), total, notice });
    }

    case "find":
      return admin.find({ notice });

    case "card": {
      const [person, ops, opsTotal, fails, state] = await Promise.all([
        store.getPerson(ref.target),
        ledger.history(ref.target, LEDGER_KEEP),
        ledger.historySize(ref.target),
        ledger.failsOf(ref.target, CARD_FAILS),
        store.getAdminState(adminId),
      ]);
      return admin.card({
        person,
        ops: ops.slice(0, CARD_OPS),
        opsTotal,
        fails,
        owed: owedFor(ops, fails),
        owedReturned: fails[0]?.back ?? true,
        backTo: backCb(state.back),
        notice,
      });
    }

    case "reason":
      return admin.reason({
        person: await store.getPerson(ref.target),
        reasons: GRANT_REASONS,
        notice,
      });

    case "amount":
      return admin.amount({
        person: await store.getPerson(ref.target),
        reason: ref.reason,
        amounts: GRANT_AMOUNTS,
        notice,
      });
  }
}

/**
 * Сколько предложить быстрым возвратом.
 *
 * Кнопка исчезает, как только за этот сбой начислили: подтверждения у операции
 * нет намеренно, и двойное нажатие не должно оплачивать один сбой дважды.
 * Начисление за более ранний сбой кнопку не гасит — сравниваются времена.
 */
function owedFor(ops: ledger.Op[], fails: ledger.Fail[]): number {
  const last = fails[0];
  if (!last) return 0;
  const paid = ops.some((op) => op.kind === "grant" && op.ref === "fail" && op.at > last.at);
  return paid ? 0 : last.cost;
}

function backCb(back: store.AdminBack): string {
  if (back === "fails") return ACB.fails;
  if (back === "users") return ACB.users;
  if (back === "find") return ACB.find;
  return ACB.home;
}

/** Перерисовать то сообщение, на котором нажали кнопку. */
async function show(ctx: Context, ref: Ref, extra: Extra = {}): Promise<void> {
  await hub.drawHere(ctx, await render(ctx.chat!.id, ref, extra));
}

/** Перенести экран вниз: админ только что написал что-то сам, экран уехал вверх. */
async function moveTo(adminId: number, ref: Ref, extra: Extra = {}): Promise<void> {
  await hub.move(adminId, await render(adminId, ref, extra));
}

// ── Движение искр ────────────────────────────────────────────────────────────

/**
 * Итог операции. Возвращается, а не рисуется внутри: сумму жмут и кнопкой,
 * и сообщением, а тост существует только у кнопки. Экран рисует тот, кто знает,
 * откуда пришёл вызов.
 */
type Result =
  | { ok: true; toast: string; notice: string }
  | { ok: false; toast: string; reload: boolean };

/**
 * Единственное место, где админка двигает баланс.
 *
 * Порядок: проверить человека → подвинуть баланс → записать в оба журнала →
 * сказать человеку. Журнал пишется после движения денег и упасть на нём не
 * может: запись важна, но не важнее того, что искры уже на месте.
 */
async function moveSparks(
  adminId: number,
  target: number,
  reason: GrantReason,
  requested: number
): Promise<Result> {
  const amount = Math.min(Math.max(Math.round(requested), 1), GRANT_MAX);

  if (!(await store.userExists(target))) {
    return { ok: false, toast: t("admin.toast.noUser"), reload: false };
  }

  return signOf(reason) < 0
    ? takeSparks(adminId, target, reason, amount)
    : grantSparks(adminId, target, reason, amount);
}

async function grantSparks(
  adminId: number,
  target: number,
  reason: GrantReason,
  amount: number
): Promise<Result> {
  const balance = await store.credit(target, amount);
  await writeLogs(adminId, target, reason, amount, balance);
  await bump("sparks_granted", amount);
  await tellUser(adminId, target, amount, reason);

  return {
    ok: true,
    toast: t("admin.toast.granted", { amount: sparks(amount) }),
    notice: t("admin.notice.granted", {
      amount: sparks(amount),
      reason: t(`admin.reason.${reason}.name`),
      balance: sparks(balance),
    }),
  };
}

/**
 * Списание. В минус баланс не уходит: `trySpend` откатывает сам, а мы забираем
 * ровно столько, сколько есть. Человеку про списание не пишем — почти всегда
 * это откат ошибочного начисления, и объяснять его в личке нечем; в журнале
 * операция стоит рядом с тем начислением, которое отменяет.
 */
async function takeSparks(
  adminId: number,
  target: number,
  reason: GrantReason,
  requested: number
): Promise<Result> {
  const before = await store.getBalance(target);
  const amount = Math.min(requested, before);
  if (amount <= 0) {
    return { ok: false, toast: t("admin.toast.nothingToTake"), reload: false };
  }

  const balance = await store.trySpend(target, amount);
  // Между чтением баланса и списанием человек успел потратить искры сам.
  if (balance === null) {
    return { ok: false, toast: t("admin.toast.raced"), reload: true };
  }

  await writeLogs(adminId, target, reason, -amount, balance);
  await bump("sparks_taken", amount);

  return {
    ok: true,
    toast: t("admin.toast.taken", { amount: sparks(amount) }),
    notice: t("admin.notice.taken", { amount: sparks(amount), balance: sparks(balance) }),
  };
}

/** Обе записи разом: в историю человека и в лог админов. */
async function writeLogs(
  adminId: number,
  target: number,
  reason: GrantReason,
  delta: number,
  balance: number
): Promise<void> {
  await ledger.record(target, delta < 0 ? "take" : "grant", delta, reason, adminId);
  await ledger.logGrant({
    at: Date.now(),
    admin: adminId,
    chatId: target,
    delta,
    reason,
    balance,
  });
}

/**
 * Деньги пришли — человек обязан это увидеть. Отдельным сообщением, а не строкой
 * на экране: экран молчит, а начисление это событие в ленте, как чек об оплате.
 * Экран переезжает под него, чтобы не остаться выше.
 *
 * Не дошло — операция всё равно состоялась: человек мог заблокировать бота,
 * и терять из-за этого начисление нельзя.
 */
async function tellUser(
  adminId: number,
  target: number,
  amount: number,
  reason: GrantReason
): Promise<void> {
  try {
    await telegram.api.sendMessage(
      target,
      t("admin.grant.message", {
        amount: sparks(amount),
        // Человеку — своя формулировка: «Возврат за сбой» это ярлык для лога,
        // а в личку приходит фраза, которую можно прочесть вслух.
        reason: t(`admin.reason.${reason}.user`),
      }),
      { parse_mode: "HTML" }
    );
    // Админ, начисливший самому себе, экран уже получит от панели: двигать его
    // ещё и отсюда — значит удалить карточку прямо из-под собственной кнопки.
    if (target !== adminId) await moveUser(target, await currentRef(target));
  } catch (e) {
    console.error("grant notice failed", target, e);
  }
}

// ── Ввод текстом ─────────────────────────────────────────────────────────────

/**
 * Админ пишет боту двумя способами: id или @username в поиске и число в «своей
 * сумме». Всё остальное уходит в обычный сценарий: админ — такой же покупатель,
 * и его промпты не должны исчезать в служебном разборе.
 */
async function onText(ctx: Context, next: NextFunction): Promise<void> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text?.trim();
  if (chatId === undefined || !text) return next();

  const state = await store.getAdminState(chatId);
  if (!state.wait) return next();

  // Команда — не ответ на вопрос. Ожидание снимается, апдейт едет дальше.
  if (text.startsWith("/")) {
    await store.setAdminWait(chatId, "");
    return next();
  }

  if (state.wait === "find") return resolve(chatId, text);

  const parsed = /^sum:(\d+):([a-z]+)$/.exec(state.wait);
  // Мусор в состоянии не должен запирать админа в ожидании навсегда.
  if (!parsed || !isGrantReason(parsed[2])) {
    await store.setAdminWait(chatId, "");
    return moveTo(chatId, { id: "home" });
  }

  const value = Number(text.replace(/[\s_]/g, ""));
  // Не число — значит про сумму уже забыли и пишут боту как обычно. Держать
  // админа в ожидании до конца дней нельзя: он такой же покупатель, и его
  // описание кадра не должно молча исчезать в служебном разборе.
  if (!Number.isFinite(value)) {
    await store.setAdminWait(chatId, "");
    return next();
  }
  return custom(chatId, Number(parsed[1]), parsed[2], value);
}

/** Поиск человека по числовому id или по @username. */
async function resolve(adminId: number, text: string): Promise<void> {
  const byId = /^\d{5,}$/.test(text) ? Number(text) : null;
  const target = byId ?? (await store.findByUsername(text));

  if (target === null || !(await store.userExists(target))) {
    return moveTo(adminId, { id: "find" }, { notice: t("admin.notice.notFound") });
  }

  await store.setAdminWait(adminId, "");
  await store.setAdminTarget(adminId, target);
  await moveTo(adminId, { id: "card", target });
}

/**
 * Своя сумма. Число проверяется здесь, а не только на кнопке: с кнопки приходит
 * то, что мы сами написали, а с клавиатуры — что угодно.
 *
 * Число вне диапазона ожидание не снимает: человек явно называл сумму и просто
 * промахнулся — экран говорит, каким число должно быть, и ждёт следующее.
 */
async function custom(
  adminId: number,
  target: number,
  reason: GrantReason,
  value: number
): Promise<void> {
  if (value < 1 || value > GRANT_MAX) {
    return moveTo(
      adminId,
      { id: "amount", target, reason },
      { notice: t("admin.notice.badAmount", { max: sparks(GRANT_MAX) }) }
    );
  }

  await store.setAdminWait(adminId, "");
  const result = await moveSparks(adminId, target, reason, value);
  // Сообщение админа уже в ленте, тоста тут нет — весь результат уезжает
  // строкой на экран, и экран встаёт под это сообщение.
  await moveTo(
    adminId,
    { id: "card", target },
    { notice: result.ok ? result.notice : result.toast }
  );
}

// ── Регистрация ──────────────────────────────────────────────────────────────

export function install(bot: Bot<Context>): void {
  // Единственная проверка доступа на всю админку. Веток снаружи нет, поэтому
  // забыть её в одной из них невозможно.
  const panel = bot.filter((ctx) => isAdmin(ctx.chat?.id));

  panel.command("admin", async (ctx) => {
    const chatId = ctx.chat.id;
    await store.setAdminBack(chatId, "home");
    await store.setAdminWait(chatId, "");
    // Команда лежит в ленте — экран не может остаться выше неё.
    await moveTo(chatId, { id: "home" });
  });

  panel.callbackQuery(ACB.home, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setAdminBack(ctx.chat!.id, "home");
    await store.setAdminWait(ctx.chat!.id, "");
    await show(ctx, { id: "home" });
  });

  panel.callbackQuery(ACB.fails, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setAdminBack(ctx.chat!.id, "fails");
    await show(ctx, { id: "fails" });
  });

  panel.callbackQuery(ACB.users, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setAdminBack(ctx.chat!.id, "users");
    await show(ctx, { id: "users" });
  });

  /** Единственный экран, после которого бот ждёт от админа сообщение. */
  panel.callbackQuery(ACB.find, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setAdminBack(ctx.chat!.id, "find");
    await store.setAdminWait(ctx.chat!.id, "find");
    await show(ctx, { id: "find" });
  });

  panel.callbackQuery(ACB.CARD_RE, async (ctx) => {
    const target = Number(ctx.match![1]);
    await ctx.answerCallbackQuery();
    await store.setAdminTarget(ctx.chat!.id, target);
    await show(ctx, { id: "card", target });
  });

  panel.callbackQuery(ACB.REASON_RE, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, { id: "reason", target: Number(ctx.match![1]) });
  });

  panel.callbackQuery(ACB.AMOUNT_RE, async (ctx) => {
    const reason = ctx.match![2] as GrantReason;
    await ctx.answerCallbackQuery();
    // Экран сумм мог открыться после «Своей суммы» — ожидание снимается,
    // иначе следующее сообщение админа уйдёт в начисление, которого он не ждёт.
    await store.setAdminWait(ctx.chat!.id, "");
    await show(ctx, { id: "amount", target: Number(ctx.match![1]), reason });
  });

  panel.callbackQuery(ACB.CUSTOM_RE, async (ctx) => {
    const target = Number(ctx.match![1]);
    const reason = ctx.match![2] as GrantReason;
    await ctx.answerCallbackQuery({ text: t("admin.toast.askAmount") });
    await store.setAdminWait(ctx.chat!.id, `sum:${target}:${reason}`);
    await show(
      ctx,
      { id: "amount", target, reason },
      { notice: t("admin.notice.askAmount", { max: sparks(GRANT_MAX) }) }
    );
  });

  /** Единственная кнопка во всём боте, которая двигает чужой баланс. */
  panel.callbackQuery(ACB.APPLY_RE, async (ctx) => {
    const target = Number(ctx.match![1]);
    const reason = ctx.match![2] as GrantReason;
    const result = await moveSparks(ctx.chat!.id, target, reason, Number(ctx.match![3]));

    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: result.toast, show_alert: true });
      if (result.reload) await show(ctx, { id: "card", target });
      return;
    }

    await ctx.answerCallbackQuery({ text: result.toast });
    await show(ctx, { id: "card", target }, { notice: result.notice });
  });

  panel.on("message:text", onText);

  /**
   * Чужой человек с адресом админки. Ответить обязаны: без ответа на кнопке
   * вечно крутятся часики. Регистрируется после панели, поэтому админ сюда
   * не доходит.
   */
  bot.callbackQuery(/^adm:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: t("admin.toast.denied"), show_alert: true });
  });
}
