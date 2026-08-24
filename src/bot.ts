import { Context, GrammyError, HttpError } from "grammy";
import {
  BOT_TOKEN,
  EXAMPLE_IMAGE_URL,
  MAX_PROMPT_LEN,
  MIN_PRICE,
  MODELS,
  ModelId,
  PAY_METHODS,
  PayMethod,
  findPack,
  priceOf,
  sparksOf,
} from "./config";
import {
  countTopup,
  currentRef,
  drawHere,
  modelRef,
  move,
  originRef,
  startGeneration,
} from "./flow";
import { isNotModified } from "./hub";
import { t } from "./i18n";
import { bump } from "./kv";
import { uploadImage } from "./kie";
import { isOwner, notifyOwner } from "./owner";
import { check, normalize } from "./prompt";
import { buildStats } from "./stats";
import { bot } from "./telegram";
import {
  addPhotoUrl,
  claimPayment,
  clearPhotos,
  credit,
  ensureUser,
  getModel,
  isGenerating,
  markPhotosReady,
  releasePhotoSlot,
  reservePhotoSlot,
  setModel,
  setName,
  setSource,
  setStatus,
  setTopupFrom,
} from "./store";
import {
  CB,
  Origin,
  isOrigin,
  money,
  parsePayload,
  payloadOf,
  sparks,
  sparksNamed,
} from "./ui";

export { bot };

/**
 * Роутер экранов. Каждая кнопка правит то самое сообщение, на котором стоит,
 * — новых сообщений от нажатий не появляется.
 *
 * Новое сообщение отправляется ровно в четырёх местах: картинка-пример при
 * первом старте, счёт Telegram, готовый кадр и статистика владельца.
 */

// ── Команды ──────────────────────────────────────────────────────────────────
/**
 * Команда — это сообщение в ленте, поэтому экран после неё всегда переезжает
 * вниз: остаться выше собственной команды он не может.
 */

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
  await move(chatId, { id: "home" });
});

bot.command("balance", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);
  await setTopupFrom(chatId, "home");
  await countTopup(chatId);
  await move(chatId, { id: "topup", from: "home" });
});

bot.command("help", async (ctx) => {
  await ensureUser(ctx.chat.id);
  await remember(ctx);
  await move(ctx.chat.id, { id: "help" });
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);
  await clearPhotos(chatId); // баланс искр сохраняется — он привязан к человеку
  await move(chatId, await modelRef(chatId), { notice: t("notice.reset") });
});

bot.command("stats", async (ctx) => {
  if (!isOwner(ctx.chat.id)) return;
  await ctx.reply(await buildStats(), { parse_mode: "HTML" });
});

// ── Навигация ────────────────────────────────────────────────────────────────

bot.callbackQuery(CB.home, async (ctx) => {
  await ctx.answerCallbackQuery();
  await drawHere(ctx, { id: "home" });
});

bot.callbackQuery(CB.models, async (ctx) => {
  await ctx.answerCallbackQuery();
  await drawHere(ctx, { id: "models" });
});

bot.callbackQuery(CB.help, async (ctx) => {
  await ctx.answerCallbackQuery();
  await drawHere(ctx, { id: "help" });
});

bot.callbackQuery(CB.earn, async (ctx) => {
  await ctx.answerCallbackQuery();
  await drawHere(ctx, { id: "earn" });
});

/** Выбор модели — единственное место, где она попадает в состояние. */
bot.callbackQuery(CB.MODEL_RE, async (ctx) => {
  const model = ctx.match![1] as ModelId;
  await ctx.answerCallbackQuery();
  await setModel(ctx.chat!.id, model);
  await drawHere(ctx, { id: "model", model });
});

/**
 * Источник пополнения едет в callback_data: по «Назад» человек обязан вернуться
 * туда, откуда пришёл, а не вылететь на корень, потеряв выбранную модель.
 */
bot.callbackQuery(CB.TOPUP_RE, async (ctx) => {
  const from = ctx.match![1];
  if (!isOrigin(from)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  await setTopupFrom(ctx.chat!.id, from);
  await countTopup(ctx.chat!.id);
  await drawHere(ctx, { id: "topup", from });
});

// ── Ввод ─────────────────────────────────────────────────────────────────────

bot.callbackQuery(CB.genPhoto, async (ctx) => {
  const model = await getModel(ctx.chat!.id);
  if (model === null) {
    await ctx.answerCallbackQuery({ text: t("toast.needModel"), show_alert: true });
    return drawHere(ctx, { id: "models" });
  }
  // Кнопки у такой модели нет, но клавиатура могла остаться со старого экрана.
  if (!MODELS[model].photo) {
    await ctx.answerCallbackQuery({ text: t("toast.noPhotoModel"), show_alert: true });
    return drawHere(ctx, { id: "model", model });
  }
  await ctx.answerCallbackQuery();
  await setSource(ctx.chat!.id, "photo");
  await drawHere(ctx, { id: "upload" });
});

bot.callbackQuery(CB.genText, async (ctx) => {
  if ((await getModel(ctx.chat!.id)) === null) {
    await ctx.answerCallbackQuery({ text: t("toast.needModel"), show_alert: true });
    return drawHere(ctx, { id: "models" });
  }
  await ctx.answerCallbackQuery();
  await setSource(ctx.chat!.id, "text");
  await drawHere(ctx, { id: "describe" });
});

bot.callbackQuery(CB.genReset, async (ctx) => {
  await ctx.answerCallbackQuery({ text: t("toast.reset") });
  await clearPhotos(ctx.chat!.id);
  await setSource(ctx.chat!.id, "photo");
  await drawHere(ctx, { id: "upload" });
});

// ── Оплата ───────────────────────────────────────────────────────────────────

bot.callbackQuery(CB.PAY_RE, async (ctx) => {
  const method = ctx.match![1] as PayMethod;
  if (!PAY_METHODS[method].live) {
    return ctx.answerCallbackQuery({ text: t("toast.soon"), show_alert: true });
  }
  await ctx.answerCallbackQuery();
  const from = await topupOrigin(ctx.chat!.id);
  await drawHere(ctx, { id: "packs", method, from });
});

/**
 * Счёт — отдельный объект в ленте: он свой у Telegram, и внутрь экрана его не
 * положить. Экран остаётся на месте: если человек передумает, пакеты рядом.
 */
bot.callbackQuery(CB.BUY_RE, async (ctx) => {
  const method = ctx.match![1] as PayMethod;
  const pack = findPack(Number(ctx.match![2]));

  if (!pack) {
    return ctx.answerCallbackQuery({ text: t("invoice.expired"), show_alert: true });
  }
  // Внешний эквайринг не подключён: счёт умеет рисовать только Telegram.
  if (!PAY_METHODS[method].live || method !== "stars") {
    return ctx.answerCallbackQuery({ text: t("toast.soon"), show_alert: true });
  }

  const price = priceOf(pack, method);
  const amount = sparksOf(pack, method);
  await ctx.answerCallbackQuery({ text: t("toast.invoice", { price: money(price, method) }) });
  await ctx.api.sendInvoice(
    ctx.chat!.id,
    t("invoice.title", { sparks: sparks(amount) }),
    t("invoice.description", { sparksNamed: sparksNamed(amount), price: sparks(MIN_PRICE) }),
    payloadOf(method, pack.tier),
    "XTR",
    [{ label: t("invoice.title", { sparks: sparks(amount) }), amount: price }]
  );
});

bot.on("pre_checkout_query", async (ctx) => {
  const ok = Boolean(resolvePayload(ctx.preCheckoutQuery.invoice_payload));
  await ctx.answerPreCheckoutQuery(ok, ok ? undefined : t("invoice.expired"));
});

/** Только собственные ключи: мусор в payload не должен пройти как пакет. */
function resolvePayload(payload: string) {
  const parsed = parsePayload(payload);
  if (!parsed) return undefined;
  const pack = findPack(parsed.tier);
  return pack ? { pack, method: parsed.method } : undefined;
}

bot.on("message:successful_payment", async (ctx) => {
  const chatId = ctx.chat.id;
  const sp = ctx.message.successful_payment;
  const found = resolvePayload(sp.invoice_payload);
  if (!found) {
    await notifyOwner(`Платёж с неизвестным payload от ${chatId}: ${sp.invoice_payload}`);
    return;
  }

  // Зачисление ровно один раз на платёж.
  if (!(await claimPayment(sp.telegram_payment_charge_id))) return;

  const { pack, method } = found;
  const amount = sparksOf(pack, method);
  await credit(chatId, amount);
  await setStatus(chatId, "paid");
  await bump(`paid_${method}_${pack.tier}`);
  await bump("sparks_sold", amount);
  if (method === "stars") await bump("stars_earned", priceOf(pack, method));
  await notifyOwner(
    `💸 ${chatId} купил пакет ${pack.tier} за ${priceOf(pack, method)} ` +
      `${PAY_METHODS[method].unit} → +${amount} ✨`
  );

  // Чек Telegram уже лёг в ленту — экран переезжает под него, и переезжает туда,
  // откуда человек ушёл платить: воронка продолжается, а не начинается заново.
  await move(chatId, await originRef(chatId), {
    notice: t("notice.paid", { added: sparks(amount) }),
  });
});

// ── Селфи ────────────────────────────────────────────────────────────────────
/**
 * Отдельного шага «Готово» нет: одного селфи уже достаточно, а экран после
 * каждого фото сам переезжает вниз в новом состоянии.
 */
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);

  const model = await getModel(chatId);
  if (model === null) {
    return move(chatId, { id: "models" }, { notice: t("notice.needModel") });
  }
  if (!MODELS[model].photo) {
    return move(chatId, { id: "model", model }, { notice: t("notice.noPhotoModel") });
  }
  // Фото во время генерации не принимаем: список референсов уже уехал в kie,
  // и менять его на полпути — верный способ получить кадр не по тем селфи.
  // Экран «Рисую кадр» встаёт прямо под присланным фото и говорит подождать.
  if (await isGenerating(chatId)) return move(chatId, { id: "busy" });

  const slot = await reservePhotoSlot(chatId);
  if (slot === null) {
    return move(chatId, { id: "prompt" }, { notice: t("notice.photoEnough") });
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
    return move(chatId, await currentRef(chatId), { notice: t("notice.photoFailed") });
  }

  // Фото пришло — значит, кадр делаем по фото, даже если до этого выбрали «словами».
  await setSource(chatId, "photo");
  if (await markPhotosReady(chatId)) await bump("photos_uploaded");
  await move(chatId, { id: "prompt" });
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

// ── Промпт ───────────────────────────────────────────────────────────────────
/**
 * Текстовое сообщение и есть кнопка «сделать кадр»: в v2 промпт пишет человек,
 * и отдельного подтверждения после него нет. Цена и баланс стоят на экране,
 * с которого человек пишет, а неудачный кадр возвращает искры сам.
 */
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);

  const text = normalize(ctx.message.text);
  // Неизвестная команда — не промпт. Иначе «/фыва» стоила бы человеку кадра.
  if (text.startsWith("/")) {
    return move(chatId, await currentRef(chatId), { notice: t("notice.unknownCommand") });
  }

  if ((await getModel(chatId)) === null) {
    return move(chatId, { id: "models" }, { notice: t("notice.needModel") });
  }
  if (await isGenerating(chatId)) return move(chatId, { id: "busy" });

  const verdict = check(text);
  if (verdict !== "ok") {
    const notice =
      verdict === "short"
        ? t("notice.promptShort")
        : t("notice.promptLong", { max: MAX_PROMPT_LEN });
    return move(chatId, await currentRef(chatId), { notice });
  }

  // Промпт написан на экране модели, до выбора способа: раз фото нет — значит словами.
  if ((await currentRef(chatId)).id === "model") await setSource(chatId, "text");

  // Сообщение человека уже лежит в ленте — экран переезжает под него, а рисовать
  // дальше будет startGeneration.
  await move(chatId, await currentRef(chatId));
  await startGeneration(chatId, text);
});

// ── Всё остальное ────────────────────────────────────────────────────────────

bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;
  await ensureUser(chatId);
  await remember(ctx);
  await move(chatId, await currentRef(chatId), { notice: t("notice.notAPhoto") });
});

/** Имя нужно приветствию, а оно рисуется и вне входящего апдейта. */
async function remember(ctx: Context): Promise<void> {
  const name = ctx.from?.first_name;
  if (name && ctx.chat) await setName(ctx.chat.id, name);
}

/** Источник пополнения из состояния — для экранов ниже topup, куда он не едет. */
async function topupOrigin(chatId: number): Promise<Origin> {
  const ref = await originRef(chatId);
  if (ref.id === "model") return ref.model;
  return ref.id === "models" ? "models" : "home";
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
