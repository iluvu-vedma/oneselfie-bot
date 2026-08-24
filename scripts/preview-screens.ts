/**
 * Печатает все экраны и проверяет их по Definition of Done из CLAUDE.md.
 * Гоняется без сети, без KV и без поднятого бота: экран — чистая функция.
 *
 *   npm run screens
 */
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { PACKAGES, SPARKS_PER_IMAGE } from "../src/config";
import { LOCALE, missingKeys, t } from "../src/i18n";
import * as screens from "../src/screens";
import type { Screen } from "../src/screens";
import { sparks } from "../src/ui";

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) {
    failed++;
    console.log(`   FAIL  ${label}`);
  }
}

// ── Что печатаем ─────────────────────────────────────────────────────────────

const ALL: { id: string; title: string; root?: boolean; screen: Screen }[] = [
  {
    id: "home.start",
    title: "Вход: селфи нет, баланс пуст",
    root: true,
    screen: screens.home({ stage: "start", balance: 0, photos: 0, name: "Слава" }),
  },
  {
    id: "home.start.paid",
    title: "Вход: искры уже куплены, селфи нет",
    root: true,
    screen: screens.home({
      stage: "start",
      balance: PACKAGES.set.sparks,
      photos: 0,
      name: "Слава",
      notice: t("home.notice.reset"),
    }),
  },
  {
    id: "home.need",
    title: "Селфи есть, искр не хватает",
    root: true,
    screen: screens.home({ stage: "need", balance: 0, photos: 2 }),
  },
  {
    id: "home.ready",
    title: "Всё готово",
    root: true,
    screen: screens.home({ stage: "ready", balance: PACKAGES.set.sparks, photos: 4 }),
  },
  {
    id: "home.busy",
    title: "Идёт генерация",
    root: true,
    screen: screens.home({
      stage: "busy",
      balance: PACKAGES.set.sparks - SPARKS_PER_IMAGE,
      photos: 4,
    }),
  },
  {
    id: "home.paid",
    title: "После оплаты",
    root: true,
    screen: screens.home({
      stage: "ready",
      balance: PACKAGES.set.sparks,
      photos: 3,
      notice: t("home.notice.paid", { added: sparks(PACKAGES.set.sparks) }),
    }),
  },
  {
    id: "home.frame",
    title: "Под выданным кадром",
    root: true,
    screen: screens.home({
      stage: "ready",
      balance: PACKAGES.set.sparks - SPARKS_PER_IMAGE,
      photos: 3,
      notice: t("home.notice.frame", { price: sparks(SPARKS_PER_IMAGE) }),
    }),
  },
  {
    id: "home.refund",
    title: "Кадр не получился",
    root: true,
    screen: screens.home({
      stage: "ready",
      balance: PACKAGES.set.sparks,
      photos: 3,
      notice: t("home.notice.refund", { amount: sparks(SPARKS_PER_IMAGE) }),
    }),
  },
  {
    id: "home.repeatedFails",
    title: "Три неудачи подряд",
    root: true,
    screen: screens.home({
      stage: "need",
      balance: 0,
      photos: 3,
      notice: t("home.notice.repeatedFails"),
    }),
  },
  {
    id: "home.notAPhoto",
    title: "Прислали не фото",
    root: true,
    screen: screens.home({
      stage: "start",
      balance: 0,
      photos: 0,
      name: "Слава",
      notice: t("home.notice.notAPhoto"),
    }),
  },
  {
    id: "home.photoEnough",
    title: "Пятое селфи",
    root: true,
    screen: screens.home({
      stage: "need",
      balance: 0,
      photos: 4,
      notice: t("home.notice.photoEnough"),
    }),
  },
  {
    id: "paywall",
    title: "Пакеты",
    screen: screens.paywall(0),
  },
];

// ── Проверки ─────────────────────────────────────────────────────────────────

const STYLED = new Set(["primary", "success", "danger"]);
/** Разметка, которую Telegram не рендерит: юзер увидит сами символы. */
const MARKDOWN = /^\s*(#{1,6}\s|[-*]\s|---\s*$)|\*\*/m;
const ALLOWED_TAGS = /^(b|i|u|s|a|code|pre|blockquote|tg-spoiler)$/;

function rows(kb?: InlineKeyboard): InlineKeyboardButton[][] {
  return kb ? kb.inline_keyboard : [];
}

function audit(id: string, root: boolean, screen: Screen): void {
  const kb = rows(screen.reply_markup);
  const buttons = kb.flat();
  const lines = screen.text.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "";

  check(screen.text.length <= 4096, `${id}: текст ${screen.text.length} символов, лимит 4096`);
  check(!MARKDOWN.test(screen.text), `${id}: в тексте markdown, Telegram его не рендерит`);

  for (const tag of screen.text.matchAll(/<\/?([a-z-]+)[^>]*>/g)) {
    check(ALLOWED_TAGS.test(tag[1]), `${id}: тег <${tag[1]}> вне списка Telegram HTML`);
  }

  if (buttons.length === 0) return;

  check(last.endsWith("⌄"), `${id}: нет мостика ⌄ к клавиатуре (последняя строка: «${last}»)`);
  check(buttons.length <= 8, `${id}: кнопок ${buttons.length}, максимум 8`);

  let primary = 0;
  let styled = 0;
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
  }
  check(primary <= 2, `${id}: ${primary} синих кнопки, иерархия схлопывается`);
  check(styled >= 1, `${id}: ни одного главного действия — нет ни primary, ни success`);

  const backs = buttons.filter((b) => b.text.includes(t("button.back")));
  if (root) {
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

for (const { id, title, root, screen } of ALL) {
  const head = `── ${title} · ${id} `;
  console.log(`\n${head}${"─".repeat(Math.max(0, 74 - head.length))}`);
  console.log(screen.text);
  for (const row of rows(screen.reply_markup)) {
    console.log(
      "  " + row.map((b) => `[ ${STYLE_MARK[b.style ?? ""] ?? "·"} ${b.text} ]`).join(" ")
    );
  }
  audit(id, Boolean(root), screen);
}

console.log("\n── Тосты " + "─".repeat(66));
for (const key of ["busy", "needPhotos", "invoice", "reset", "error"]) {
  console.log(`  ${t(`toast.${key}`, { stars: 170, amount: sparks(12) })}`);
}
console.log(`  ${t("toast.needSparks", { amount: sparks(SPARKS_PER_IMAGE) })}`);
console.log(`  ${t("invoice.expired")}`);

// Отсутствующий ключ не фолбэчится молча: прогон экранов на нём падает.
check(missingKeys.size === 0, `нет строк в ${LOCALE}: ${[...missingKeys].join(", ")}`);
console.log(
  failed === 0
    ? "\n◆ синяя · ● зелёная · · без стиля\nВсе экраны прошли Definition of Done."
    : `\nПровалено проверок: ${failed}`
);
process.exit(failed === 0 ? 0 : 1);
