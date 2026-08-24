import { Context, GrammyError } from "grammy";
import type { Screen } from "./screens";
import { bot } from "./telegram";
import { getHubId, setHubId, takeHubId } from "./store";

/**
 * Весь интерфейс бота — одно сообщение, которое редактируется.
 * Чат не растёт, человек смотрит в одну точку.
 *
 * Новое сообщение отправляется только там, где нужен отдельный объект в ленте:
 * готовый кадр, счёт Telegram, картинка-пример при старте. После каждого такого
 * объекта экран переезжает вниз (`move`) — иначе он остаётся выше и его не видно.
 */

const SEND_OPTIONS = {
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
} as const;

/** «message is not modified» — штатная ситуация: экран уже в нужном состоянии. */
export function isNotModified(e: unknown): boolean {
  return e instanceof GrammyError && e.description.includes("message is not modified");
}

/** Сообщение удалили руками или оно старше 48 часов — редактировать нечего. */
function isGone(e: unknown): boolean {
  return (
    e instanceof GrammyError &&
    /message (to edit )?not found|message can'?t be edited|MESSAGE_ID_INVALID/i.test(
      e.description
    )
  );
}

async function send(chatId: number, screen: Screen): Promise<void> {
  const msg = await bot.api.sendMessage(chatId, screen.text, {
    ...SEND_OPTIONS,
    reply_markup: screen.reply_markup,
    // Экран — элемент интерфейса, а не новость. Звенеть должны кадр и оплата.
    disable_notification: true,
  });
  await setHubId(chatId, msg.message_id);
}

async function edit(chatId: number, messageId: number, screen: Screen): Promise<boolean> {
  try {
    await bot.api.editMessageText(chatId, messageId, screen.text, {
      ...SEND_OPTIONS,
      reply_markup: screen.reply_markup,
    });
    return true;
  } catch (e) {
    if (isNotModified(e)) return true;
    if (isGone(e)) return false;
    throw e;
  }
}

/**
 * Перерисовать экран на месте. Если сообщения больше нет — отправить новое.
 * Вызывается из мест, где ctx недоступен: коллбэк kie, аварийный крон.
 */
export async function draw(chatId: number, screen: Screen): Promise<void> {
  const id = await getHubId(chatId);
  if (id !== null && (await edit(chatId, id, screen))) return;
  await send(chatId, screen);
}

/**
 * Перерисовать то самое сообщение, на котором стоит нажатая кнопка, и запомнить
 * его как текущий экран.
 *
 * «Усыновление» решает проблему устаревшего меню без отдельной ветки: если человек
 * нажал кнопку на старой копии экрана далеко вверху чата, эта копия и становится
 * экраном. Расхождения не будет — экран собирается целиком из состояния.
 */
export async function drawHere(ctx: Context, screen: Screen): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined) return;
  if (messageId === undefined) return draw(chatId, screen);

  await setHubId(chatId, messageId);
  if (await edit(chatId, messageId, screen)) return;
  await send(chatId, screen);
}

/**
 * Перенести экран вниз: под ним появилось что-то новое — кадр, чек, селфи
 * пользователя. Клавиатура снимается до удаления: если удалить не выйдет,
 * наверху останется безобидный текст, а не вторая рабочая копия экрана.
 */
export async function move(chatId: number, screen: Screen): Promise<void> {
  const old = await takeHubId(chatId);
  if (old !== null) {
    await bot.api.editMessageReplyMarkup(chatId, old).catch(() => {});
    await bot.api.deleteMessage(chatId, old).catch(() => {});
  }
  await send(chatId, screen);
}
