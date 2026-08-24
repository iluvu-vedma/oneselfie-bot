import { Context } from "grammy";
import { CALLBACK_SECRET, PUBLIC_URL, SPARKS_PER_IMAGE } from "./config";
import { draw, drawHere, move } from "./hub";
import { t } from "./i18n";
import { createTask } from "./kie";
import { bump } from "./kv";
import { notifyOwner } from "./owner";
import { buildPrompt } from "./scenes";
import * as screens from "./screens";
import { HomeStage, HomeState } from "./screens";
import { bot } from "./telegram";
import {
  acquireGenLock,
  createTaskRecord,
  credit,
  getBalance,
  getPhotos,
  getUser,
  isGenerating,
  markPaywallShown,
  nextSceneIndex,
  photoCount,
  releaseGenLock,
  trySpend,
} from "./store";
import { sparks } from "./ui";

/** Разовая строка о том, что только что произошло. Часть состояния экрана, не «дописка сверху». */
export interface Notice {
  notice?: string;
}

/**
 * Состояние экрана целиком выводится из KV — ни одного флага «где мы сейчас».
 * Поэтому `home` можно нарисовать в любой момент: после оплаты, после кадра,
 * из аварийного крона, спустя сутки. Результат будет один и тот же.
 */
export async function homeState(chatId: number, extra: Notice = {}): Promise<HomeState> {
  const [user, photos, balance, busy] = await Promise.all([
    getUser(chatId),
    photoCount(chatId),
    getBalance(chatId),
    isGenerating(chatId),
  ]);

  let stage: HomeStage;
  if (busy) stage = "busy";
  else if (photos === 0) stage = "start";
  else if (balance < SPARKS_PER_IMAGE) stage = "need";
  else stage = "ready";

  return { stage, balance, photos, name: user.name, notice: extra.notice };
}

/** Перерисовать экран на месте. */
export async function drawHome(chatId: number, extra: Notice = {}): Promise<void> {
  await draw(chatId, screens.home(await homeState(chatId, extra)));
}

/** Перерисовать то сообщение, на котором нажали кнопку. */
export async function drawHomeHere(ctx: Context, extra: Notice = {}): Promise<void> {
  const chatId = ctx.chat!.id;
  await drawHere(ctx, screens.home(await homeState(chatId, extra)));
}

/** Перенести экран вниз: в ленте появился новый объект — кадр, чек, селфи. */
export async function moveHome(chatId: number, extra: Notice = {}): Promise<void> {
  await move(chatId, screens.home(await homeState(chatId, extra)));
}

export async function drawPaywall(chatId: number): Promise<void> {
  await countPaywall(chatId);
  await draw(chatId, screens.paywall(await getBalance(chatId)));
}

export async function drawPaywallHere(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  await countPaywall(chatId);
  await drawHere(ctx, screens.paywall(await getBalance(chatId)));
}

async function countPaywall(chatId: number): Promise<void> {
  await bump("paywall_views");
  if (await markPaywallShown(chatId)) await bump("paywall_shown");
}

function callbackUrl(): string {
  if (!PUBLIC_URL) throw new Error("PUBLIC_URL is unset");
  const secret = CALLBACK_SECRET ? `?secret=${encodeURIComponent(CALLBACK_SECRET)}` : "";
  return `${PUBLIC_URL}/api/kie-callback${secret}`;
}

/**
 * Порядок важен: замок → списание → экран «идёт работа» → запрос в kie.
 *
 * Списываем ДО обращения к kie, иначе два быстрых тапа дают два кадра за одно
 * списание. Экран перерисовывается до `createTask`, а не после: сетевой запрос
 * занимает секунду, и всю эту секунду человек не должен смотреть в тишину.
 */
export async function startGeneration(chatId: number): Promise<void> {
  const photos = await getPhotos(chatId);
  if (photos.length === 0) return drawHome(chatId);

  const lock = await acquireGenLock(chatId);
  // Замка нет — кадр уже готовится. Экран сам это покажет: стадия читается из замка.
  if (!lock) return drawHome(chatId);

  const balanceAfter = await trySpend(chatId, SPARKS_PER_IMAGE);
  if (balanceAfter === null) {
    await releaseGenLock(chatId, lock);
    return drawPaywall(chatId);
  }

  await drawHome(chatId);
  await bot.api.sendChatAction(chatId, "upload_photo").catch(() => {});

  const sceneIndex = await nextSceneIndex(chatId);

  let taskId: string;
  try {
    taskId = await createTask(buildPrompt(sceneIndex), photos, callbackUrl());
  } catch (e) {
    // До kie не дошло — возвращаем ровно то, что сняли, и отпускаем замок.
    await credit(chatId, SPARKS_PER_IMAGE);
    await releaseGenLock(chatId, lock);
    await bump("gen_failed");
    await bump("sparks_refunded", SPARKS_PER_IMAGE);
    await notifyOwner(`createTask упал у ${chatId}: ${String(e)}`);
    return drawHome(chatId, {
      notice: t("home.notice.startFailed", { amount: sparks(SPARKS_PER_IMAGE) }),
    });
  }

  await createTaskRecord(taskId, chatId, sceneIndex, SPARKS_PER_IMAGE, lock);
}
