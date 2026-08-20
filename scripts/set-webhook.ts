import { BOT_TOKEN, PUBLIC_URL, TELEGRAM_WEBHOOK_SECRET } from "../src/config";

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
