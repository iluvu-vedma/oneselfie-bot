import { InputFile } from "grammy";
import { FAILS_BEFORE_ALERT, SPARKS_PER_IMAGE } from "./config";
import { bump, k, redis } from "./kv";
import { notifyOwner } from "./owner";
import { bot } from "./telegram";
import {
  TaskRecord,
  bumpFails,
  claimRefund,
  claimSend,
  credit,
  forgetPending,
  getBalance,
  releaseGenLock,
  resetFails,
} from "./store";
import { T, generateKeyboard, paywallKeyboard } from "./ui";

/**
 * Шаг 7. Выдача кадра.
 * Флаг sent ставится ДО отправки: из двух коллбэков kie дальше пройдёт один.
 */
export async function deliverTask(
  taskId: string,
  task: TaskRecord,
  imageUrl: string
): Promise<void> {
  if (!(await claimSend(taskId))) return;

  const balance = await getBalance(task.chatId);
  const enough = balance >= SPARKS_PER_IMAGE;
  const caption = enough
    ? T.ready(balance)
    : `${T.ready(balance)}\n\n${T.notEnough(balance)}`;

  try {
    await sendPhoto(task.chatId, imageUrl, caption, enough);
  } catch (e) {
    // Отдать не смогли — снимаем флаг целиком (не в 0: claimSend держится на HSETNX),
    // чтобы аварийный добор попробовал ещё раз.
    await redis.hdel(k.task(taskId), "sent");
    await redis.zadd(k.pending, { score: Date.now(), member: taskId });
    await notifyOwner(`Не удалось отправить кадр ${taskId} в ${task.chatId}: ${String(e)}`);
    throw e;
  }

  await forgetPending(taskId);
  await releaseGenLock(task.chatId, task.lock);
  await resetFails(task.chatId);
  await bump("frame_delivered");
  await bump("sparks_spent", task.cost);
}

async function sendPhoto(
  chatId: number,
  imageUrl: string,
  caption: string,
  enough: boolean
): Promise<void> {
  const markup = enough ? generateKeyboard() : paywallKeyboard();
  try {
    await bot.api.sendPhoto(chatId, imageUrl, { caption, reply_markup: markup });
  } catch {
    // Telegram не смог забрать ссылку сам — грузим байты и отправляем файлом.
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`result fetch ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    await bot.api.sendPhoto(chatId, new InputFile(buf, "frame.jpg"), {
      caption,
      reply_markup: markup,
    });
  }
}

/**
 * Провал или таймаут. Возвращаем ровно то, что снято (task.cost),
 * а не текущую константу: цена кадра могла поменяться между списанием и провалом.
 */
export async function refundTask(
  taskId: string,
  task: TaskRecord,
  reason: string
): Promise<void> {
  if (!(await claimRefund(taskId))) return;

  const balance = await credit(task.chatId, task.cost);
  await forgetPending(taskId);
  await releaseGenLock(task.chatId, task.lock);
  await bump("gen_failed");
  await bump("sparks_refunded", task.cost);

  const fails = await bumpFails(task.chatId);
  await notifyOwner(
    `Генерация ${taskId} у ${task.chatId} провалилась (${reason}). ` +
      `Вернул ${task.cost}. Подряд неудач: ${fails}.`
  );

  const enough = balance >= SPARKS_PER_IMAGE;
  try {
    await bot.api.sendMessage(task.chatId, T.refunded(task.cost), {
      reply_markup: enough ? generateKeyboard() : paywallKeyboard(),
    });
    if (fails >= FAILS_BEFORE_ALERT) {
      await bot.api.sendMessage(task.chatId, T.repeatedFails);
      await notifyOwner(
        `⚠️ ${task.chatId}: ${fails} неудачи подряд. Возврат денег — руками, в переписке.`
      );
    }
  } catch (e) {
    console.error("refund notify failed", e);
  }
}
