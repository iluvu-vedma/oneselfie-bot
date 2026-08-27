import { Bot } from "grammy";
import { BOT_TOKEN, TG_MAX_WAIT_MS, TG_RETRIES } from "./config";
import * as log from "./log";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is unset");

/** Единственный экземпляр. Хендлеры навешиваются в bot.ts. */
export const bot = new Bot(BOT_TOKEN);

/**
 * Повтор запроса к Telegram. Двадцать строк вместо плагина: правило повтора
 * тут одно и оно про деньги, а не про удобство.
 *
 * 429 повторяется всегда: Telegram сам говорит, сколько ждать, и такой запрос
 * ГАРАНТИРОВАННО не выполнен — иначе он не назвал бы паузу.
 *
 * 5xx повторяется только у методов, которые не создают новых объектов. «Плохой
 * шлюз» на `editMessageText` — это правка, которая либо прошла, либо нет, и
 * повтор в обоих случаях даёт один и тот же экран. «Плохой шлюз» на
 * `sendMessage` может означать доставленное сообщение с потерянным ответом,
 * и повтор пришлёт человеку второй кадр или второй чек. Дороже промолчать.
 *
 * Сетевой обрыв не повторяется вовсе, по той же причине: ответ потерян, а был
 * ли доставлен запрос — неизвестно.
 */
const SAFE_TO_REPEAT = /^(edit|delete|answer|get|setMy|setWebhook|deleteWebhook)/;

bot.api.config.use(async (prev, method, payload, signal) => {
  for (let attempt = 1; ; attempt++) {
    const res = await prev(method, payload, signal);
    if (res.ok) return res;

    const wait = pauseFor(res.error_code, res.parameters?.retry_after, method);
    if (wait === null || attempt > TG_RETRIES) {
      if (wait !== null) {
        log.warn("telegram.gaveUp", { method, code: res.error_code, attempts: attempt });
      }
      return res;
    }

    log.warn("telegram.retry", { method, code: res.error_code, wait, attempt });
    await new Promise((r) => setTimeout(r, wait));
  }
});

/** Сколько ждать перед повтором, мс. `null` — не повторять вовсе. */
function pauseFor(code: number, retryAfter: number | undefined, method: string): number | null {
  if (code === 429) {
    // Telegram называет паузу в секундах. Просит дольше, чем мы готовы ждать, —
    // сдаёмся сразу: досидеть до конца функции и умереть на таймауте хуже.
    const ms = (retryAfter ?? 1) * 1000;
    return ms > TG_MAX_WAIT_MS ? null : ms;
  }
  if (code >= 500 && SAFE_TO_REPEAT.test(method)) return 500;
  return null;
}
