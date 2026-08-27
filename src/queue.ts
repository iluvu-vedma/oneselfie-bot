import { CHAT_LOCK_POLL_MS, CHAT_LOCK_WAIT_MS } from "./config";
import { bump } from "./kv";
import * as log from "./log";
import { acquireChatLock, releaseChatLock } from "./store";

/**
 * Очередь на чат. Всё, что рисует экран человеку, проходит через неё.
 *
 * Экран у человека один и живёт в KV одним `message_id`. Двое пишущих в него
 * одновременно — это две копии экрана в чате: один переносит его вниз, другой
 * в это же время правит уже удалённое сообщение и присылает своё.
 *
 * Одновременность тут не редкость, а норма. Альбом из четырёх селфи — четыре
 * параллельных запуска функции. Коллбэк kie приходит через сорок секунд после
 * промпта, ровно тогда, когда человек смотрит в бот и жмёт кнопки. Плагин
 * `sequentialize` из grammY на serverless бесполезен: он держит очередь в
 * памяти процесса, а процесс у каждого апдейта свой. Очередь может быть только
 * общей, то есть в KV.
 *
 * Замок берётся на входе, а не внутри выдачи: выдачу вызывают и из-под уже
 * взятого замка (добор по действию человека), и такой замок запер бы сам себя.
 */
export async function withChatLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const token = await waitInLine(chatId);
  try {
    return await fn();
  } finally {
    if (token !== null) await releaseChatLock(chatId, token);
  }
}

/**
 * Ждём своей очереди. Не дождались — идём без замка: потерять апдейт хуже,
 * чем нарисовать лишний экран. Такое ожидание считается отдельно, и растущий
 * счётчик значит, что обработчики стали дольше очереди.
 */
async function waitInLine(chatId: number): Promise<string | null> {
  const deadline = Date.now() + CHAT_LOCK_WAIT_MS;

  for (;;) {
    const token = await acquireChatLock(chatId);
    if (token !== null) return token;

    if (Date.now() >= deadline) {
      await bump("lock_busy");
      log.warn("chat.busy", { chatId, waited: CHAT_LOCK_WAIT_MS });
      return null;
    }
    // Разброс паузы: без него четыре ждущих процесса будят KV в такт и бьются
    // за замок все разом, раз за разом промахиваясь мимо друг друга.
    await sleep(CHAT_LOCK_POLL_MS + Math.random() * CHAT_LOCK_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
