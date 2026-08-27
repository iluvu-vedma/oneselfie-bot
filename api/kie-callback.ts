import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CALLBACK_SECRET } from "../src/config";
import { parseTaskData, taskIdOf } from "../src/kie";
import { deliverTask, refundTask } from "../src/deliver";
import * as log from "../src/log";
import { withChatLock } from "../src/queue";
import { getTask } from "../src/store";

/**
 * Приём результата от kie. Секрет обязателен — иначе эндпоинт открыт всему интернету.
 * Всегда отвечаем 200: повторные попытки kie нам не нужны, идемпотентность своя.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(403).json({ ok: false });

  return log.scope({ kind: "kie-callback" }, async () => {
    const ms = log.timer();
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const data = body?.data ?? body;
      const taskId = taskIdOf(body);
      if (!taskId) return skip(res, "no taskId");

      log.note({ taskId });
      const task = await getTask(taskId);
      // Запись задачи живёт двое суток. Её отсутствие значит либо чужой коллбэк,
      // либо очень поздний свой — и то и другое разбирать уже нечем.
      if (!task) return skip(res, "unknown task");
      // Двойной коллбэк: kie может позвать дважды.
      if (task.sent || task.refunded) return skip(res, "already handled");

      log.note({ chatId: task.chatId, model: task.model });
      const info = parseTaskData(data);

      if (info.state !== "success" && info.state !== "fail" && body?.code === 200) {
        return skip(res, `state ${info.state}`);
      }

      // Через очередь чата: коллбэк приходит через полминуты после промпта,
      // ровно тогда, когда человек смотрит в бот и жмёт кнопки. Без очереди
      // выдача и нажатие правят один и тот же экран одновременно.
      await withChatLock(task.chatId, async () => {
        if (info.state === "success" && info.urls.length > 0) {
          await deliverTask(taskId, task, info.urls[0]);
        } else {
          await refundTask(taskId, task, info.failMsg ?? body?.msg ?? "fail");
        }
      });

      log.info("callback.done", { state: info.state, ms: ms() });
      return res.status(200).json({ ok: true });
    } catch (e) {
      log.error("kie.callback", e, { ms: ms() });
      return res.status(200).json({ ok: false });
    }
  });
}

/**
 * Ничего не делали — и это нормально. Всегда двухсотка: повторные попытки kie
 * нам не нужны, идемпотентность своя.
 */
function skip(res: VercelResponse, why: string) {
  log.info("callback.skipped", { why });
  return res.status(200).json({ ok: true, skipped: why });
}

function authorized(req: VercelRequest): boolean {
  if (!CALLBACK_SECRET) return true; // локальная разработка без секрета
  const fromQuery = req.query?.secret;
  const q = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
  const h = req.headers["x-callback-secret"];
  return q === CALLBACK_SECRET || h === CALLBACK_SECRET;
}
