import { Context, GrammyError, HttpError } from "grammy";
import {
  BOT_TOKEN,
  EXAMPLE_IMAGE_URL,
  MAX_PHOTOS,
  PACKAGES,
  PackageId,
  SPARKS_PER_IMAGE,
} from "./config";
import {
  drawHomeHere,
  drawPaywallHere,
  moveHome,
  startGeneration,
} from "./flow";
import { adopt, isNotModified } from "./hub";
import { num, t } from "./i18n";
import { bump } from "./kv";
import { uploadImage } from "./kie";
import { isOwner, notifyOwner } from "./owner";
import { buildStats } from "./stats";
import { bot } from "./telegram";
import {
  addPhotoUrl,
  claimPayment,
  clearPhotos,
  credit,
  ensureUser,
  getBalance,
  isGenerating,
  markPhotosReady,
  photoCount,
  releasePhotoSlot,
  reservePhotoSlot,
  setName,
  setStatus,
} from "./store";
import { CB, sparks, sparksNamed } from "./ui";

export { bot };

/**
 * Роутер экранов. Каждая кнопка правит то самое сообщение, на котором стоит,
 * — новых сообщений от нажатий не появляется.
 *
 * Новое сообщение отправляется ровно в четырёх местах: картинка-пример при
 * первом старте, счёт Telegram, готовый кадр и статистика владельца. После
 * каждого из них экран переезжает вниз.
 */

// ── Команды ──────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  const isNew = await ensureUser(chatId);
  await remember(ctx);
  await bump("start");

  // Сетка примеров — отдельный объект в ленте и только один раз: это подарок
  // на входе, а не экран. Повторный /start ничего не сбрасывает и не дарит снова.
  if (isNew && EXAMPLE_IMAGE_URL) {
    await ctx.replyWithPhoto(EXAMPLE_IMAGE_URL).catch((e) => {
      console.error("example image failed", e);
    });
  }
  await moveHome(chatId);
});

bot.command("balance", async (ctx) => {
  await ensureUser(ctx.chat.id);
  await remember(ctx);
  await moveHome(ctx.chat.id);
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);
  await clearPhotos(chatId); // баланс искр сохраняется — он привязан к человеку
  await moveHome(chatId, { notice: t("home.notice.reset") });
});

bot.command("stats", async (ctx) => {
  if (!isOwner(ctx.chat.id)) return;
  await ctx.reply(await buildStats(), { parse_mode: "HTML" });
});

// ── Селфи ────────────────────────────────────────────────────────────────────
/**
 * Отдельного шага «Готово» нет: одного селфи уже достаточно, а экран после
 * каждого фото сам переезжает вниз в новом состоянии. Это на одно нажатие
 * короче и не даёт человеку зависнуть на кнопке, которая ничего не решает.
 */
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);

  const slot = await reservePhotoSlot(chatId);
  if (slot === null) {
    return moveHome(chatId, { notice: t("home.notice.photoEnough") });
  }

  try {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    const bytes = await downloadTelegramFile(largest.file_id);
    const url = await uploadImage(bytes, `${chatId}-${Date.now()}-${slot}.jpg`);
    await addPhotoUrl(chatId, url);
  } catch (e) {
    await releasePhotoSlot(chatId);
    await notifyOwner(`Загрузка селфи упала у ${chatId}: ${String(e)}`);
    return moveHome(chatId, { notice: t("home.notice.photoFailed") });
  }

  if (await markPhotosReady(chatId)) await bump("photos_uploaded");
  await moveHome(chatId);
});

/**
 * Байты селфи забираются нашим сервером и уходят в kie уже как загруженный файл.
 * Прямую ссылку Telegram отдавать нельзя — в её пути лежит токен бота.
 */
async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("getFile: нет file_path");
  const res = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
  );
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Навигация ────────────────────────────────────────────────────────────────

bot.callbackQuery(CB.home, async (ctx) => {
  await ctx.answerCallbackQuery();
  await drawHomeHere(ctx);
});

bot.callbackQuery(CB.paywall, async (ctx) => {
  await ctx.answerCallbackQuery();
  await drawPaywallHere(ctx);
});

bot.callbackQuery(CB.reset, async (ctx) => {
  await ctx.answerCallbackQuery({ text: t("toast.reset") });
  await clearPhotos(ctx.chat!.id);
  await drawHomeHere(ctx, { notice: t("home.notice.reset") });
});

// ── Кадр ─────────────────────────────────────────────────────────────────────
/**
 * Все отказы — тостом, а не экраном: они ничего не меняют в состоянии,
 * и перерисовывать ради них нечего.
 */
bot.callbackQuery(CB.generate, async (ctx) => {
  const chatId = ctx.chat!.id;
  const [photos, balance, busy] = await Promise.all([
    photoCount(chatId),
    getBalance(chatId),
    isGenerating(chatId),
  ]);

  if (photos === 0) {
    await ctx.answerCallbackQuery({ text: t("toast.needPhotos"), show_alert: true });
    return drawHomeHere(ctx);
  }
  if (busy) {
    await ctx.answerCallbackQuery({ text: t("toast.busy"), show_alert: true });
    return drawHomeHere(ctx);
  }
  if (balance < SPARKS_PER_IMAGE) {
    await ctx.answerCallbackQuery({
      text: t("toast.needSparks", { amount: sparks(SPARKS_PER_IMAGE - balance) }),
      show_alert: true,
    });
    return drawPaywallHere(ctx);
  }

  await ctx.answerCallbackQuery();
  // Рисовать будет startGeneration — ему нужно знать, какое сообщение править.
  await adopt(ctx);
  await startGeneration(chatId);
});

// ── Оплата ───────────────────────────────────────────────────────────────────
/**
 * Счёт — отдельный объект в ленте: он свой у Telegram, и внутрь экрана его не
 * положить. Экран остаётся на месте: если человек передумает, пакеты рядом.
 */
bot.callbackQuery(CB.BUY_RE, async (ctx) => {
  const id = ctx.match![1] as PackageId;
  const p = PACKAGES[id];
  await ctx.answerCallbackQuery({ text: t("toast.invoice", { stars: num(p.stars) }) });
  await ctx.api.sendInvoice(
    ctx.chat!.id,
    t("invoice.title", { title: p.title }),
    t("invoice.description", {
      sparksNamed: sparksNamed(p.sparks),
      price: sparks(SPARKS_PER_IMAGE),
    }),
    p.id, // payload: число искр берётся из константы по этому id
    "XTR",
    [{ label: p.title, amount: p.stars }]
  );
});

bot.on("pre_checkout_query", async (ctx) => {
  const ok = Boolean(findPackage(ctx.preCheckoutQuery.invoice_payload));
  await ctx.answerPreCheckoutQuery(ok, ok ? undefined : t("invoice.expired"));
});

/** Только собственные ключи: "toString" в payload не должен пройти как пакет. */
function findPackage(payload: string) {
  return Object.prototype.hasOwnProperty.call(PACKAGES, payload)
    ? PACKAGES[payload as PackageId]
    : undefined;
}

bot.on("message:successful_payment", async (ctx) => {
  const chatId = ctx.chat.id;
  const sp = ctx.message.successful_payment;
  const p = findPackage(sp.invoice_payload);
  if (!p) {
    await notifyOwner(`Платёж с неизвестным payload от ${chatId}: ${sp.invoice_payload}`);
    return;
  }

  // Зачисление ровно один раз на платёж.
  if (!(await claimPayment(sp.telegram_payment_charge_id))) return;

  await credit(chatId, p.sparks);
  await setStatus(chatId, "paid");
  await bump(`paid_${p.id}`);
  await bump("sparks_sold", p.sparks);
  await bump("stars_earned", p.stars);
  await notifyOwner(`💸 ${chatId} купил «${p.title}» за ${p.stars} ⭐ → +${p.sparks} ✨`);

  // Чек Telegram уже лёг в ленту — экран переезжает под него.
  await moveHome(chatId, { notice: t("home.notice.paid", { added: sparks(p.sparks) }) });
});

// ── Всё остальное ────────────────────────────────────────────────────────────

bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);
  const enough = (await photoCount(chatId)) >= MAX_PHOTOS;
  await moveHome(chatId, { notice: enough ? undefined : t("home.notice.notAPhoto") });
});

/** Имя нужно приветствию, а оно рисуется и вне входящего апдейта. */
async function remember(ctx: Context): Promise<void> {
  const name = ctx.from?.first_name;
  if (name && ctx.chat) await setName(ctx.chat.id, name);
}

// ── Ошибки ───────────────────────────────────────────────────────────────────
/**
 * Наружу ошибка не всплывает никогда: человеку — тост о том, что искры на месте,
 * в лог — стек. «message is not modified» не ошибка вовсе: экран уже в нужном
 * состоянии, и это ровно то, чего мы добивались.
 */
bot.catch(async (err) => {
  const e = err.error;

  if (isNotModified(e)) return;

  if (e instanceof GrammyError) console.error("Telegram error:", e.description, e.payload);
  else if (e instanceof HttpError) console.error("Network error:", e);
  else console.error("Bot error:", e);

  try {
    if (err.ctx.callbackQuery) {
      await err.ctx.answerCallbackQuery({ text: t("toast.error"), show_alert: true });
    }
  } catch {
    /* ответить по коллбэку тоже не вышло — это уже не важно */
  }
});
