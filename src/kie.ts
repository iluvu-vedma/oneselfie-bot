import {
  KIE_API_KEY,
  KIE_BASE_URL,
  KIE_TIMEOUT_MS,
  KIE_UPLOAD_BASE_URL,
  MODELS,
  MODEL_ASPECT_RATIO,
  MODEL_OUTPUT_FORMAT,
  MODEL_RESOLUTION,
  ModelId,
} from "./config";
import { bump, measure } from "./kv";
import * as log from "./log";

function headers(): Record<string, string> {
  if (!KIE_API_KEY) throw new Error("KIE_API_KEY is unset");
  return {
    Authorization: `Bearer ${KIE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Что можно повторить после отказа.
 *
 * `throttle` — только 429. Лимит kie (20 запросов на 10 секунд) отбивает запрос
 * ДО очереди, поэтому повтор не создаст второй задачи. А вот 500 значит «не
 * знаю»: задача могла быть создана, ответ — потерян, и повтор списал бы деньги
 * дважды. Дешевле вернуть искры человеку, чем заплатить kie за два кадра.
 *
 * `always` — запрос идемпотентный: чтение статуса или заливка файла под тем же
 * именем. Повторять безопасно.
 */
type Retry = "never" | "throttle" | "always";

/** kie отвечает 200 даже на ошибку, настоящий код лежит в теле. Смотрим на оба. */
function codeOf(status: number, body: any): number {
  return typeof body?.code === "number" ? body.code : status;
}

function retryable(code: number, mode: Retry): boolean {
  if (mode === "never") return false;
  if (code === 429) return true;
  return mode === "always" && code >= 500;
}

const RETRIES = 2;
/** Пауза перед повтором. Растёт, чтобы не добивать лимит своими же ретраями. */
const BACKOFF_MS = 600;

/**
 * Запрос с потолком ожидания. Без него зависшее соединение держит функцию до
 * платформенного лимита, а с ним человек получает внятный отказ и свои искры
 * обратно за двадцать секунд.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), KIE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } catch (e) {
    // Причина обрыва в логе должна называться своим именем: «оборвалось само»
    // и «мы не дождались» чинятся по-разному.
    if (abort.signal.aborted) throw new Error(`kie ${url}: нет ответа за ${KIE_TIMEOUT_MS} мс`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function kieFetch(
  path: string,
  init: RequestInit,
  baseUrl = KIE_BASE_URL,
  retry: Retry = "never"
): Promise<any> {
  // Имя запроса без параметров: `?taskId=...` разнёс бы один и тот же вызов
  // на тысячу разных строк в логе и на тысячу счётчиков в KV.
  const name = path.split("?")[0];
  let last = "";

  for (let attempt = 0; ; attempt++) {
    const ms = log.timer();
    const res = await fetchWithTimeout(`${baseUrl}${path}`, init);
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      log.error("kie.notJson", `${res.status}: ${text.slice(0, 200)}`, { path: name });
      throw new Error(`kie ${path}: не JSON (${res.status}): ${text.slice(0, 300)}`);
    }

    const code = codeOf(res.status, body);
    const took = ms();
    await measure("kie", took);

    if (res.ok && code === 200) {
      log.info("kie.ok", { path: name, ms: took, attempt: attempt + 1 });
      return body;
    }

    // Общий счётчик и счётчик по коду: первый показывает экран здоровья,
    // второй отвечает на вопрос, что именно за отказ.
    await Promise.all([bump("kie_err"), bump(`kie_err_${code}`)]);
    last = `kie ${path}: ${code} ${body.msg ?? ""}`.trim();

    if (attempt >= RETRIES || !retryable(code, retry)) {
      log.error("kie.failed", last, { path: name, code, ms: took, attempt: attempt + 1 });
      throw new Error(last);
    }
    log.warn("kie.retry", { path: name, code, ms: took, attempt: attempt + 1 });
    await new Promise((r) => setTimeout(r, BACKOFF_MS * (attempt + 1) * (attempt + 1)));
  }
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
    KIE_UPLOAD_BASE_URL,
    // Имя файла уникальное, повтор просто перезапишет тот же объект.
    "always"
  );
  const url = body?.data?.downloadUrl;
  if (!url) throw new Error("kie upload: нет downloadUrl");
  return String(url);
}

/**
 * Схема `input` у каждого вендора своя, общей не существует — поле с
 * референсами называется по-разному, а разрешение задаётся то `resolution`,
 * то `quality`. Отправишь чужое поле — 422 либо, что хуже, кадр молча не по
 * тем селфи.
 *
 * Без референсов поле с картинками не отправляется вовсе: пустой массив
 * некоторые модели принимают за «работай по картинке» и отдают мусор.
 */
function buildInput(model: ModelId, prompt: string, imageUrls: string[]): Record<string, unknown> {
  const photos = imageUrls.length > 0;

  switch (MODELS[model].family) {
    case "nano":
      return {
        prompt,
        ...(photos ? { image_input: imageUrls } : {}),
        aspect_ratio: MODEL_ASPECT_RATIO,
        resolution: MODEL_RESOLUTION,
        output_format: MODEL_OUTPUT_FORMAT,
      };

    // `quality` вместо `resolution`, `jpeg` вместо `jpg`, потолок — 2K.
    case "seedream":
      return {
        prompt,
        ...(photos ? { image_urls: imageUrls } : {}),
        aspect_ratio: MODEL_ASPECT_RATIO,
        quality: MODEL_RESOLUTION === "1K" ? "basic" : "high",
        output_format: MODEL_OUTPUT_FORMAT === "jpg" ? "jpeg" : MODEL_OUTPUT_FORMAT,
      };

    // Формат выхода не выбирается вовсе. `aspect_ratio` обязателен вместе с
    // `resolution`: на «auto» модель отдаёт только 1K.
    case "gpt":
      return {
        prompt,
        ...(photos ? { input_urls: imageUrls } : {}),
        aspect_ratio: MODEL_ASPECT_RATIO,
        resolution: MODEL_RESOLUTION,
      };
  }
}

/**
 * Ставит задачу в очередь. Синхронно ждать картинку внутри вебхука невозможно.
 *
 * Слаг зависит от режима: у seedream и gpt-image кадр по описанию и кадр по
 * фото — это две разные модели, и слаг обязан ехать вместе с наличием
 * референсов. У nano-banana слаг один на оба режима.
 */
export async function createTask(
  model: ModelId,
  prompt: string,
  imageUrls: string[],
  callBackUrl: string
): Promise<string> {
  const info = MODELS[model];
  const body = await kieFetch(
    "/api/v1/jobs/createTask",
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: imageUrls.length > 0 ? info.kiePhoto : info.kieText,
        callBackUrl,
        input: buildInput(model, prompt, imageUrls),
      }),
    },
    KIE_BASE_URL,
    "throttle"
  );
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
    { method: "GET", headers: headers() },
    KIE_BASE_URL,
    "always"
  );
  return parseTaskData(body?.data);
}

/**
 * Состояние задачи. Форматов у kie два: jobs API кладёт `state`, а описанный
 * в Webhook Security коллбэк — `callbackType`. Читаем оба: угадывать, какой
 * придёт сегодня, дороже, чем разобрать оба.
 */
function stateOf(data: any): TaskState {
  if (typeof data?.state === "string") return data.state as TaskState;
  const type = String(data?.callbackType ?? "");
  if (type === "task_completed") return "success";
  if (type === "task_failed") return "fail";
  return "waiting";
}

/** Общий разбор для коллбэка и для recordInfo. */
export function parseTaskData(data: any): TaskInfo {
  const failMsg = data?.failMsg ?? data?.fail_msg;
  return {
    state: stateOf(data),
    urls: extractUrls(data?.resultJson ?? data?.result_json),
    failMsg: failMsg ? String(failMsg) : undefined,
  };
}

/**
 * Идентификатор задачи из тела коллбэка. Лежит то в `data.taskId`, то в
 * `data.task_id`, то верхним уровнем — зависит от формата, который kie
 * прислал. Пустая строка значит «это не про задачу».
 */
export function taskIdOf(body: any): string {
  const data = body?.data ?? {};
  const id = data.taskId ?? data.task_id ?? body?.taskId ?? body?.task_id;
  return id ? String(id) : "";
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
