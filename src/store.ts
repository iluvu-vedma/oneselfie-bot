import { redis, k, num, bump } from "./kv";
import { GEN_LOCK_TTL_SEC, HUB_TTL_SEC, MAX_PHOTOS, TASK_TTL_SEC } from "./config";
import { SCENES } from "./scenes";

export type UserStatus = "started" | "photos_ready" | "paid";

export interface UserProfile {
  status: UserStatus;
  /** Имя из Telegram. Нужно приветствию, которое рисуется и без входящего апдейта. */
  name: string;
  fails: number;
  createdAt: number;
}

export interface TaskRecord {
  chatId: number;
  sceneIndex: number;
  /** Сколько искр снято — столько и вернём. Не берётся из константы при возврате. */
  cost: number;
  /** Токен замка генерации, выданный при списании. */
  lock: string;
  sent: boolean;
  refunded: boolean;
  createdAt: number;
}

// ── Профиль ──────────────────────────────────────────────────────────────────

/** Создаёт профиль, если его нет. Повторный /start ничего не сбрасывает. */
export async function ensureUser(chatId: number): Promise<boolean> {
  const created = await redis.hsetnx(k.user(chatId), "createdAt", Date.now());
  if (created) {
    await redis.hset(k.user(chatId), { status: "started", fails: 0, sceneIndex: 0 });
    await bump("start_new");
  }
  return created === 1;
}

export async function getUser(chatId: number): Promise<UserProfile> {
  const raw = (await redis.hgetall<Record<string, unknown>>(k.user(chatId))) ?? {};
  return {
    status: (raw.status as UserStatus) ?? "started",
    name: raw.name ? String(raw.name) : "",
    fails: num(raw.fails),
    createdAt: num(raw.createdAt),
  };
}

/** Имя запоминается, а не берётся из апдейта: экран перерисовывается и по крону. */
export async function setName(chatId: number, name: string): Promise<void> {
  if (name) await redis.hset(k.user(chatId), { name });
}

export async function setStatus(chatId: number, status: UserStatus): Promise<void> {
  await redis.hset(k.user(chatId), { status });
}

/** Курсор по пулу сценариев. HINCRBY атомарен — два кадра подряд не получат один сценарий. */
export async function nextSceneIndex(chatId: number): Promise<number> {
  const n = await redis.hincrby(k.user(chatId), "sceneIndex", 1);
  return (num(n) - 1) % SCENES.length;
}

export async function bumpFails(chatId: number): Promise<number> {
  return num(await redis.hincrby(k.user(chatId), "fails", 1));
}

export async function resetFails(chatId: number): Promise<void> {
  await redis.hset(k.user(chatId), { fails: 0 });
}

// ── Баланс ───────────────────────────────────────────────────────────────────

export async function getBalance(chatId: number): Promise<number> {
  return num(await redis.get(k.balance(chatId)));
}

export async function credit(chatId: number, sparks: number): Promise<number> {
  return num(await redis.incrby(k.balance(chatId), sparks));
}

/**
 * Атомарное списание. Возвращает остаток или null, если денег не хватило.
 * Сначала DECRBY, потом проверка: между чтением и записью не остаётся щели.
 */
export async function trySpend(chatId: number, cost: number): Promise<number | null> {
  const after = num(await redis.decrby(k.balance(chatId), cost));
  if (after < 0) {
    await redis.incrby(k.balance(chatId), cost);
    return null;
  }
  return after;
}

// ── Замок генерации ──────────────────────────────────────────────────────────

/** Снимает замок, только если он всё ещё наш. */
const UNLOCK_LUA =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0';

/** Токен замка или null, если кадр уже готовится. */
export async function acquireGenLock(chatId: number): Promise<string | null> {
  const token = `l${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const res = await redis.set(k.genLock(chatId), token, {
    nx: true,
    ex: GEN_LOCK_TTL_SEC,
  });
  return res === "OK" ? token : null;
}

/**
 * Токен обязателен: если замок успел протухнуть и человек начал новый кадр,
 * опоздавший возврат по старой задаче не должен снимать чужой замок.
 */
export async function releaseGenLock(chatId: number, token?: string): Promise<void> {
  if (!token) {
    await redis.del(k.genLock(chatId));
    return;
  }
  await redis.eval(UNLOCK_LUA, [k.genLock(chatId)], [token]);
}

/** Идёт ли прямо сейчас генерация. Экран «идёт работа» выводится из этого, а не из флага в профиле. */
export async function isGenerating(chatId: number): Promise<boolean> {
  return (await redis.exists(k.genLock(chatId))) === 1;
}

// ── Экран ────────────────────────────────────────────────────────────────────

/** message_id текущего экрана или null, если экрана ещё нет. */
export async function getHubId(chatId: number): Promise<number | null> {
  const id = num(await redis.get(k.hub(chatId)));
  return id > 0 ? id : null;
}

export async function setHubId(chatId: number, messageId: number): Promise<void> {
  await redis.set(k.hub(chatId), messageId, { ex: HUB_TTL_SEC });
}

/**
 * Читает и сразу забывает id: экран сейчас переедет вниз, и старый message_id
 * не должен пережить неудачное удаление — иначе бот будет править сообщение,
 * которого пользователь уже не видит.
 */
export async function takeHubId(chatId: number): Promise<number | null> {
  const id = await getHubId(chatId);
  if (id !== null) await redis.del(k.hub(chatId));
  return id;
}

// ── Селфи ────────────────────────────────────────────────────────────────────

export async function getPhotos(chatId: number): Promise<string[]> {
  const list = await redis.lrange<string>(k.photos(chatId), 0, -1);
  return (list ?? []).map(String);
}

export async function photoCount(chatId: number): Promise<number> {
  return num(await redis.llen(k.photos(chatId)));
}

/**
 * Резервирует слот под фото ДО загрузки в kie.
 * Иначе четыре фото из одного альбома приезжают параллельно и пролезает пятое.
 */
export async function reservePhotoSlot(chatId: number): Promise<number | null> {
  const slot = num(await redis.incr(k.photoSlots(chatId)));
  if (slot > MAX_PHOTOS) {
    await redis.decr(k.photoSlots(chatId));
    return null;
  }
  return slot;
}

export async function releasePhotoSlot(chatId: number): Promise<void> {
  await redis.decr(k.photoSlots(chatId));
}

export async function addPhotoUrl(chatId: number, url: string): Promise<number> {
  return num(await redis.rpush(k.photos(chatId), url));
}

/** /new: селфи сбрасываются, баланс искр остаётся — он привязан к человеку, а не к фото. */
export async function clearPhotos(chatId: number): Promise<void> {
  await redis.del(k.photos(chatId), k.photoSlots(chatId));
  await setStatus(chatId, "started");
}

// ── Задачи ───────────────────────────────────────────────────────────────────

export async function createTaskRecord(
  taskId: string,
  chatId: number,
  sceneIndex: number,
  cost: number,
  lock: string
): Promise<void> {
  const now = Date.now();
  // sent и refunded НЕ пишутся заранее: claimSend/claimRefund держатся на HSETNX,
  // а он не сработает, если поле уже существует. Отсутствие поля и значит «ещё нет».
  await redis.hset(k.task(taskId), { chatId, sceneIndex, cost, lock, createdAt: now });
  await redis.expire(k.task(taskId), TASK_TTL_SEC);
  await redis.zadd(k.pending, { score: now, member: taskId });
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
  const raw = await redis.hgetall<Record<string, unknown>>(k.task(taskId));
  if (!raw || raw.chatId === undefined) return null;
  return {
    chatId: num(raw.chatId),
    sceneIndex: num(raw.sceneIndex),
    cost: num(raw.cost),
    lock: raw.lock ? String(raw.lock) : "",
    sent: num(raw.sent) === 1,
    refunded: num(raw.refunded) === 1,
    createdAt: num(raw.createdAt),
  };
}

/**
 * Идемпотентность выдачи. HSETNX ставит флаг только если его ещё не было,
 * поэтому из двух одновременных коллбэков true получит ровно один.
 */
export async function claimSend(taskId: string): Promise<boolean> {
  return (await redis.hsetnx(k.task(taskId), "sent", 1)) === 1;
}

/** Идемпотентность возврата. Тот же приём, отдельный флаг. */
export async function claimRefund(taskId: string): Promise<boolean> {
  return (await redis.hsetnx(k.task(taskId), "refunded", 1)) === 1;
}

export async function forgetPending(taskId: string): Promise<void> {
  await redis.zrem(k.pending, taskId);
}

/** Задачи старше cutoff, всё ещё висящие без результата. */
export async function pendingOlderThan(cutoffMs: number, limit = 25): Promise<string[]> {
  const ids = await redis.zrange<string[]>(k.pending, 0, cutoffMs, { byScore: true });
  return (ids ?? []).slice(0, limit).map(String);
}

// ── Платежи ──────────────────────────────────────────────────────────────────

/** true — этот платёж ещё не зачисляли. Второй вызов вернёт false. */
export async function claimPayment(chargeId: string): Promise<boolean> {
  const res = await redis.set(k.payment(chargeId), Date.now(), {
    nx: true,
    ex: 60 * 60 * 24 * 30,
  });
  return res === "OK";
}

/**
 * Отмечает, что селфи собраны. Возвращает true только в первый раз —
 * счётчик воронки должен считать людей, а не повторные загрузки.
 */
export async function markPhotosReady(chatId: number): Promise<boolean> {
  await setStatus(chatId, "photos_ready");
  return (await redis.hsetnx(k.user(chatId), "photosCounted", 1)) === 1;
}

/** То же для пейволла: в воронке считаем людей, а не показы. */
export async function markPaywallShown(chatId: number): Promise<boolean> {
  return (await redis.hsetnx(k.user(chatId), "paywallCounted", 1)) === 1;
}
