import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CALLBACK_SECRET, SWEEP_AFTER_SEC, TIMEOUT_SEC } from "../src/config";
import { recordInfo } from "../src/kie";
import { deliverTask, refundTask } from "../src/deliver";
import { forgetPending, getTask, pendingOlderThan } from "../src/store";

/**
 * Аварийный добор. Страховка, а не основной путь:
 * коллбэк мог не дойти, а искры уже списаны.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(403).json({ ok: false });

  const now = Date.now();
  const ids = await pendingOlderThan(now - SWEEP_AFTER_SEC * 1000);
  const report = { checked: ids.length, delivered: 0, refunded: 0, pending: 0 };

  for (const taskId of ids) {
    try {
      const task = await getTask(taskId);
      if (!task || task.sent || task.refunded) {
        await forgetPending(taskId);
        continue;
      }

      // Не пришло за пять минут — считаем провалом и возвращаем искры.
      if (now - task.createdAt > TIMEOUT_SEC * 1000) {
        await refundTask(taskId, task, "таймаут");
        report.refunded++;
        continue;
      }

      const info = await recordInfo(taskId);
      if (info.state === "success" && info.urls.length > 0) {
        await deliverTask(taskId, task, info.urls[0]);
        report.delivered++;
      } else if (info.state === "fail") {
        await refundTask(taskId, task, info.failMsg ?? "fail");
        report.refunded++;
      } else {
        report.pending++;
      }
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
