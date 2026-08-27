/**
 * Печатает все экраны и проверяет их по Definition of Done из CLAUDE.md.
 * Гоняется без сети, без KV и без поднятого бота: экран — чистая функция.
 *
 *   npm run screens
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import {
  GRANT_AMOUNTS,
  GRANT_REASONS,
  LEDGER_KEEP,
  MODELS,
  MODEL_ORDER,
  PACKS,
  PAY_METHOD_ORDER,
  TAKE_REASON,
  sparksOf,
} from "../src/config";
import { LOCALE, missingKeys, t } from "../src/i18n";
import * as admin from "../src/admin-screens";
import type { Fail, Op } from "../src/ledger";
import * as screens from "../src/screens";
import type { Screen } from "../src/screens";
import type { Dash } from "../src/stats";
import type { Person } from "../src/store";
import { ACB, CB, modelName, sparks } from "../src/ui";

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) {
    failed++;
    console.log(`   FAIL  ${label}`);
  }
}

const RICH = sparksOf(PACKS[1], "stars"); // 550 ✨ — искр хватает на любую модель

// ── Что печатаем ─────────────────────────────────────────────────────────────

interface Item {
  id: string;
  title: string;
  /** Корневой экран: «Назад» на нём быть не должно. */
  root?: boolean;
  /** Главное действие — не кнопка, а сообщение, которое человек сейчас напишет. */
  input?: boolean;
  screen: Screen;
}

const ALL: Item[] = [
  {
    id: "home",
    title: "Вход: баланс пуст",
    root: true,
    screen: screens.home({ balance: 0, name: "Слава" }),
  },
  {
    id: "home.paid",
    title: "Вход: искры уже куплены",
    root: true,
    screen: screens.home({
      balance: RICH,
      name: "Слава",
      notice: t("notice.paid", { added: sparks(RICH) }),
    }),
  },
  {
    id: "models",
    title: "Выбор модели: баланс пуст",
    screen: screens.models({ balance: 0 }),
  },
  {
    id: "models.paid",
    title: "Выбор модели: баланс в кадрах",
    screen: screens.models({ balance: RICH }),
  },
  {
    id: "model.nbpro",
    title: "Флагман, искр не хватает",
    screen: screens.model({ model: "nbpro", balance: 0 }),
  },
  {
    id: "model.gpt2",
    title: "Самая дешёвая, искр хватает",
    screen: screens.model({ model: "gpt2", balance: RICH }),
  },
  {
    id: "model.frame",
    title: "Под выданным кадром: сделать ещё",
    screen: screens.model({
      model: "nbpro",
      balance: RICH - MODELS.nbpro.price,
      notice: t("notice.frame", { price: sparks(MODELS.nbpro.price) }),
    }),
  },
  {
    id: "model.refund",
    title: "Кадр не получился",
    screen: screens.model({
      model: "nbpro",
      balance: RICH,
      notice: t("notice.refund", { amount: sparks(MODELS.nbpro.price) }),
    }),
  },
  {
    id: "upload",
    title: "Ждём селфи",
    input: true,
    screen: screens.upload({ model: "nb2", balance: RICH }),
  },
  {
    id: "prompt",
    title: "Два селфи приняты, ждём промпт",
    input: true,
    screen: screens.prompt({ model: "nb2", balance: RICH, photos: 2 }),
  },
  {
    id: "prompt.full",
    title: "Четыре селфи — больше не примем",
    input: true,
    screen: screens.prompt({ model: "nb2", balance: RICH, photos: 4 }),
  },
  {
    id: "describe",
    title: "Кадр с нуля, без фото",
    input: true,
    screen: screens.describe({ model: "sd5", balance: RICH }),
  },
  {
    id: "busy",
    title: "Идёт генерация",
    screen: screens.busy({
      model: "nbpro",
      balance: RICH - MODELS.nbpro.price,
      cost: MODELS.nbpro.price,
    }),
  },
  {
    id: "topup",
    title: "Способы оплаты",
    screen: screens.topup({ balance: 0, from: "nbpro" }),
  },
  {
    id: "packs.stars",
    title: "Пакеты за звёзды",
    screen: screens.packs({ method: "stars", balance: 0, from: "nbpro" }),
  },
  {
    id: "packs.sbp",
    title: "Пакеты за рубли",
    screen: screens.packs({ method: "sbp", balance: 0, from: "home" }),
  },
  {
    id: "packs.crypto",
    title: "Пакеты за крипту",
    screen: screens.packs({ method: "crypto", balance: 0, from: "models" }),
  },
  { id: "help", title: "Помощь", screen: screens.help() },
  { id: "earn", title: "Заработок (заморожен)", screen: screens.earn() },
];

// ── Админка ──────────────────────────────────────────────────────────────────
/**
 * Служебные экраны проверяются теми же правилами, что и продуктовые: лимит в
 * восемь кнопок, тридцать символов на лейбл и живой адрес за каждой кнопкой
 * ломаются одинаково, а чинить их в админке некому — туда никто не жалуется.
 *
 * Данные тут выдуманные, но по форме те же, что приходят из KV.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 24, 12, 0);

const SLAVA: Person = {
  chatId: 483920112,
  balance: 48,
  status: "paid",
  name: "Слава",
  username: "slavafan",
  model: "nb2",
  source: "photo",
  topupFrom: "nb2",
  fails: 1,
  createdAt: NOW - 96 * HOUR,
};

/** Без юзернейма и без имени: половина людей приходит именно такой. */
const ANON: Person = {
  chatId: 700100200,
  balance: 0,
  status: "started",
  name: "",
  username: "",
  model: null,
  source: null,
  topupFrom: "",
  fails: 0,
  createdAt: NOW - 3 * HOUR,
};

const DASH: Dash = {
  people: { start: 128, photos: 64, gen: 41, paid: 8 },
  money: {
    stars: 4200,
    netto: 54.6,
    rub: 4641,
    cost: 12.3,
    sold: 4620,
    spent: 3100,
    refunded: 240,
    granted: 180,
    taken: 20,
  },
  frames: { done: 288, failed: 12 },
  today: { start: 12, gen: 34, paid: 3, stars: 940 },
};

const OPS: Op[] = [
  { at: NOW - 2 * HOUR, delta: 550, kind: "buy", ref: "stars:2" },
  { at: NOW - 2 * HOUR + 60000, delta: -20, kind: "spend", ref: "Nano Banana Pro" },
  { at: NOW - HOUR, delta: 20, kind: "back", ref: "таймаут" },
  { at: NOW - HOUR + 60000, delta: 50, kind: "grant", ref: "bonus", by: 1 },
  { at: NOW - 30 * 60000, delta: -10, kind: "take", ref: "fix", by: 1 },
];

const FAILS: Fail[] = [
  { at: NOW - HOUR, chatId: SLAVA.chatId, model: "nbpro", cost: 20, reason: "таймаут", back: true },
  { at: NOW - 5 * HOUR, chatId: ANON.chatId, model: null, cost: 10, reason: "не запустился", back: false },
];

const ADMIN_ITEMS: Item[] = [
  {
    id: "admin",
    title: "Админка: дашборд",
    screen: admin.dashboard({ dash: DASH, users: 128, fails: 12 }),
  },
  {
    id: "admin.calm",
    title: "Админка: сбоев нет",
    screen: admin.dashboard({
      dash: { ...DASH, frames: { done: 288, failed: 0 } },
      users: 128,
      fails: 0,
    }),
  },
  {
    id: "admin.fails",
    title: "Лог сбоев",
    screen: admin.fails({
      rows: [
        { fail: FAILS[0], person: SLAVA },
        { fail: FAILS[1], person: ANON },
      ],
      people: [SLAVA, ANON],
      total: 12,
    }),
  },
  {
    id: "admin.fails.empty",
    title: "Лог сбоев: пусто",
    screen: admin.fails({ rows: [], people: [], total: 0 }),
  },
  {
    id: "admin.users",
    title: "Последние люди",
    screen: admin.users({ rows: [SLAVA, ANON], people: [SLAVA, ANON], total: 128 }),
  },
  {
    id: "admin.find",
    title: "Поиск человека",
    input: true,
    screen: admin.find(),
  },
  {
    id: "admin.card",
    title: "Карточка: сбой уже возмещён ботом",
    screen: admin.card({
      person: SLAVA,
      ops: OPS,
      opsTotal: LEDGER_KEEP,
      fails: [FAILS[0]],
      owed: 20,
      owedReturned: true,
      backTo: ACB.fails,
    }),
  },
  {
    id: "admin.card.owed",
    title: "Карточка: искры человеку не вернулись",
    screen: admin.card({
      person: ANON,
      ops: [],
      opsTotal: 0,
      fails: [FAILS[1]],
      owed: 10,
      owedReturned: false,
      backTo: ACB.users,
    }),
  },
  {
    id: "admin.reason",
    title: "За что начисляем",
    screen: admin.reason({ person: SLAVA, reasons: GRANT_REASONS }),
  },
  {
    id: "admin.amount",
    title: "Сколько начислить",
    screen: admin.amount({ person: SLAVA, reason: "fail", amounts: GRANT_AMOUNTS }),
  },
  {
    id: "admin.amount.take",
    title: "Сколько списать",
    screen: admin.amount({ person: SLAVA, reason: TAKE_REASON, amounts: GRANT_AMOUNTS }),
  },
];

ALL.push(...ADMIN_ITEMS);

// ── Проверки ─────────────────────────────────────────────────────────────────

const STYLED = new Set(["primary", "success", "danger"]);
/** Разметка, которую Telegram не рендерит: юзер увидит сами символы. */
const MARKDOWN = /^\s*(#{1,6}\s|[-*]\s|---\s*$)|\*\*/m;
const ALLOWED_TAGS = /^(b|i|u|s|a|code|pre|blockquote|tg-spoiler)$/;

/** Все живые адреса роутера. Кнопка, которая никуда не ведёт, — мёртвая кнопка. */
const ROUTES: (string | RegExp)[] = [
  CB.home,
  CB.models,
  CB.help,
  CB.earn,
  CB.genPhoto,
  CB.genText,
  CB.genReset,
  CB.MODEL_RE,
  CB.TOPUP_RE,
  CB.PAY_RE,
  CB.BUY_RE,
  ACB.home,
  ACB.fails,
  ACB.users,
  ACB.find,
  ACB.CARD_RE,
  ACB.REASON_RE,
  ACB.AMOUNT_RE,
  ACB.CUSTOM_RE,
  ACB.APPLY_RE,
];

function routed(data: string): boolean {
  return ROUTES.some((r) => (typeof r === "string" ? r === data : r.test(data)));
}

function rows(kb?: InlineKeyboard): InlineKeyboardButton[][] {
  return kb ? kb.inline_keyboard : [];
}

function audit(item: Item): void {
  const { id, screen } = item;
  const kb = rows(screen.reply_markup);
  const buttons = kb.flat();
  const lines = screen.text.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "";

  check(screen.text.length <= 4096, `${id}: текст ${screen.text.length} символов, лимит 4096`);
  check(!MARKDOWN.test(screen.text), `${id}: в тексте markdown, Telegram его не рендерит`);

  for (const tag of screen.text.matchAll(/<\/?([a-z-]+)[^>]*>/g)) {
    check(ALLOWED_TAGS.test(tag[1]), `${id}: тег <${tag[1]}> вне списка Telegram HTML`);
  }

  // Экран без клавиатуры (busy) — единственный, где мостик запрещён:
  // показывать ⌄ в пустоту нельзя.
  if (buttons.length === 0) {
    check(!last.endsWith("⌄"), `${id}: мостик ⌄ есть, а клавиатуры нет`);
    return;
  }

  check(last.endsWith("⌄"), `${id}: нет мостика ⌄ к клавиатуре (последняя строка: «${last}»)`);
  check(buttons.length <= 8, `${id}: кнопок ${buttons.length}, максимум 8`);
  // Пустой ряд получается сам собой там, где длина списка заранее неизвестна,
  // и на глаз он выглядит просто как лишний зазор между кнопками.
  check(
    kb.every((r) => r.length > 0),
    `${id}: в клавиатуре пустой ряд`
  );

  let primary = 0;
  let styled = 0;
  const seen = new Set<string>();
  for (const b of buttons) {
    check(b.text.length <= 30, `${id}: кнопка «${b.text}» — ${b.text.length} символов, лимит 30`);
    if (b.style === "primary") primary++;
    if (b.style && STYLED.has(b.style)) styled++;

    const data = (b as InlineKeyboardButton.CallbackButton).callback_data;
    if (data === undefined) continue;
    check(/^[\x21-\x7e]+$/.test(data), `${id}: callback_data «${data}» не латиница`);
    check(
      Buffer.byteLength(data, "utf8") <= 64,
      `${id}: callback_data «${data}» — ${Buffer.byteLength(data, "utf8")} байт, лимит 64`
    );
    check(routed(data), `${id}: кнопка «${b.text}» шлёт «${data}», а роутер такого не знает`);
    check(!seen.has(data), `${id}: две кнопки с одним callback_data «${data}»`);
    seen.add(data);
  }
  check(primary <= 2, `${id}: ${primary} синих кнопки, иерархия схлопывается`);
  // На экранах ввода главное действие — сообщение, а не кнопка: красить нечего.
  if (!item.input) {
    check(styled >= 1, `${id}: ни одного главного действия — нет ни primary, ни success`);
  } else {
    check(styled === 0, `${id}: цветная кнопка спорит с полем ввода за главное действие`);
  }

  const backs = buttons.filter((b) => b.text === t("button.back"));
  if (item.root) {
    check(backs.length === 0, `${id}: на корневом экране не должно быть «Назад»`);
  } else {
    const tail = kb[kb.length - 1];
    check(
      backs.length === 1 && tail.length === 1 && tail[0].text === t("button.back"),
      `${id}: «Назад» должен быть один и отдельным рядом в самом низу`
    );
    check(buttons.length > 1, `${id}: экран с одной только кнопкой «Назад» — тупик`);
  }
}

// ── Печать ───────────────────────────────────────────────────────────────────

const STYLE_MARK: Record<string, string> = { primary: "◆", success: "●", danger: "▲" };

for (const item of ALL) {
  const head = `── ${item.title} · ${item.id} `;
  console.log(`\n${head}${"─".repeat(Math.max(0, 74 - head.length))}`);
  console.log(item.screen.text);
  for (const row of rows(item.screen.reply_markup)) {
    console.log(
      "  " + row.map((b) => `[ ${STYLE_MARK[b.style ?? ""] ?? "·"} ${b.text} ]`).join(" ")
    );
  }
  audit(item);
}

// ── Сквозные проверки ────────────────────────────────────────────────────────

const modelsText = screens.models({ balance: 0 }).text;
for (const id of MODEL_ORDER) {
  check(modelsText.includes(modelName(id)), `models: модель ${id} не попала на экран`);
  check(
    modelsText.includes(sparks(MODELS[id].price)),
    `models: цена ${id} не видна до нажатия`
  );
}

// Ключевой факт (цена или баланс) стоит на каждом экране воронки.
for (const id of ["models", "model.nbpro", "upload", "prompt", "describe", "busy", "topup"]) {
  const text = ALL.find((s) => s.id === id)!.screen.text;
  check(/✨/.test(text), `${id}: экран воронки без цены и баланса`);
}

// Все четыре рельса рисуют один и тот же набор пакетов.
for (const m of PAY_METHOD_ORDER) {
  const kb = rows(screens.packs({ method: m, balance: 0, from: "home" }).reply_markup);
  check(kb.length === PACKS.length + 1, `packs.${m}: пакетов ${kb.length - 1}, а в конфиге ${PACKS.length}`);
}

console.log("\n── Тосты " + "─".repeat(66));
for (const key of ["soon", "needModel", "noPhotoModel", "reset", "error"]) {
  console.log(`  ${t(`toast.${key}`)}`);
}
console.log(`  ${t("toast.invoice", { price: "500 ⭐" })}`);
console.log(`  ${t("invoice.expired")}`);

console.log("\n── Тосты админки " + "─".repeat(58));
for (const key of ["noUser", "nothingToTake", "raced", "askAmount", "denied"]) {
  console.log(`  ${t(`admin.toast.${key}`)}`);
}
console.log(`  ${t("admin.toast.granted", { amount: "50 ✨" })}`);
console.log(`  ${t("admin.toast.taken", { amount: "50 ✨" })}`);

// Сообщение о начислении — единственное, что админка пишет человеку, и живёт
// оно в роутере. Промах по ключу увидели бы только на реальном начислении.
console.log("\n── Что получит человек " + "─".repeat(52));
console.log(
  t("admin.grant.message", { amount: "50 ✨", reason: t("admin.reason.fail.user") })
);

// Меню команд ставит set-webhook — отдельным процессом, где промах по ключу
// уже никто не увидит. Трогаем их здесь, чтобы промах всплыл тут.
console.log("\n── Меню команд " + "─".repeat(60));
for (const key of ["start", "balance", "new", "help", "admin"]) {
  console.log(`  /${key} — ${t(`command.${key}`)}`);
}

/**
 * Ключи, собранные из переменных: причины начисления и статусы человека.
 * Циклами их не обойти нигде, кроме этого места, — а без обхода отсутствующая
 * строка всплыла бы прямо посреди возврата денег.
 */
for (const reason of [...GRANT_REASONS, TAKE_REASON]) {
  for (const part of ["icon", "name", "about", "user"]) t(`admin.reason.${reason}.${part}`);
}
for (const status of ["started", "photos_ready", "paid"]) t(`admin.status.${status}`);
t("admin.fails.returned");
t("admin.fails.owed");

// ── Ключи, которых экраны не касаются ────────────────────────────────────────
/**
 * Тосты и разовые строки живут в роутере, и промах по ключу вылезал бы только
 * в тот момент, когда человек уже упёрся в ошибку. Поэтому все статические
 * `t("...")` из исходников трогаются здесь: несуществующий ключ валит прогон,
 * а не ждёт своего часа в проде.
 *
 * Собранные из переменных ключи (`model.${id}.pick`, `packs.${method}.title`)
 * сюда не попадают — их закрывают циклы выше.
 */
const sources = [
  ...readdirSync("src")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join("src", f)),
  join("scripts", "set-webhook.ts"),
];
let touched = 0;
for (const file of sources) {
  for (const m of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
    t(m[1]);
    touched++;
  }
}
console.log(`\nТронуто статических ключей локали: ${touched}`);

// Отсутствующий ключ не фолбэчится молча: прогон экранов на нём падает.
check(missingKeys.size === 0, `нет строк в ${LOCALE}: ${[...missingKeys].join(", ")}`);
console.log(
  failed === 0
    ? "\n◆ синяя · ● зелёная · · без стиля\nВсе экраны прошли Definition of Done."
    : `\nПровалено проверок: ${failed}`
);
process.exit(failed === 0 ? 0 : 1);
