import {
  CALLBACK_SECRET,
  PUBLIC_URL,
  SPARKS_PER_IMAGE,
} from "./config";
import { bump } from "./kv";
import { createTask } from "./kie";
import { buildPrompt } from "./scenes";
import { notifyOwner } from "./owner";
import { bot } from "./telegram";
import {
  acquireGenLock,
  createTaskRecord,
  credit,
  getBalance,
  getPhotos,
  markPaywallShown,
  nextSceneIndex,
  releaseGenLock,
  trySpend,
} from "./store";
import { T, generateKeyboard, paywallKeyboard } from "./ui";

/** Пейволл: три кнопки пакетов и ничего кроме них. */
export async function showPaywall(chatId: number, header: string): Promise<void> {
  await bump("paywall_views");
  if (await markPaywallShown(chatId)) await bump("paywall_shown");
  await bot.api.sendMessage(chatId, header, { reply_markup: paywallKeyboard() });
}

/** Экран «Сделать кадр». */
export async function showReady(chatId: number, balance?: number): Promise<void> {
  const b = balance ?? (await getBalance(chatId));
  await bot.api.sendMessage(chatId, T.ready(b), { reply_markup: generateKeyboard() });
}

export async function askPhotos(chatId: number): Promise<void> {
  await bot.api.sendMessage(chatId, T.askPhotos);
}

/**
 * Куда попадает человек, у которого уже что-то есть:
 * нет селфи → шаг 3, нет искр → пейволл, иначе → кадр.
 */
export async function routeToNextScreen(chatId: number): Promise<void> {
  const [photos, balance] = await Promise.all([getPhotos(chatId), getBalance(chatId)]);
  if (photos.length === 0) return askPhotos(chatId);
  if (balance < SPARKS_PER_IMAGE) {
    return showPaywall(chatId, balance === 0 ? T.paywall : T.notEnough(balance));
  }
  return showReady(chatId, balance);
}

function callbackUrl(): string {
  if (!PUBLIC_URL) throw new Error("PUBLIC_URL is unset");
  const secret = CALLBACK_SECRET ? `?secret=${encodeURIComponent(CALLBACK_SECRET)}` : "";
  return `${PUBLIC_URL}/api/kie-callback${secret}`;
}

/**
 * Шаг 6. Порядок важен: замок → списание → запрос в kie.
 * Списываем ДО обращения к kie, иначе два быстрых тапа дают два кадра за одно списание.
 */
export async function startGeneration(chatId: number): Promise<void> {
  const photos = await getPhotos(chatId);
  if (photos.length === 0) {
    await bot.api.sendMessage(chatId, T.needPhotosFirst);
    return askPhotos(chatId);
  }

  const lock = await acquireGenLock(chatId);
  if (!lock) {
    await bot.api.sendMessage(chatId, T.generating);
    return;
  }

  const balanceAfter = await trySpend(chatId, SPARKS_PER_IMAGE);
  if (balanceAfter === null) {
    await releaseGenLock(chatId, lock);
    const balance = await getBalance(chatId);
    return showPaywall(chatId, T.notEnough(balance));
  }

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
    await bot.api.sendMessage(chatId, T.refunded(SPARKS_PER_IMAGE), {
      reply_markup: generateKeyboard(),
    });
    return;
  }

  await createTaskRecord(taskId, chatId, sceneIndex, SPARKS_PER_IMAGE, lock);
  await bot.api.sendMessage(chatId, T.generating);
}
