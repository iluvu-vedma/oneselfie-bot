import { InputFile } from "grammy";
import { FAILS_BEFORE_ALERT } from "./config";
import { moveHome } from "./flow";
import { t } from "./i18n";
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
  releaseGenLock,
  resetFails,
} from "./store";
import { sparks } from "./ui";

/**
 * Выдача кадра. Кадр — отдельный объект в ленте: его пересылают, сохраняют,
 * к нему возвращаются. Поэтому он уходит новым сообщением, без подписи и без
 * клавиатуры, а экран сразу переезжает под него.
 *
 * Флаг sent ставится ДО отправки: из двух коллбэков kie дальше пройдёт один.
 */
export async function deliverTask(
  taskId: string,
  task: TaskRecord,
  imageUrl: string
): Promise<void> {
  if (!(await claimSend(taskId))) return;

  try {
    await sendPhoto(task.chatId, imageUrl);
  } catch (e) {
    // Отдать не смогли — снимаем флаг целиком (не в 0: claimSend держится на HSETNX),
    // чтобы аварийный добор попробовал ещё раз.
    await redis.hdel(k.task(taskId), "sent");
    await redis.zadd(k.pending, { score: Date.now(), member: taskId });
    await notifyOwner(`Не удалось отправить кадр ${taskId} в ${task.chatId}: ${String(e)}`);
    throw e;
  }

  await forgetPending(taskId);
  // Замок снимается до перерисовки: иначе экран соберётся в стадии «идёт работа».
  await releaseGenLock(task.chatId, task.lock);
  await resetFails(task.chatId);
  await bump("frame_delivered");
  await bump("sparks_spent", task.cost);

  await moveHome(task.chatId, {
    notice: t("home.notice.frame", { price: sparks(task.cost) }),
  });
}

async function sendPhoto(chatId: number, imageUrl: string): Promise<void> {
  try {
    await bot.api.sendPhoto(chatId, imageUrl);
  } catch {
    // Telegram не смог забрать ссылку сам — грузим байты и отправляем файлом.
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`result fetch ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    await bot.api.sendPhoto(chatId, new InputFile(buf, "frame.jpg"));
  }
}

/**
 * Провал или таймаут. Возвращаем ровно то, что снято (task.cost),
 * а не текущую константу: цена кадра могла поменяться между списанием и провалом.
 *
 * Возврат виден на том же экране: отдельное сообщение об ошибке — лишний объект
 * в ленте, а человеку нужны две вещи сразу — что деньги на месте и что делать дальше.
 */
export async function refundTask(
  taskId: string,
  task: TaskRecord,
  reason: string
): Promise<void> {
  if (!(await claimRefund(taskId))) return;

  await credit(task.chatId, task.cost);
  await forgetPending(taskId);
  await releaseGenLock(task.chatId, task.lock);
  await bump("gen_failed");
  await bump("sparks_refunded", task.cost);

  const fails = await bumpFails(task.chatId);
  await notifyOwner(
    `Генерация ${taskId} у ${task.chatId} провалилась (${reason}). ` +
      `Вернул ${task.cost}. Подряд неудач: ${fails}.`
  );

  const notice =
    fails >= FAILS_BEFORE_ALERT
      ? t("home.notice.repeatedFails")
      : t("home.notice.refund", { amount: sparks(task.cost) });

  try {
    await moveHome(task.chatId, { notice });
    if (fails >= FAILS_BEFORE_ALERT) {
      await notifyOwner(
        `⚠️ ${task.chatId}: ${fails} неудачи подряд. Возврат денег — руками, в переписке.`
      );
    }
  } catch (e) {
    console.error("refund notify failed", e);
  }
}
