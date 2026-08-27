import { InputFile } from "grammy";
import {
  FAILS_BEFORE_ALERT,
  SUPPORT_URL,
  SWEEP_AFTER_SEC,
  TEXT_LIMIT,
  TIMEOUT_SEC,
} from "./config";
import { Ref, modelRef, move } from "./flow";
import { esc, t } from "./i18n";
import { recordInfo } from "./kie";
import { bump, k, measure, redis } from "./kv";
import * as ledger from "./ledger";
import * as log from "./log";
import { notifyOwner } from "./owner";
import { clip } from "./prompt";
import { bot } from "./telegram";
import {
  TaskRecord,
  bumpFails,
  claimRefund,
  claimSend,
  credit,
  forgetPending,
  getChatTask,
  getTask,
  releaseGenLock,
  resetFails,
} from "./store";
import { sparks } from "./ui";

/**
 * Выдача кадра. Кадр — отдельный объект в ленте: его пересылают, сохраняют,
 * к нему возвращаются. Поэтому он уходит новым сообщением, без клавиатуры,
 * а экран сразу переезжает под него.
 *
 * Подпись — одна строка: кадр смотрят и пересылают, и промпт в подписи этому
 * мешает. Описание уходит следом отдельным сообщением — там его копируют одним
 * тапом и повторяют кадр.
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

  // Время кадра меряется здесь, а не в `startGeneration`: списание и выдача
  // происходят в разных процессах, и единственное, что их связывает, — это
  // отметка внутри самой задачи.
  const took = Date.now() - task.createdAt;
  await measure("gen", took);
  log.info("frame.delivered", { taskId, chatId: task.chatId, model: task.model, ms: took });

  await move(task.chatId, await where(task), {
    notice: t("notice.frame", { price: sparks(task.cost) }),
  });
}

/** Экран после кадра — та же модель в состоянии «сделать ещё»: повтор в одно нажатие. */
async function where(task: TaskRecord): Promise<Ref> {
  return task.model === null ? modelRef(task.chatId) : { id: "model", model: task.model };
}

/** Длиннее — сворачивается в цитату: стена текста под кадром читается как мусор. */
const FOLD_AFTER = 300;

async function sendFrame(chatId: number, imageUrl: string, prompt: string): Promise<void> {
  await sendPhoto(chatId, imageUrl, t("frame.caption"));
  await sendPrompt(chatId, prompt);
}

/**
 * Описание кадра. Отдельное сообщение, а не подпись: по нему кадр повторяют,
 * поэтому оно должно копироваться одним тапом и не мешать смотреть на кадр.
 *
 * Не отправилось — кадр всё равно выдан, и делать вид, что генерация провалилась,
 * нельзя. Поэтому ошибка уходит в лог, а не наверх.
 */
async function sendPrompt(chatId: number, prompt: string): Promise<void> {
  const body = esc(prompt);
  const key = body.length > FOLD_AFTER ? "frame.prompt.folded" : "frame.prompt.plain";
  // Место под сам промпт — лимит минус обёртка. Считаем её из строки локали,
  // а не константой: правка разметки не должна тихо ломать рез.
  const room = TEXT_LIMIT - t(key, { prompt: "" }).length;

  await bot.api
    .sendMessage(chatId, t(key, { prompt: clip(body, room) }), {
      parse_mode: "HTML",
      // Кадр уже прозвенел — описание приходит следом молча.
      disable_notification: true,
    })
    .catch((e) => log.error("frame.promptNote", e, { chatId }));
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
  // Возврат — в историю человека, сам сбой — в общий лог. Первое объясняет
  // баланс, второе отвечает на вопрос, кому вообще положена компенсация.
  await ledger.record(task.chatId, "back", task.cost, reason);
  await ledger.logFail({
    at: Date.now(),
    chatId: task.chatId,
    model: task.model,
    cost: task.cost,
    reason,
    back: true,
  });

  const fails = await bumpFails(task.chatId);
  log.warn("frame.refunded", {
    taskId,
    chatId: task.chatId,
    model: task.model,
    cost: task.cost,
    reason,
    fails,
  });
  await notifyOwner(
    `Генерация ${taskId} (${task.model ?? "?"}) у ${task.chatId} провалилась (${reason}). ` +
      `Вернул ${task.cost}. Подряд неудач: ${fails}.`
  );

  const notice =
    fails >= FAILS_BEFORE_ALERT
      ? repeatedFails()
      : t("notice.refund", { amount: sparks(task.cost) });

  try {
    await move(task.chatId, await where(task), { notice });
    if (fails >= FAILS_BEFORE_ALERT) {
      await notifyOwner(
        `⚠️ ${task.chatId}: ${fails} неудачи подряд. Возврат денег — руками, в переписке.`
      );
    }
  } catch (e) {
    log.error("refund.notify", e, { chatId: task.chatId });
  }
}

/**
 * Три сбоя подряд — это уже не «попробуй ещё раз», а разговор с человеком.
 * Кнопки поддержки на экране модели нет и не будет: она нужна раз в жизни,
 * а мозолила бы глаза каждый заход. Поэтому адрес едет прямо в строке.
 *
 * Пустой SUPPORT_URL — «напиши мне» превращается в обещание без адреса,
 * поэтому текст меняется целиком. Владелец о сбое всё равно уже знает:
 * notifyOwner выше срабатывает независимо от ссылки.
 */
function repeatedFails(): string {
  return SUPPORT_URL
    ? t("notice.repeatedFails.support", { url: SUPPORT_URL })
    : t("notice.repeatedFails.plain");
}

/** Чем закончился разбор одной задачи. Крон складывает из этого отчёт. */
export type Settled = "delivered" | "refunded" | "pending" | "gone";

/**
 * Разбор одной задачи: кадр приехал — отдать, провалился или висит дольше
 * таймаута — вернуть искры. Один и тот же код на два входа, крон и добор по
 * действию человека: расходиться этим двум путям нельзя, иначе кадр выдаётся
 * по-разному в зависимости от того, кто первым спохватился.
 *
 * Ходить в kie раньше SWEEP_AFTER_SEC незачем: коллбэк ещё в дороге, а лимит
 * kie — 20 запросов на 10 секунд, и тратить их на «ещё рисуется» глупо.
 */
export async function settleTask(taskId: string, now = Date.now()): Promise<Settled> {
  const task = await getTask(taskId);
  if (!task || task.sent || task.refunded) {
    await forgetPending(taskId);
    return "gone";
  }

  if (now - task.createdAt > TIMEOUT_SEC * 1000) {
    await refundTask(taskId, task, t("admin.fail.timeout"));
    return "refunded";
  }
  if (now - task.createdAt < SWEEP_AFTER_SEC * 1000) return "pending";

  const info = await recordInfo(taskId);
  if (info.state === "success" && info.urls.length > 0) {
    await deliverTask(taskId, task, info.urls[0]);
    return "delivered";
  }
  if (info.state === "fail") {
    await refundTask(taskId, task, info.failMsg ?? t("admin.fail.generation"));
    return "refunded";
  }
  return "pending";
}

/**
 * Добор по действию человека. Коллбэк мог не дойти, а крон на бесплатном
 * Vercel ходит раз в сутки — ждать его с уже списанными искрами человек не
 * должен. Любое действие в боте становится поводом спросить у kie, готов ли
 * кадр.
 *
 * Вызывается ПОСЛЕ обработчика, а не до: обработчик рисует свой экран, и уже
 * под ним появляется кадр, а экран переезжает вниз сам. Сделай наоборот —
 * обработчик перерисует сообщение, которое выдача только что удалила.
 */
export async function catchUp(chatId: number): Promise<void> {
  const taskId = await getChatTask(chatId);
  if (!taskId) return;
  await settleTask(taskId);
}
