/**
 * Прогон админки на заглушках KV и Telegram.
 *
 * Экраны проверяет `preview-screens.ts`, состояние — `check-state.ts`,
 * сценарий покупателя — `check-flow.ts`. Здесь проверяется то, чего не видно
 * ни там, ни там: что кнопка действительно двигает чужой баланс, что двойное
 * нажатие не двигает его дважды, что операция попадает в оба журнала и что
 * чужой человек до всего этого не доходит.
 *
 *   npx tsx scripts/check-admin.ts
 */
process.env.PUBLIC_URL = "https://example.test";
process.env.OWNER_CHAT_ID = "1";
process.env.ADMIN_IDS = "2";

import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { FakeRedis } from "./fake-redis";

const fake = new FakeRedis();
import { k } from "../src/keys";

/** Подмена модуля до того, как его затянут admin/flow/store. */
function stub(name: string, exports: unknown): void {
  const path = require.resolve(`../src/${name}`);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as any;
}

const counters: Record<string, number> = {};
stub("kv", {
  redis: fake,
  k,
  num: (v: unknown, f = 0) => (typeof v === "number" ? v : Number(v) || f),
  dayKey: () => "2026-08-24",
  bump: async (event: string, by = 1) => {
    counters[event] = (counters[event] ?? 0) + by;
  },
});

// ── Лента чата ───────────────────────────────────────────────────────────────

interface Msg {
  id: number;
  chat: number;
  text: string;
  buttons: { text: string; data: string }[];
}

const chat: Msg[] = [];
const toasts: string[] = [];
let nextId = 500;

function labels(markup: any): { text: string; data: string }[] {
  return (markup?.inline_keyboard ?? [])
    .flat()
    .map((b: any) => ({ text: b.text, data: b.callback_data ?? "" }));
}

/**
 * Реальный бот grammY с подменённым транспортом: роутинг, фильтры и разбор
 * коллбэков остаются настоящими, наружу не уходит ни одного запроса.
 */
const bot = new Bot("1:TEST");
bot.api.config.use(async (_prev, method: string, payload: any) => {
  const ok = (result: unknown) => ({ ok: true as const, result: result as any });

  switch (method) {
    case "getMe":
      return ok({ id: 7, is_bot: true, first_name: "OneSelfie", username: "test_bot" });
    case "sendMessage": {
      const msg: Msg = {
        id: nextId++,
        chat: Number(payload.chat_id),
        text: String(payload.text ?? ""),
        buttons: labels(payload.reply_markup),
      };
      chat.push(msg);
      return ok({ message_id: msg.id, date: 0, chat: { id: msg.chat, type: "private" } });
    }
    case "editMessageText": {
      const msg = chat.find((m) => m.id === Number(payload.message_id));
      if (!msg) return { ok: false as const, error_code: 400, description: "Bad Request: message to edit not found" };
      msg.text = String(payload.text ?? "");
      msg.buttons = labels(payload.reply_markup);
      return ok(true);
    }
    case "editMessageReplyMarkup": {
      const msg = chat.find((m) => m.id === Number(payload.message_id));
      if (msg) msg.buttons = [];
      return ok(true);
    }
    case "deleteMessage": {
      const i = chat.findIndex((m) => m.id === Number(payload.message_id));
      if (i >= 0) chat.splice(i, 1);
      return ok(true);
    }
    case "answerCallbackQuery":
      if (payload.text) toasts.push(String(payload.text));
      return ok(true);
    default:
      return ok(true);
  }
});

stub("telegram", { bot });
stub("kie", {
  uploadImage: async () => "https://kie.test/ref.jpg",
  createTask: async () => "task-1",
});

const S = require("../src/store") as typeof import("../src/store");
const L = require("../src/ledger") as typeof import("../src/ledger");
const A = require("../src/admin") as typeof import("../src/admin");

A.install(bot);

/** Сообщение админа, не съеденное панелью, обязано ехать дальше по цепочке. */
let passedThrough = 0;
bot.on("message:text", () => {
  passedThrough++;
});

// ── Апдейты ──────────────────────────────────────────────────────────────────

let updateId = 1;

function command(chatId: number, text: string): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: nextId++,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "Админ" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  } as unknown as Update;
}

function says(chatId: number, text: string): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: nextId++,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "Админ" },
      text,
    },
  } as unknown as Update;
}

function taps(chatId: number, data: string): Update {
  const screen = current(chatId);
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: chatId, is_bot: false, first_name: "Админ" },
      chat_instance: "ci",
      data,
      message: {
        message_id: screen?.id ?? 0,
        date: 0,
        chat: { id: chatId, type: "private" },
        text: screen?.text ?? "",
      },
    },
  } as unknown as Update;
}

/** Экран человека — последнее его сообщение с живой клавиатурой. */
function current(chatId: number): Msg | undefined {
  return [...chat].reverse().find((m) => m.chat === chatId && m.buttons.length > 0);
}

/** Нажать кнопку по куску её текста. Так проверяется то, что админ реально видит. */
async function press(chatId: number, label: string): Promise<void> {
  const screen = current(chatId);
  const button = screen?.buttons.find((b) => b.text.includes(label));
  if (!button) throw new Error(`нет кнопки «${label}» на экране: ${screen?.buttons.map((b) => b.text).join(" | ")}`);
  await bot.handleUpdate(taps(chatId, button.data));
}

function has(chatId: number, label: string): boolean {
  return Boolean(current(chatId)?.buttons.some((b) => b.text.includes(label)));
}

// ── Проверки ─────────────────────────────────────────────────────────────────

let failed = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failed++;
}

function show(step: string): void {
  console.log(`\n── ${step} ${"─".repeat(Math.max(0, 60 - step.length))}`);
  const screen = current(OWNER);
  console.log(`  ${screen?.text.split("\n")[0] ?? "<нет экрана>"}`);
  console.log(`  ${screen?.buttons.map((b) => b.text).join("  ") ?? ""}`);
}

const OWNER = 1;
const HELPER = 2;
const STRANGER = 9;
const USER = 483920112;

async function main(): Promise<void> {
  await bot.init();

  // Живой человек с историей: купил пакет, сделал кадр, кадр не вышел.
  await S.ensureUser(USER);
  await S.touchUser(USER, "Слава", "slavafan");
  await S.credit(USER, 550);
  await L.record(USER, "buy", 550, "stars:2");
  await S.trySpend(USER, 20);
  await L.record(USER, "spend", -20, "Nano Banana Pro");
  await S.credit(USER, 20);
  await L.record(USER, "back", 20, "таймаут");
  await L.logFail({
    at: Date.now(),
    chatId: USER,
    model: "nbpro",
    cost: 20,
    reason: "таймаут",
    back: true,
  });

  await bot.handleUpdate(command(OWNER, "/admin"));
  show("/admin");
  check(current(OWNER) !== undefined, "админка открылась владельцу");
  check(
    current(OWNER)!.text.includes("Воронка"),
    "на корне сразу дашборд, а не меню разделов"
  );

  await press(OWNER, "Сбои генераций");
  show("Лог сбоев");
  check(current(OWNER)!.text.includes("таймаут"), "сбой виден в логе");
  check(has(OWNER, "@slavafan"), "человек из сбоя — кнопкой");

  await press(OWNER, "@slavafan");
  show("Карточка");
  const card = current(OWNER)!;
  check(card.text.includes("550"), "в карточке видна оплата");
  check(card.text.includes("Nano Banana Pro"), "и списание за кадр");
  check(card.text.includes("Баланс: 550"), "и текущий баланс");
  check(has(OWNER, "20 ✨"), "быстрое начисление за сбой предложено");

  // Три нажатия от корня до денег: админка → сбои → карточка → кнопка.
  await press(OWNER, "20 ✨");
  show("Начислили за сбой");
  check((await S.getBalance(USER)) === 570, `начислено 20 ✨ (баланс ${await S.getBalance(USER)})`);
  check(counters.sparks_granted === 20, "счётчик ручных начислений вырос");
  check(!has(OWNER, "Ещё 20 ✨"), "кнопка исчезла — второй раз за тот же сбой не начислить");

  const ops = await L.history(USER, 50);
  check(ops[0].kind === "grant" && ops[0].delta === 20, "операция легла в историю человека");
  check(ops[0].by === OWNER, "и запомнила, кто именно начислил");
  check(ops[0].ref === "fail", "и за что");

  const grants = await L.recentGrants(10);
  check(grants.length === 1 && grants[0].admin === OWNER, "запись есть и в логе админов");
  check(grants[0].balance === 570, "лог помнит баланс после операции");

  check(
    chat.some((m) => m.chat === USER && m.text.includes("Начислил искры")),
    "человеку ушло сообщение о начислении"
  );

  // Списание: просим больше, чем есть, — в минус баланс не уходит.
  await press(OWNER, "Списать");
  show("Сколько списать");
  await press(OWNER, "500");
  const afterTake = await S.getBalance(USER);
  check(afterTake === 70, `списано ровно 500 ✨ (баланс ${afterTake})`);

  await press(OWNER, "Списать");
  await press(OWNER, "500");
  check((await S.getBalance(USER)) === 0, "второе списание забрало остаток, а не ушло в минус");
  check((await L.history(USER, 50))[0].kind === "take", "списание тоже попало в историю");
  check(
    !chat.some((m) => m.chat === USER && m.text.includes("Списал")),
    "про списание человеку не написали"
  );

  // Поиск по юзернейму: индекс собирается сам, метода у Bot API нет.
  const before = chat.filter((m) => m.chat === OWNER).length;
  await press(OWNER, "Назад");
  await press(OWNER, "Назад");
  await press(OWNER, "Найти человека");
  await bot.handleUpdate(says(OWNER, "@slavafan"));
  show("Нашли по юзернейму");
  check(current(OWNER)!.text.includes("483920112"), "карточка открылась по @username");
  check(
    chat.filter((m) => m.chat === OWNER).length === before,
    "экран переехал под сообщение, а не размножился"
  );

  // Юзернейм в Telegram можно сменить и отдать другому — индекс обязан это заметить.
  await S.touchUser(USER, "Слава", "newname");
  check((await S.findByUsername("slavafan")) === null, "старый юзернейм больше никого не открывает");
  check((await S.findByUsername("newname")) === USER, "новый — открывает");

  // Своя сумма.
  await press(OWNER, "Начислить");
  await press(OWNER, "Бонус");
  await press(OWNER, "Своя сумма");
  await bot.handleUpdate(says(OWNER, "137"));
  check((await S.getBalance(USER)) === 137, "своя сумма начислена");
  check((await L.history(USER, 50))[0].ref === "bonus", "и с причиной, которую выбрали");

  await press(OWNER, "Начислить");
  await press(OWNER, "Бонус");
  await press(OWNER, "Своя сумма");
  await bot.handleUpdate(says(OWNER, "999999"));
  check((await S.getBalance(USER)) === 137, "сумма выше потолка не прошла");
  check(current(OWNER)!.text.includes("⊗"), "и объяснила, что не так");

  // Второй админ из ADMIN_IDS видит то же самое.
  await bot.handleUpdate(command(HELPER, "/admin"));
  check(current(HELPER) !== undefined, "админ из ADMIN_IDS тоже заходит");

  // Чужой человек с адресом админки.
  const strangerBefore = chat.filter((m) => m.chat === STRANGER).length;
  await bot.handleUpdate(taps(STRANGER, "adm:home"));
  check(
    chat.filter((m) => m.chat === STRANGER).length === strangerBefore,
    "чужому админка не нарисовалась"
  );
  check(toasts[toasts.length - 1].includes("владельцу"), "и он получил внятный отказ");

  await bot.handleUpdate(says(STRANGER, "кот в скафандре"));
  check(passedThrough === 1, "промпт чужого человека уехал в обычный сценарий");

  // Админ вне режима ожидания — такой же покупатель.
  await bot.handleUpdate(says(OWNER, "кот в скафандре"));
  check(passedThrough === 2, "и промпт админа тоже, панель его не съела");

  console.log(failed === 0 ? "\nВсё сошлось." : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
