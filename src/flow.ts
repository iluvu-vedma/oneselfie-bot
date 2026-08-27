import { Context } from "grammy";
import {
  CALLBACK_SECRET,
  MODELS,
  ModelId,
  PUBLIC_URL,
  PayMethod,
} from "./config";
import * as hub from "./hub";
import { t } from "./i18n";
import { createTask } from "./kie";
import { bump } from "./kv";
import * as ledger from "./ledger";
import { notifyOwner } from "./owner";
import { buildPrompt } from "./prompt";
import * as screens from "./screens";
import type { Notice, Screen } from "./screens";
import { bot } from "./telegram";
import * as store from "./store";
import { Origin, modelName, originOf, sparks } from "./ui";

/**
 * Слой между состоянием и экранами. Экран — чистая функция, состояние живёт
 * в KV, а здесь только одно: по какому адресу что рисовать.
 */
export type Ref =
  | { id: "home" }
  | { id: "models" }
  | { id: "model"; model: ModelId }
  | { id: "upload" }
  | { id: "prompt" }
  | { id: "describe" }
  | { id: "busy" }
  | { id: "topup"; from: Origin }
  | { id: "packs"; method: PayMethod; from: Origin }
  | { id: "help" }
  | { id: "earn" };

/**
 * Собирает экран целиком из KV. Отдельного флага «где мы сейчас» нет: адрес
 * приходит снаружи, всё остальное выводится из данных.
 *
 * Три правила, которые тут и живут:
 *   — идёт генерация → экраны воронки показывают busy, что бы ни было выбрано;
 *   — модель не выбрана → воронки не существует, возвращаем выбор модели;
 *   — есть фото → это уже экран промпта, нет → экран загрузки.
 */
export async function render(chatId: number, ref: Ref, extra: Notice = {}): Promise<Screen> {
  const [user, balance, photos, generating] = await Promise.all([
    store.getUser(chatId),
    store.getBalance(chatId),
    store.photoCount(chatId),
    store.isGenerating(chatId),
  ]);
  const notice = extra.notice;

  switch (ref.id) {
    case "home":
      return screens.home({ balance, name: user.name, notice });
    case "models":
      return screens.models({ balance, notice });
    case "help":
      return screens.help({ notice });
    case "earn":
      return screens.earn({ notice });
    case "topup":
      return screens.topup({ balance, from: ref.from, notice });
    case "packs":
      return screens.packs({ balance, method: ref.method, from: ref.from, notice });
  }

  const model = ref.id === "model" ? ref.model : user.model;
  if (model === null) return screens.models({ balance, notice });
  if (generating) {
    return screens.busy({ model, balance, cost: MODELS[model].price, notice });
  }

  switch (ref.id) {
    case "model":
      return screens.model({ model, balance, notice });
    case "describe":
      return screens.describe({ model, balance, notice });
    case "upload":
    case "prompt":
      return photos > 0
        ? screens.prompt({ model, balance, photos, notice })
        : screens.upload({ model, balance, notice });
    case "busy":
      // Замка нет — кадр уже приехал. Экран «сделать ещё» и есть результат.
      return screens.model({ model, balance, notice });
  }
}

/** Перерисовать экран на месте. Вызывается там, где ctx недоступен: коллбэк kie, крон. */
export async function draw(chatId: number, ref: Ref, extra: Notice = {}): Promise<void> {
  await hub.draw(chatId, await render(chatId, ref, extra));
}

/** Перерисовать то сообщение, на котором нажали кнопку. */
export async function drawHere(ctx: Context, ref: Ref, extra: Notice = {}): Promise<void> {
  await hub.drawHere(ctx, await render(ctx.chat!.id, ref, extra));
}

/** Перенести экран вниз: в ленте появился новый объект — кадр, чек, подарок. */
export async function move(chatId: number, ref: Ref, extra: Notice = {}): Promise<void> {
  await hub.move(chatId, await render(chatId, ref, extra));
}

/** Экран, с которого человек ушёл в пополнение. Читается после оплаты. */
export async function originRef(chatId: number): Promise<Ref> {
  const from = originOf((await store.getUser(chatId)).topupFrom);
  if (from === "home") return { id: "home" };
  if (from === "models") return { id: "models" };
  return { id: "model", model: from };
}

/** Куда возвращаться из экрана модели, если модель уже выбрана. */
export async function modelRef(chatId: number): Promise<Ref> {
  const model = await store.getModel(chatId);
  return model === null ? { id: "models" } : { id: "model", model };
}

/**
 * Где человек стоит сейчас. Нужно там, где адрес не приходит с кнопкой:
 * пришло сообщение, и перерисовать надо тот экран, с которого его написали.
 */
export async function currentRef(chatId: number): Promise<Ref> {
  const user = await store.getUser(chatId);
  if (user.model === null) return { id: "home" };
  if (await store.isGenerating(chatId)) return { id: "busy" };
  if (user.source === "text") return { id: "describe" };
  // render сам выберет между upload и prompt по числу фотографий.
  if (user.source === "photo") return { id: "prompt" };
  return { id: "model", model: user.model };
}

export async function countTopup(chatId: number): Promise<void> {
  await bump("topup_views");
  if (await store.markTopupShown(chatId)) await bump("topup_shown");
}

function callbackUrl(): string {
  if (!PUBLIC_URL) throw new Error("PUBLIC_URL is unset");
  const secret = CALLBACK_SECRET ? `?secret=${encodeURIComponent(CALLBACK_SECRET)}` : "";
  return `${PUBLIC_URL}/api/kie-callback${secret}`;
}

/**
 * Порядок важен: замок → списание → экран «идёт работа» → запрос в kie.
 *
 * Списываем ДО обращения к kie, иначе два быстрых сообщения дают два кадра за
 * одно списание. Экран перерисовывается до `createTask`, а не после: сетевой
 * запрос занимает секунду, и всю эту секунду человек не должен смотреть в тишину.
 */
export async function startGeneration(chatId: number, userPrompt: string): Promise<void> {
  const user = await store.getUser(chatId);
  const model = user.model;
  if (model === null) {
    return draw(chatId, { id: "models" }, { notice: t("notice.needModel") });
  }

  // Источник выбран человеком: в режиме «словами» фото игнорируются, даже если
  // они лежат в состоянии с прошлого кадра.
  const photos = user.source === "photo" ? await store.getPhotos(chatId) : [];
  if (user.source === "photo" && photos.length === 0) {
    return draw(chatId, { id: "upload" }, { notice: t("notice.needPhoto") });
  }

  const lock = await store.acquireGenLock(chatId);
  // Замка нет — кадр уже готовится. Экран сам это покажет: стадия читается из замка.
  if (!lock) return draw(chatId, { id: "busy" });

  const cost = MODELS[model].price;
  const balanceAfter = await store.trySpend(chatId, cost);
  if (balanceAfter === null) {
    await store.releaseGenLock(chatId, lock);
    await store.setTopupFrom(chatId, model);
    await countTopup(chatId);
    return draw(
      chatId,
      { id: "topup", from: model },
      { notice: t("notice.needSparks", { amount: sparks(cost) }) }
    );
  }

  await ledger.record(chatId, "spend", -cost, modelName(model));
  await draw(chatId, { id: "busy" });
  await bot.api.sendChatAction(chatId, "upload_photo").catch(() => {});

  let taskId: string;
  try {
    taskId = await createTask(model, buildPrompt(userPrompt, photos.length > 0), photos, callbackUrl());
  } catch (e) {
    // До kie не дошло — возвращаем ровно то, что сняли, и отпускаем замок.
    await store.credit(chatId, cost);
    await store.releaseGenLock(chatId, lock);
    await bump("gen_failed");
    await bump("sparks_refunded", cost);
    // В лог сбоев — вместе с возвратом: админка отвечает на вопрос «кому должны»,
    // а не «что упало», и без отметки о возврате этот ответ не собрать.
    await ledger.record(chatId, "back", cost, t("admin.fail.start"));
    await ledger.logFail({
      at: Date.now(),
      chatId,
      model,
      cost,
      reason: t("admin.fail.start"),
      back: true,
    });
    await notifyOwner(`createTask (${model}) упал у ${chatId}: ${String(e)}`);
    return draw(
      chatId,
      { id: "model", model },
      { notice: t("notice.startFailed", { amount: sparks(cost) }) }
    );
  }

  await store.createTaskRecord(taskId, chatId, model, userPrompt, cost, lock);
  await bump(`gen_${model}`);
  // Воронка меряется людьми: сороковой кадр одного человека — не сороковой дошедший.
  if (await store.markGenerated(chatId)) await bump("gen_users");
}
