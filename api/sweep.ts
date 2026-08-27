import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CALLBACK_SECRET, SWEEP_AFTER_SEC, SWEEP_CONCURRENCY } from "../src/config";
import { settleTask } from "../src/deliver";
import * as log from "../src/log";
import { withChatLock } from "../src/queue";
import { getTask, pendingOlderThan } from "../src/store";

/**
 * Аварийный добор пачкой. Страховка, а не основной путь: коллбэк мог не дойти,
 * а искры уже списаны.
 *
 * На бесплатном Vercel крон ходит раз в сутки, поэтому основную работу делает
 * добор по действию человека (`catchUp`). Здесь остаются те, кто в бот больше
 * не заходил: им искры надо вернуть без их участия.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(403).json({ ok: false });

  return log.scope({ kind: "sweep" }, async () => {
    const ms = log.timer();
    const now = Date.now();
    const ids = await pendingOlderThan(now - SWEEP_AFTER_SEC * 1000);
    const report = { checked: ids.length, delivered: 0, refunded: 0, pending: 0, gone: 0 };

    // Пачками, а не по одной: суточный крон обязан разгрести очередь за один
    // приход, иначе следующая попытка будет только завтра. И не все разом:
    // лимит kie — 20 запросов на 10 секунд, а добор ходит именно туда.
    for (let i = 0; i < ids.length; i += SWEEP_CONCURRENCY) {
      const batch = ids.slice(i, i + SWEEP_CONCURRENCY);
      const results = await Promise.all(batch.map(settleOne));
      for (const outcome of results) if (outcome !== null) report[outcome]++;
    }

    log.info("sweep.done", { ...report, ms: ms() });
    return res.status(200).json({ ok: true, ...report });
  });
}

/**
 * Одна упавшая задача не должна останавливать разбор остальных.
 *
 * Чат читается заранее только ради очереди: разбор кончается выдачей или
 * возвратом, а это правка того же экрана, в который может писать сам человек.
 * Нет задачи — нет и чата, но и делать тогда нечего: `settleTask` просто
 * вычистит её из очереди.
 */
async function settleOne(taskId: string) {
  try {
    const task = await getTask(taskId);
    if (task === null) return await settleTask(taskId);
    return await withChatLock(task.chatId, () => settleTask(taskId));
  } catch (e) {
    log.error("sweep.task", e, { taskId });
    return null;
  }
}

function authorized(req: VercelRequest): boolean {
  if (!CALLBACK_SECRET) return true;
  const fromQuery = req.query?.secret;
  const q = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
  const auth = req.headers.authorization;
  // Vercel Cron присылает Authorization: Bearer <CRON_SECRET>
  return q === CALLBACK_SECRET || auth === `Bearer ${process.env.CRON_SECRET ?? CALLBACK_SECRET}`;
}
