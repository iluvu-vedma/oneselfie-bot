import { Bot } from "grammy";
import { BOT_TOKEN } from "./config";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is unset");

/** Единственный экземпляр. Хендлеры навешиваются в bot.ts. */
export const bot = new Bot(BOT_TOKEN);
