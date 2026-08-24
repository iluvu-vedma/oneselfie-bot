import {
  KIE_API_KEY,
  KIE_BASE_URL,
  KIE_UPLOAD_BASE_URL,
  MODELS,
  MODEL_ASPECT_RATIO,
  MODEL_OUTPUT_FORMAT,
  MODEL_RESOLUTION,
  ModelId,
} from "./config";

function headers(): Record<string, string> {
  if (!KIE_API_KEY) throw new Error("KIE_API_KEY is unset");
  return {
    Authorization: `Bearer ${KIE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function kieFetch(
  path: string,
  init: RequestInit,
  baseUrl = KIE_BASE_URL
): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`kie ${path}: не JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || (body.code !== undefined && body.code !== 200)) {
    throw new Error(`kie ${path}: ${body.code ?? res.status} ${body.msg ?? ""}`.trim());
  }
  return body;
}

/**
 * Заливка селфи в хранилище kie.
 * Прямые ссылки Telegram использовать нельзя — в них лежит токен бота.
 */
export async function uploadImage(
  bytes: Buffer,
  fileName: string,
  uploadPath = "oneselfie/refs"
): Promise<string> {
  const body = await kieFetch(
    "/api/file-base64-upload",
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        base64Data: bytes.toString("base64"),
        uploadPath,
        fileName,
      }),
    },
    KIE_UPLOAD_BASE_URL
  );
  const url = body?.data?.downloadUrl;
  if (!url) throw new Error("kie upload: нет downloadUrl");
  return String(url);
}

/**
 * Ставит задачу в очередь. Синхронно ждать картинку внутри вебхука невозможно.
 *
 * Без референсов `image_input` не отправляется вовсе: пустой массив некоторые
 * модели принимают за «работай по картинке» и отдают мусор.
 */
export async function createTask(
  model: ModelId,
  prompt: string,
  imageUrls: string[],
  callBackUrl: string
): Promise<string> {
  const body = await kieFetch("/api/v1/jobs/createTask", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: MODELS[model].kieId,
      callBackUrl,
      input: {
        prompt,
        ...(imageUrls.length > 0 ? { image_input: imageUrls } : {}),
        aspect_ratio: MODEL_ASPECT_RATIO,
        resolution: MODEL_RESOLUTION,
        output_format: MODEL_OUTPUT_FORMAT,
      },
    }),
  });
  const taskId = body?.data?.taskId;
  if (!taskId) throw new Error("kie createTask: нет taskId");
  return String(taskId);
}

export type TaskState = "waiting" | "queuing" | "generating" | "success" | "fail";

export interface TaskInfo {
  state: TaskState;
  urls: string[];
  failMsg?: string;
}

/** Аварийный добор результата. Страховка, а не основной путь. */
export async function recordInfo(taskId: string): Promise<TaskInfo> {
  const body = await kieFetch(
    `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { method: "GET", headers: headers() }
  );
  return parseTaskData(body?.data);
}

/** Общий разбор для коллбэка и для recordInfo — форма data одинаковая. */
export function parseTaskData(data: any): TaskInfo {
  const state = (data?.state ?? "waiting") as TaskState;
  return {
    state,
    urls: extractUrls(data?.resultJson),
    failMsg: data?.failMsg ? String(data.failMsg) : undefined,
  };
}

function extractUrls(resultJson: unknown): string[] {
  if (!resultJson) return [];
  let parsed: any = resultJson;
  if (typeof resultJson === "string") {
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      return [];
    }
  }
  const urls = parsed?.resultUrls ?? parsed?.result_urls ?? [];
  return Array.isArray(urls) ? urls.map(String).filter(Boolean) : [];
}
