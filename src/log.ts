import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Логи одной строкой JSON.
 *
 * Разбор инцидента в Vercel — это поиск по строке в общей ленте, где вперемешку
 * лежат все апдейты всех людей. Поэтому у каждой строки есть `rid`: один апдейт,
 * один коллбэк kie, один проход крона получают свой идентификатор, и по нему
 * из ленты выдёргивается вся история события целиком — вместе с чатом, моделью
 * и задачей.
 *
 * Модуль намеренно ни от чего не зависит: его тянут и `kv.ts`, и `telegram.ts`,
 * и любая зависимость здесь замкнула бы импорты в кольцо. Хранение последних
 * ошибок живёт в `ledger.ts` и подключается сюда приёмником через `setSink`.
 *
 * Чего в логи не попадает никогда: токены, ключи, промпты и ссылки на селфи.
 * Промпт — это личное, а ссылка на селфи открывается без всякой авторизации.
 * Пишется длина и количество, этого хватает, чтобы понять, что случилось.
 */

export interface Fields {
  [key: string]: unknown;
}

interface Scope {
  rid: string;
  fields: Fields;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Короткий, но различимый: в ленте его читают глазами, а не машиной. */
function newRid(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Последние ошибки нужны админке, а держать их в памяти процесса бессмысленно:
 * на serverless каждый апдейт — свой процесс. Приёмник ставит `ledger.ts`,
 * который умеет писать списки в KV.
 */
export interface ErrorNote {
  at: number;
  rid: string;
  /** Где сломалось: `kie.createTask`, `telegram.sendPhoto`, `sweep`. */
  where: string;
  /** Текст ошибки, подрезанный до читаемого. */
  detail: string;
  chatId?: number;
}

type Sink = (note: ErrorNote) => void;

let sink: Sink = () => {};

export function setSink(fn: Sink): void {
  sink = fn;
}

// ── Контекст ─────────────────────────────────────────────────────────────────

/**
 * Оборачивает обработку одного события. Всё, что залогируется внутри, получит
 * общий `rid` и поля, добавленные по дороге через `note`.
 */
export async function scope<T>(fields: Fields, fn: () => Promise<T>): Promise<T> {
  return scopes.run({ rid: newRid(), fields: { ...fields } }, fn);
}

/** Дописать поля к текущему событию: модель и задача известны не сразу. */
export function note(fields: Fields): void {
  const current = scopes.getStore();
  if (current) Object.assign(current.fields, fields);
}

export function rid(): string {
  return scopes.getStore()?.rid ?? "-";
}

// ── Запись ───────────────────────────────────────────────────────────────────

function line(level: "info" | "warn" | "error", msg: string, fields: Fields): string {
  const current = scopes.getStore();
  return JSON.stringify({
    lvl: level,
    msg,
    rid: current?.rid ?? "-",
    ...current?.fields,
    ...fields,
  });
}

export function info(msg: string, fields: Fields = {}): void {
  console.log(line("info", msg, fields));
}

export function warn(msg: string, fields: Fields = {}): void {
  console.warn(line("warn", msg, fields));
}

/** Ошибка уходит и в ленту, и в кольцо последних ошибок — его читает админка. */
export function error(where: string, e: unknown, fields: Fields = {}): void {
  const detail = describe(e);
  console.error(line("error", where, { ...fields, detail }));

  const chatId = fields.chatId ?? scopes.getStore()?.fields.chatId;
  try {
    sink({
      at: Date.now(),
      rid: rid(),
      where,
      detail,
      ...(typeof chatId === "number" ? { chatId } : {}),
    });
  } catch {
    /* приёмник ошибок не имеет права ронять то, что и так уже упало */
  }
}

/** Одна строка вместо стека: в ленте читают её, а стек всё равно ниже. */
function describe(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** Секундомер. `ms()` возвращает целые миллисекунды от момента вызова `timer()`. */
export function timer(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}
