import { Context, GrammyError, HttpError } from "grammy";
import {
  BOT_TOKEN,
  EXAMPLE_IMAGE_URL,
  MAX_PHOTOS,
  PACKAGES,
  PackageId,
  SPARKS_PER_IMAGE,
} from "./config";
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
  getPhotos,
  markPhotosReady,
  releasePhotoSlot,
  reservePhotoSlot,
  setStatus,
} from "./store";
import {
  CB,
  T,
  beginKeyboard,
  doneKeyboard,
  generateKeyboard,
  paywallKeyboard,
} from "./ui";
import { askPhotos, routeToNextScreen, showPaywall, startGeneration } from "./flow";

export { bot };

// ── Шаг 1–2. Вход и «что будет» ──────────────────────────────────────────────
bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await bump("start");

  const [photos, balance] = await Promise.all([getPhotos(chatId), getBalance(chatId)]);
  // Повторный /start ничего не сбрасывает: сразу на нужный экран.
  if (photos.length > 0 || balance > 0) return routeToNextScreen(chatId);

  if (EXAMPLE_IMAGE_URL) {
    await ctx.replyWithPhoto(EXAMPLE_IMAGE_URL, {
      caption: T.intro,
      reply_markup: beginKeyboard(),
    });
  } else {
    await ctx.reply(T.intro, { reply_markup: beginKeyboard() });
  }
});

bot.callbackQuery(CB.begin, async (ctx) => {
  await ctx.answerCallbackQuery();
  await dropKeyboard(ctx);
  await askPhotos(ctx.chat!.id);
});

// ── Шаг 3. Селфи ─────────────────────────────────────────────────────────────
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);

  const slot = await reservePhotoSlot(chatId);
  if (slot === null) {
    await ctx.reply(T.photoEnough);
    return;
  }

  let count: number;
  try {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    const bytes = await downloadTelegramFile(largest.file_id);
    const url = await uploadImage(bytes, `${chatId}-${Date.now()}-${slot}.jpg`);
    count = await addPhotoUrl(chatId, url);
  } catch (e) {
    await releasePhotoSlot(chatId);
    await notifyOwner(`Загрузка селфи упала у ${chatId}: ${String(e)}`);
    await ctx.reply(T.photoFailed);
    return;
  }

  if (count >= MAX_PHOTOS) {
    await ctx.reply(T.photoAccepted(count));
    return finishPhotos(chatId);
  }
  await ctx.reply(T.photoAccepted(count), { reply_markup: doneKeyboard() });
});

bot.callbackQuery(CB.photosDone, async (ctx) => {
  await ctx.answerCallbackQuery();
  await dropKeyboard(ctx);
  const chatId = ctx.chat!.id;
  if ((await getPhotos(chatId)).length === 0) {
    await ctx.reply(T.needPhotosFirst);
    return askPhotos(chatId);
  }
  await finishPhotos(chatId);
});

/** Селфи собраны → шаг 4 (пейволл) или сразу шаг 6, если искры уже есть. */
async function finishPhotos(chatId: number): Promise<void> {
  if (await markPhotosReady(chatId)) await bump("photos_uploaded");
  await routeToNextScreen(chatId);
}

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

// ── Шаг 5. Оплата ────────────────────────────────────────────────────────────
bot.callbackQuery(/^buy:(probe|set|big)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match![1] as PackageId;
  const p = PACKAGES[id];
  await ctx.api.sendInvoice(
    ctx.chat!.id,
    T.invoiceTitle(p.title),
    T.invoiceDescription(p.sparks),
    p.id, // payload: число искр берётся из константы по этому id
    "XTR",
    [{ label: p.title, amount: p.stars }]
  );
});

bot.on("pre_checkout_query", async (ctx) => {
  const ok = Boolean(findPackage(ctx.preCheckoutQuery.invoice_payload));
  await ctx.answerPreCheckoutQuery(
    ok,
    ok ? undefined : "Счёт устарел. Откройте пакеты заново — /balance"
  );
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

  const balance = await credit(chatId, p.sparks);
  await setStatus(chatId, "paid");
  await bump(`paid_${p.id}`);
  await bump("sparks_sold", p.sparks);
  await bump("stars_earned", p.stars);
  await notifyOwner(`💸 ${chatId} купил «${p.title}» за ${p.stars} ⭐ → +${p.sparks} ✨`);

  await ctx.reply(T.paid(p.sparks, balance), { reply_markup: generateKeyboard() });
});

// ── Шаг 6. Кадр ──────────────────────────────────────────────────────────────
bot.callbackQuery(CB.generate, async (ctx) => {
  await ctx.answerCallbackQuery();
  await dropKeyboard(ctx); // кнопка убирается на время генерации
  await startGeneration(ctx.chat!.id);
});

// ── Шаг 9–10. Служебные команды ──────────────────────────────────────────────
bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await clearPhotos(chatId); // баланс искр сохраняется — он привязан к человеку
  await ctx.reply(T.photosReset);
});

bot.callbackQuery(CB.newPhotos, async (ctx) => {
  await ctx.answerCallbackQuery();
  await clearPhotos(ctx.chat!.id);
  await ctx.reply(T.photosReset);
});

bot.command("balance", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  const balance = await getBalance(chatId);
  if (balance < SPARKS_PER_IMAGE) {
    await ctx.reply(T.balance(balance));
    return showPaywall(chatId, T.notEnough(balance));
  }
  await ctx.reply(T.balance(balance), { reply_markup: generateKeyboard() });
});

bot.command("stats", async (ctx) => {
  if (!isOwner(ctx.chat.id)) return;
  await ctx.reply(await buildStats(), { parse_mode: "HTML" });
});

// ── Всё остальное ────────────────────────────────────────────────────────────
bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  const [photos, balance] = await Promise.all([getPhotos(chatId), getBalance(chatId)]);
  if (photos.length === 0) {
    await ctx.reply(T.notAPhoto);
    return askPhotos(chatId);
  }
  await ctx.reply(
    balance >= SPARKS_PER_IMAGE ? T.ready(balance) : T.notEnough(balance),
    { reply_markup: balance >= SPARKS_PER_IMAGE ? generateKeyboard() : paywallKeyboard() }
  );
});

/** Снимает кнопку с уже отправленного сообщения, чтобы по ней не жали второй раз. */
async function dropKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch {
    /* сообщение старое или уже без кнопок — не важно */
  }
}

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error("Telegram error:", e.description);
  else if (e instanceof HttpError) console.error("Network error:", e);
  else console.error("Bot error:", e);
});
