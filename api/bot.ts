import { webhookCallback } from "grammy";
import { TELEGRAM_WEBHOOK_SECRET, WEBHOOK_TIMEOUT_MS } from "../src/config";
import { bot } from "../src/bot";
import * as log from "../src/log";

/**
 * Вебхук Telegram.
 *
 * Срок и поведение по истечении задаются явно. У grammY по умолчанию десять
 * секунд и `onTimeout: "throw"`: апдейт длиннее — Telegram получает пятисотку
 * и присылает его заново. Для загрузки селфи это значит вторую заливку того же
 * файла, для оплаты — второй проход по зачислению.
 *
 * Поэтому ждём почти столько же, сколько живёт сама функция (`maxDuration` 30 с
 * в `vercel.json`), и отвечаем двухсоткой в любом случае: повторять апдейт не
 * за чем. Недоделанное подберёт добор — он для того и есть.
 */
export default webhookCallback(bot, "https", {
  secretToken: TELEGRAM_WEBHOOK_SECRET || undefined,
  timeoutMilliseconds: WEBHOOK_TIMEOUT_MS,
  onTimeout: () => log.warn("webhook.timeout", { ms: WEBHOOK_TIMEOUT_MS }),
});
