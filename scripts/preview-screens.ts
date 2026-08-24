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
import { MODELS, MODEL_ORDER, PACKS, PAY_METHOD_ORDER, sparksOf } from "../src/config";
import { LOCALE, missingKeys, t } from "../src/i18n";
import * as screens from "../src/screens";
import type { Screen } from "../src/screens";
import { CB, modelName, sparks } from "../src/ui";

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
for (const key of ["soon", "needModel", "noPhotoModel", "busy", "reset", "error"]) {
  console.log(`  ${t(`toast.${key}`)}`);
}
console.log(`  ${t("toast.needSparks", { amount: sparks(MODELS.nbpro.price) })}`);
console.log(`  ${t("toast.invoice", { price: "500 ⭐" })}`);
console.log(`  ${t("invoice.expired")}`);

// Меню команд ставит set-webhook — отдельным процессом, где промах по ключу
// уже никто не увидит. Трогаем их здесь, чтобы промах всплыл тут.
console.log("\n── Меню команд " + "─".repeat(60));
for (const key of ["start", "balance", "new", "help"]) {
  console.log(`  /${key} — ${t(`command.${key}`)}`);
}

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
