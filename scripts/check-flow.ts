/**
 * Прогон всего сценария на заглушках KV, Telegram и kie.
 * Проверяет главное свойство навигации: чат не растёт.
 *
 * Экраны проверяются в `preview-screens.ts`, состояние — в `check-state.ts`.
 * Здесь проверяется то, чего не видно ни там, ни там: сколько сообщений
 * остаётся в ленте после каждого шага и где именно стоит рабочий экран.
 */
process.env.PUBLIC_URL = "https://example.test";

import { GrammyError } from "grammy";
import { FakeRedis } from "./fake-redis";

/**
 * Отказ Telegram именно в том виде, в каком его разбирает hub.ts.
 * Обычный Error здесь врал бы: `isGone` смотрит на GrammyError и на описание.
 */
function telegramError(description: string, method: string): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: 400, description },
    method,
    {}
  );
}

const fake = new FakeRedis();
const k = {
  user: (id: any) => `user:${id}`,
  balance: (id: any) => `bal:${id}`,
  photos: (id: any) => `photos:${id}`,
  photoSlots: (id: any) => `photoslots:${id}`,
  genLock: (id: any) => `gen:${id}`,
  hub: (id: any) => `hub:${id}`,
  task: (id: string) => `task:${id}`,
  payment: (id: string) => `pay:${id}`,
  pending: "pending",
  stat: (e: string) => `stat:${e}`,
};

/** Подмена модуля до того, как его затянут flow/deliver. */
function stub(name: string, exports: unknown): void {
  const path = require.resolve(`../src/${name}`);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as any;
}

stub("kv", {
  redis: fake,
  k,
  num: (v: unknown, f = 0) => (typeof v === "number" ? v : Number(v) || f),
  bump: async () => {},
});

// ── Лента чата ───────────────────────────────────────────────────────────────

interface Msg {
  id: number;
  kind: "text" | "photo";
  text: string;
  buttons: string[];
}

const chat: Msg[] = [];
let nextId = 100;

function labels(markup: any): string[] {
  return (markup?.inline_keyboard ?? [])
    .flat()
    .map((b: any) => `[${b.style?.[0] ?? " "}] ${b.text}`);
}

/** Ровно те методы Telegram, которыми пользуется бот. Больше ему ничего не нужно. */
const api = {
  async sendMessage(_chat: number, text: string, o: any = {}) {
    const m: Msg = { id: nextId++, kind: "text", text, buttons: labels(o.reply_markup) };
    chat.push(m);
    return { message_id: m.id };
  },
  async editMessageText(_chat: number, id: number, text: string, o: any = {}) {
    const m = chat.find((x) => x.id === id);
    if (!m) throw telegramError("Bad Request: message to edit not found", "editMessageText");
    m.text = text;
    m.buttons = labels(o.reply_markup);
    return true;
  },
  async editMessageReplyMarkup(_chat: number, id: number) {
    const m = chat.find((x) => x.id === id);
    if (m) m.buttons = [];
    return true;
  },
  async deleteMessage(_chat: number, id: number) {
    const i = chat.findIndex((x) => x.id === id);
    if (i >= 0) chat.splice(i, 1);
    return true;
  },
  async sendPhoto(_chat: number, _file: unknown, o: any = {}) {
    const m: Msg = {
      id: nextId++,
      kind: "photo",
      text: o.caption ?? "",
      buttons: labels(o.reply_markup),
    };
    chat.push(m);
    return { message_id: m.id };
  },
  async sendChatAction() {
    return true;
  },
};

stub("telegram", { bot: { api } });
stub("owner", { notifyOwner: async () => {}, isOwner: () => false });

let kieDown = false;
let taskCounter = 0;
stub("kie", {
  uploadImage: async () => "https://kie.test/ref.jpg",
  createTask: async () => {
    if (kieDown) throw new Error("kie 500");
    return `task-${++taskCounter}`;
  },
});

const S = require("../src/store") as typeof import("../src/store");
const F = require("../src/flow") as typeof import("../src/flow");
const D = require("../src/deliver") as typeof import("../src/deliver");
const { t } = require("../src/i18n") as typeof import("../src/i18n");

// ── Проверки ─────────────────────────────────────────────────────────────────

let failed = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failed++;
}

function show(step: string): void {
  console.log(`\n── ${step} ${"─".repeat(Math.max(0, 60 - step.length))}`);
  for (const m of chat) {
    console.log(`  #${m.id} ${m.kind === "photo" ? "<кадр>" : m.text.split("\n")[0]}`);
    if (m.buttons.length) console.log(`       ${m.buttons.join("  ")}`);
  }
}

/** Сообщений с живой клавиатурой должно быть не больше одного — это и есть «один экран». */
function screens(): Msg[] {
  return chat.filter((m) => m.buttons.length > 0);
}

const CHAT = 777;

async function main(): Promise<void> {
  await S.ensureUser(CHAT);
  await S.setName(CHAT, "Слава");

  await F.moveHome(CHAT);
  show("/start");
  check(chat.length === 1, "после /start в ленте одно сообщение");

  // Альбом из четырёх селфи: каждое перерисовывает экран, а не плодит новые.
  for (let i = 0; i < 4; i++) {
    await S.reservePhotoSlot(CHAT);
    await S.addPhotoUrl(CHAT, `https://kie.test/${i}.jpg`);
    await F.moveHome(CHAT);
  }
  show("Четыре селфи");
  check(chat.length === 1, "четыре селфи не оставили четырёх экранов");
  check(screens().length === 1, "рабочий экран ровно один");

  await F.drawPaywall(CHAT);
  show("Пейволл");
  check(chat.length === 1, "пейволл открылся в том же сообщении");
  check(chat[0].buttons.length === 4, "три пакета и «Назад»");

  await S.credit(CHAT, 180);
  await F.moveHome(CHAT, { notice: t("home.notice.paid", { added: "180 ✨" }) });
  show("Оплата прошла");
  check(chat.length === 1, "после оплаты по-прежнему одно сообщение");

  await F.startGeneration(CHAT);
  show("Нажали «Сделать кадр»");
  check(chat.length === 1, "экран «идёт работа» перерисован, а не отправлен");
  check(chat[0].buttons.length === 0, "во время генерации нажимать нечего");
  check((await S.getBalance(CHAT)) === 168, "списано ровно 12 ✨");

  await F.startGeneration(CHAT);
  check((await S.getBalance(CHAT)) === 168, "двойной тап не списал второй раз");
  check(chat.length === 1, "двойной тап не добавил сообщений");

  await D.deliverTask("task-1", (await S.getTask("task-1"))!, "https://kie.test/out.jpg");
  show("Кадр выдан");
  check(chat.length === 2, "кадр — отдельный объект, экран переехал под него");
  check(chat[0].kind === "photo", "кадр выше экрана");
  check(screens().length === 1, "у кадра своей клавиатуры нет");
  check(chat[1].buttons.length === 3, "под кадром снова рабочий экран");

  await F.startGeneration(CHAT);
  await D.refundTask("task-2", (await S.getTask("task-2"))!, "тест");
  show("Кадр провалился");
  check((await S.getBalance(CHAT)) === 168, "искры вернулись");
  check(chat.length === 2, "возврат не добавил сообщений в ленту");
  check(chat[1].text.startsWith("⊗"), "возврат виден первой строкой экрана");
  check((await S.isGenerating(CHAT)) === false, "замок отпущен");

  kieDown = true;
  await F.startGeneration(CHAT);
  show("kie недоступен");
  check((await S.getBalance(CHAT)) === 168, "искры не пропали");
  check(chat.length === 2, "и здесь лента не выросла");
  check((await S.isGenerating(CHAT)) === false, "замок отпущен и после отказа kie");

  // Экран удалили руками: правка падает, бот молча присылает новый экран.
  kieDown = false;
  chat.length = 0;
  await F.drawHome(CHAT);
  show("Экран удалили руками");
  check(chat.length === 1, "экран восстановился новым сообщением");
  check(screens().length === 1, "и он рабочий");

  console.log(failed === 0 ? "\nВсё сошлось." : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
