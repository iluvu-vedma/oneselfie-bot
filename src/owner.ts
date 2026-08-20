import { OWNER_CHAT_ID } from "./config";
import { bot } from "./telegram";

/** Лог владельца. Админки нет — всё, что важно, приезжает в личку. */
export async function notifyOwner(text: string): Promise<void> {
  console.log("[owner]", text);
  if (!OWNER_CHAT_ID) return;
  try {
    await bot.api.sendMessage(OWNER_CHAT_ID, text, { disable_notification: true });
  } catch (e) {
    console.error("notifyOwner failed", e);
  }
}

export function isOwner(chatId: number | string): boolean {
  return Boolean(OWNER_CHAT_ID) && String(chatId) === String(OWNER_CHAT_ID);
}
