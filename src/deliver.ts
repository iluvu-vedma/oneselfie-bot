import { InputFile } from "grammy";
import { CAPTION_LIMIT, FAILS_BEFORE_ALERT } from "./config";
import { Ref, modelRef, move } from "./flow";
import { esc, t } from "./i18n";
import { bump, k, redis } from "./kv";
import { notifyOwner } from "./owner";
import { splitCaption } from "./prompt";
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
 * к нему возвращаются. Поэтому он уходит новым сообщением, без клавиатуры,
 * а экран сразу переезжает под него.
 *
 * Подпись — промпт целиком в <code>: по нему кадр повторяют, поэтому он должен
 * копироваться одним тапом, а не жить в истории чата выше.
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
    await sendFrame(task.chatId, imageUrl, task.prompt);
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

  await move(task.chatId, await where(task), {
    notice: t("notice.frame", { price: sparks(task.cost) }),
  });
}

/** Экран после кадра — та же модель в состоянии «сделать ещё»: повтор в одно нажатие. */
async function where(task: TaskRecord): Promise<Ref> {
  return task.model === null ? modelRef(task.chatId) : { id: "model", model: task.model };
}

/** `<code>` вокруг подписи стоит 13 символов — лимит подписи уменьшается на них. */
const CODE_OVERHEAD = "<code></code>".length;

async function sendFrame(chatId: number, imageUrl: string, prompt: string): Promise<void> {
  const { head, tail } = splitCaption(esc(prompt), CAPTION_LIMIT - CODE_OVERHEAD);
  const caption = head ? `<code>${head}</code>` : undefined;

  await sendPhoto(chatId, imageUrl, caption);

  // Промпт не поместился в подпись — полный текст уходит следом, чтобы его
  // всё-таки можно было скопировать целиком.
  if (tail) {
    await bot.api
      .sendMessage(chatId, t("frame.fullPrompt", { prompt: tail }), {
        parse_mode: "HTML",
        disable_notification: true,
      })
      .catch((e) => console.error("full prompt failed", e));
  }
}

async function sendPhoto(chatId: number, imageUrl: string, caption?: string): Promise<void> {
  const options = { caption, parse_mode: "HTML" as const };
  try {
    await bot.api.sendPhoto(chatId, imageUrl, options);
  } catch {
    // Telegram не смог забрать ссылку сам — грузим байты и отправляем файлом.
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`result fetch ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    await bot.api.sendPhoto(chatId, new InputFile(buf, "frame.jpg"), options);
  }
}

/**
 * Провал или таймаут. Возвращаем ровно то, что снято (task.cost), а не текущую
 * константу: цена кадра могла поменяться между списанием и провалом.
 *
 * Возврат виден строкой на экране, а не отдельным сообщением: человеку нужны
 * две вещи сразу — что деньги на месте и что делать дальше. Экран при этом
 * переезжает вниз: пока кадр считался, человек мог что-то прислать, и правка
 * на месте ушла бы выше видимой части чата. Лента от переезда не растёт.
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
    `Генерация ${taskId} (${task.model ?? "?"}) у ${task.chatId} провалилась (${reason}). ` +
      `Вернул ${task.cost}. Подряд неудач: ${fails}.`
  );

  const notice =
    fails >= FAILS_BEFORE_ALERT
      ? t("notice.repeatedFails")
      : t("notice.refund", { amount: sparks(task.cost) });

  try {
    await move(task.chatId, await where(task), { notice });
    if (fails >= FAILS_BEFORE_ALERT) {
      await notifyOwner(
        `⚠️ ${task.chatId}: ${fails} неудачи подряд. Возврат денег — руками, в переписке.`
      );
    }
  } catch (e) {
    console.error("refund notify failed", e);
  }
}
