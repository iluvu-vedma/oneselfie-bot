import { webhookCallback } from "grammy";
import { TELEGRAM_WEBHOOK_SECRET } from "../src/config";
import { bot } from "../src/bot";

export default webhookCallback(bot, "https", {
  secretToken: TELEGRAM_WEBHOOK_SECRET || undefined,
});
