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
import { k } from "../src/keys";

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
const kieCalls: { model: string; prompt: string; images: number }[] = [];
// Состояние задачи глазами kie, когда бот спрашивает сам (коллбэк не дошёл).
let recordCalls = 0;
let recordState: "generating" | "success" | "fail" = "generating";
stub("kie", {
  uploadImage: async () => "https://kie.test/ref.jpg",
  createTask: async (model: string, prompt: string, images: string[]) => {
    if (kieDown) throw new Error("kie 500");
    kieCalls.push({ model, prompt, images: images.length });
    return `task-${++taskCounter}`;
  },
  recordInfo: async () => {
    recordCalls++;
    return recordState === "success"
      ? { state: "success", urls: ["https://kie.test/late.jpg"] }
      : { state: recordState, urls: [], failMsg: "модель отказалась" };
  },
});

const S = require("../src/store") as typeof import("../src/store");
const F = require("../src/flow") as typeof import("../src/flow");
const D = require("../src/deliver") as typeof import("../src/deliver");
const { MODELS, SWEEP_AFTER_SEC, TIMEOUT_SEC } =
  require("../src/config") as typeof import("../src/config");
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
const PRICE = MODELS.nbpro.price; // 20

async function main(): Promise<void> {
  await S.ensureUser(CHAT);
  await S.touchUser(CHAT, "Слава", "slavafan");

  await F.move(CHAT, { id: "home" });
  show("/start");
  check(chat.length === 1, "после /start в ленте одно сообщение");

  await F.draw(CHAT, { id: "models" });
  await S.setModel(CHAT, "nbpro");
  await F.draw(CHAT, { id: "model", model: "nbpro" });
  show("Выбрали Nano Banana Pro");
  check(chat.length === 1, "выбор модели прошёл в том же сообщении");
  check(
    chat[0].text.includes("Nano Banana Pro") && chat[0].text.includes("20 ✨"),
    "модель и цена кадра видны на экране"
  );
  check(
    chat[0].buttons.some((b) => b.includes("Пополнить")),
    "искр не хватает — пополнение показано"
  );

  await S.setSource(CHAT, "photo");
  await F.draw(CHAT, { id: "upload" });
  show("Использовать моё фото");
  check(chat.length === 1, "экран загрузки — то же сообщение");

  // Альбом из четырёх селфи: каждое перерисовывает экран, а не плодит новые.
  for (let i = 0; i < 4; i++) {
    await S.reservePhotoSlot(CHAT);
    await S.addPhotoUrl(CHAT, `https://kie.test/${i}.jpg`);
    await F.move(CHAT, { id: "prompt" });
  }
  show("Четыре селфи");
  check(chat.length === 1, "четыре селфи не оставили четырёх экранов");
  check(screens().length === 1, "рабочий экран ровно один");

  // Промпт при пустом балансе: искры не спишутся, человек уедет в пополнение.
  await F.startGeneration(CHAT, "на крыше в вечернем городе");
  show("Промпт без искр");
  check(chat.length === 1, "нехватка искр не добавила сообщений");
  check((await S.isGenerating(CHAT)) === false, "замок не остался висеть");
  check(
    chat[0].buttons.some((b) => b.includes("Звёзды")),
    "показан экран пополнения со способами оплаты"
  );

  await F.draw(CHAT, { id: "packs", method: "stars", from: "nbpro" });
  show("Пакеты за звёзды");
  check(chat.length === 1, "пакеты открылись в том же сообщении");
  check(chat[0].buttons.length === 5, "четыре пакета и «Назад»");
  check(
    chat[0].buttons[chat[0].buttons.length - 1].includes("Назад"),
    "«Назад» — последней кнопкой"
  );

  // Оплата: чек уже в ленте, экран переезжает под него — и туда, откуда ушли платить.
  await S.credit(CHAT, 550);
  await F.move(CHAT, await F.originRef(CHAT), { notice: t("notice.paid", { added: "550 ✨" }) });
  show("Оплата прошла");
  check(chat.length === 1, "после оплаты по-прежнему одно сообщение");
  check(
    chat[0].text.includes("Nano Banana Pro"),
    "после оплаты человек вернулся на экран своей модели, а не на корень"
  );
  check(
    !chat[0].buttons.some((b) => b.includes("Пополнить")),
    "искр хватает — пополнение с экрана модели ушло"
  );

  await F.startGeneration(CHAT, "на крыше в вечернем городе");
  show("Прислали промпт");
  check(chat.length === 1, "экран «идёт работа» перерисован, а не отправлен");
  check(chat[0].buttons.length === 0, "во время генерации нажимать нечего");
  check((await S.getBalance(CHAT)) === 550 - PRICE, `списано ровно ${PRICE} ✨`);
  check(kieCalls[0].model === "nbpro", "в kie ушла выбранная модель");
  check(kieCalls[0].images === 4, "в kie ушли все четыре селфи");
  check(
    kieCalls[0].prompt.includes("на крыше в вечернем городе"),
    "промпт человека дошёл до модели"
  );

  await F.startGeneration(CHAT, "ещё один кадр");
  check((await S.getBalance(CHAT)) === 550 - PRICE, "второй промпт подряд не списал второй раз");
  check(chat.length === 1, "и не добавил сообщений");

  await D.deliverTask("task-1", (await S.getTask("task-1"))!, "https://kie.test/out.jpg");
  show("Кадр выдан");
  check(chat.length === 2, "кадр — отдельный объект, экран переехал под него");
  check(chat[0].kind === "photo", "кадр выше экрана");
  check(chat[0].text.includes("<code>"), "промпт лежит под кадром — можно повторить");
  check(screens().length === 1, "у кадра своей клавиатуры нет");
  check(chat[1].text.includes("Nano Banana Pro"), "под кадром экран той же модели: повтор в 1 тап");

  await F.startGeneration(CHAT, "второй кадр");
  await D.refundTask("task-2", (await S.getTask("task-2"))!, "тест");
  show("Кадр провалился");
  check((await S.getBalance(CHAT)) === 550 - PRICE, "искры вернулись");
  check(chat.length === 2, "возврат не добавил сообщений в ленту");
  check(chat[1].text.startsWith("⊗"), "возврат виден первой строкой экрана");
  check((await S.isGenerating(CHAT)) === false, "замок отпущен");

  kieDown = true;
  await F.startGeneration(CHAT, "третий кадр");
  show("kie недоступен");
  check((await S.getBalance(CHAT)) === 550 - PRICE, "искры не пропали");
  check(chat.length === 2, "и здесь лента не выросла");
  check((await S.isGenerating(CHAT)) === false, "замок отпущен и после отказа kie");

  // Режим «словами»: фото остались в состоянии, но в kie не уходят.
  kieDown = false;
  await S.setSource(CHAT, "text");
  await F.startGeneration(CHAT, "рыжий кот в скафандре на луне");
  const last = kieCalls[kieCalls.length - 1];
  check(last.images === 0, "в режиме «словами» селфи в kie не уходят");
  check(last.prompt === "рыжий кот в скафандре на луне", "промпт уходит без преамбулы про лицо");
  await D.refundTask(`task-${taskCounter}`, (await S.getTask(`task-${taskCounter}`))!, "сброс");

  // ── Коллбэк kie не дошёл ───────────────────────────────────────────────────
  // Худший из реальных сценариев: искры списаны, kie кадр нарисовал, а вебхук
  // потерялся. Крон на бесплатном Vercel придёт только ночью — значит забрать
  // кадр обязано следующее действие самого человека.
  await S.setSource(CHAT, "photo");
  const balanceBeforeLost = await S.getBalance(CHAT);
  recordState = "generating";
  await F.startGeneration(CHAT, "кадр без коллбэка");
  const lost = `task-${taskCounter}`;

  await D.catchUp(CHAT);
  check(recordCalls === 0, "сразу после старта kie не дёргаем: коллбэк ещё в пути");

  // Прошло полторы минуты, коллбэка нет, а кадр у kie давно готов.
  await fake.hset(k.task(lost), { createdAt: Date.now() - (SWEEP_AFTER_SEC + 5) * 1000 });
  recordState = "success";
  await D.catchUp(CHAT);
  show("Коллбэк не дошёл, человек вернулся в бот");
  check(recordCalls === 1, "спросили у kie ровно один раз");
  check(chat[0].kind === "photo", "кадр всё-таки выдан");
  check(screens().length === 1, "и экран по-прежнему один");
  check(
    (await S.getBalance(CHAT)) === balanceBeforeLost - PRICE,
    "искры не вернулись: кадр приехал, возвращать нечего"
  );
  check((await S.isGenerating(CHAT)) === false, "замок отпущен");

  await D.catchUp(CHAT);
  check(recordCalls === 1, "выданный кадр второй раз у kie не спрашивается");

  // Тот же добор, но кадр не приедет никогда: искры возвращаются без крона.
  const balanceBeforeDead = await S.getBalance(CHAT);
  recordState = "generating";
  await F.startGeneration(CHAT, "кадр, которого не будет");
  await fake.hset(k.task(`task-${taskCounter}`), {
    createdAt: Date.now() - (TIMEOUT_SEC + 5) * 1000,
  });
  await D.catchUp(CHAT);
  show("Кадр не приехал за таймаут");
  check((await S.getBalance(CHAT)) === balanceBeforeDead, "просроченный кадр вернул искры");
  check(recordCalls === 1, "просроченную задачу у kie не спрашиваем — сразу возврат");
  check((await S.isGenerating(CHAT)) === false, "и замок отпущен");

  // Экран удалили руками: правка падает, бот молча присылает новый экран.
  chat.length = 0;
  await F.draw(CHAT, { id: "model", model: "nbpro" });
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
