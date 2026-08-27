import { ADMIN_IDS, OWNER_CHAT_ID } from "./config";
import * as log from "./log";
import { bot } from "./telegram";

/**
 * Лог владельца. Уведомления приезжают в личку и после появления админки:
 * в панель надо зайти, а сообщение приходит само.
 */
export async function notifyOwner(text: string): Promise<void> {
  log.info("owner.notify", { text });
  if (!OWNER_CHAT_ID) return;
  try {
    await bot.api.sendMessage(OWNER_CHAT_ID, text, { disable_notification: true });
  } catch (e) {
    log.error("owner.notify", e);
  }
}

export function isOwner(chatId: number | string): boolean {
  return Boolean(OWNER_CHAT_ID) && String(chatId) === String(OWNER_CHAT_ID);
}

/**
 * Кто видит админку. Владелец — всегда; остальные перечисляются в ADMIN_IDS.
 * Список закрытый и живёт в окружении: раздавать доступ к чужим балансам
 * кнопкой внутри бота нельзя.
 */
export function isAdmin(chatId: number | string | undefined): boolean {
  if (chatId === undefined) return false;
  return isOwner(chatId) || ADMIN_IDS.includes(String(chatId));
}
