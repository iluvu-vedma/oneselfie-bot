import {
  ADMIN_IDS,
  BOT_TOKEN,
  OWNER_CHAT_ID,
  PUBLIC_URL,
  TELEGRAM_WEBHOOK_SECRET,
} from "../src/config";
import { t } from "../src/i18n";

async function main() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is unset");
  const drop = process.argv.includes("--drop");

  if (drop) {
    const res = await call("deleteWebhook", { drop_pending_updates: true });
    console.log(res);
    return;
  }

  if (!PUBLIC_URL) throw new Error("PUBLIC_URL is unset");
  const res = await call("setWebhook", {
    url: `${PUBLIC_URL}/api/bot`,
    secret_token: TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "callback_query", "pre_checkout_query"],
    drop_pending_updates: true,
  });
  console.log(res);

  // Меню команд. Ставится здесь, а не в боте: на вебхуке это был бы лишний
  // запрос к Telegram на каждом апдейте.
  const commands = [
    { command: "start", description: t("command.start") },
    { command: "balance", description: t("command.balance") },
    { command: "new", description: t("command.new") },
    { command: "help", description: t("command.help") },
  ];
  console.log(await call("setMyCommands", { commands }));

  // Админка не в общем меню, а в личном: Telegram умеет область видимости
  // по чату. Иначе /admin висел бы в подсказках у всех — и его бы жали.
  for (const chatId of [OWNER_CHAT_ID, ...ADMIN_IDS].filter(Boolean)) {
    console.log(
      chatId,
      await call("setMyCommands", {
        commands: [...commands, { command: "admin", description: t("command.admin") }],
        scope: { type: "chat", chat_id: chatId },
      })
    );
  }

  console.log(await call("getWebhookInfo", {}));
}

async function call(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
