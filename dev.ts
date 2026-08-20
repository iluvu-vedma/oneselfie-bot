import { bot } from "./src/bot";

/**
 * Локальный запуск на long polling.
 * Коллбэк kie до localhost не достучится — поднимите туннель и положите его
 * адрес в PUBLIC_URL, либо дёргайте /api/sweep руками.
 */
bot.start({
  onStart: (me) => console.log(`@${me.username} is running (long polling)`),
});
