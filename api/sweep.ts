import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CALLBACK_SECRET, SWEEP_AFTER_SEC } from "../src/config";
import { settleTask } from "../src/deliver";
import { pendingOlderThan } from "../src/store";

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

  const now = Date.now();
  const ids = await pendingOlderThan(now - SWEEP_AFTER_SEC * 1000);
  const report = { checked: ids.length, delivered: 0, refunded: 0, pending: 0, gone: 0 };

  for (const taskId of ids) {
    try {
      report[await settleTask(taskId, now)]++;
    } catch (e) {
      console.error("sweep failed for", taskId, e);
    }
  }

  return res.status(200).json({ ok: true, ...report });
}

function authorized(req: VercelRequest): boolean {
  if (!CALLBACK_SECRET) return true;
  const fromQuery = req.query?.secret;
  const q = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
  const auth = req.headers.authorization;
  // Vercel Cron присылает Authorization: Bearer <CRON_SECRET>
  return q === CALLBACK_SECRET || auth === `Bearer ${process.env.CRON_SECRET ?? CALLBACK_SECRET}`;
}
