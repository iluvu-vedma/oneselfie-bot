import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CALLBACK_SECRET } from "../src/config";
import { parseTaskData, taskIdOf } from "../src/kie";
import { deliverTask, refundTask } from "../src/deliver";
import { getTask } from "../src/store";

/**
 * Приём результата от kie. Секрет обязателен — иначе эндпоинт открыт всему интернету.
 * Всегда отвечаем 200: повторные попытки kie нам не нужны, идемпотентность своя.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(403).json({ ok: false });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const data = body?.data ?? body;
    const taskId = taskIdOf(body);
    if (!taskId) return res.status(200).json({ ok: true, skipped: "no taskId" });

    const task = await getTask(taskId);
    if (!task) return res.status(200).json({ ok: true, skipped: "unknown task" });
    // Двойной коллбэк: kie может позвать дважды.
    if (task.sent || task.refunded) {
      return res.status(200).json({ ok: true, skipped: "already handled" });
    }

    const info = parseTaskData(data);
    if (info.state === "success" && info.urls.length > 0) {
      await deliverTask(taskId, task, info.urls[0]);
    } else if (info.state === "fail" || body?.code !== 200) {
      await refundTask(taskId, task, info.failMsg ?? body?.msg ?? "fail");
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("kie-callback failed", e);
    return res.status(200).json({ ok: false });
  }
}

function authorized(req: VercelRequest): boolean {
  if (!CALLBACK_SECRET) return true; // локальная разработка без секрета
  const fromQuery = req.query?.secret;
  const q = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
  const h = req.headers["x-callback-secret"];
  return q === CALLBACK_SECRET || h === CALLBACK_SECRET;
}
