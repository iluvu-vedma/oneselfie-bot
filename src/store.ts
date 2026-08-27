import { redis, k, num, bump } from "./kv";
import {
  CHAT_LOCK_TTL_SEC,
  GEN_LOCK_TTL_SEC,
  HUB_TTL_SEC,
  MAX_PHOTOS,
  PHOTO_TTL_SEC,
  ModelId,
  SWEEP_BATCH,
  TASK_TTL_SEC,
  isModelId,
} from "./config";

export type UserStatus = "started" | "photos_ready" | "paid";

/** Откуда берётся кадр: из своих фото или из одного текста. */
export type Source = "photo" | "text";

export interface UserProfile {
  status: UserStatus;
  /** Имя из Telegram. Нужно приветствию, которое рисуется и без входящего апдейта. */
  name: string;
  /**
   * @username без собачки. Единственный способ найти человека в админке иначе,
   * чем по числовому id, — метода «дай id по юзернейму» у Bot API нет.
   */
  username: string;
  /** Выбранная модель. null — человек ещё не доходил до выбора. */
  model: ModelId | null;
  source: Source | null;
  /** Куда вернуть по «Назад» с экрана пополнения. */
  topupFrom: string;
  fails: number;
  createdAt: number;
}

export interface TaskRecord {
  chatId: number;
  /** Какой моделью считали. Нужно экрану, который рисуется после выдачи. */
  model: ModelId | null;
  /** Что написал человек. Уходит в подпись под кадром — чтобы повторить. */
  prompt: string;
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
  const now = Date.now();
  const created = await redis.hsetnx(k.user(chatId), "createdAt", now);
  if (created) {
    await redis.hset(k.user(chatId), { status: "started", fails: 0 });
    await redis.zadd(k.users, { score: now, member: String(chatId) });
    await bump("start_new");
  }
  return created === 1;
}

export async function getUser(chatId: number): Promise<UserProfile> {
  const raw = (await redis.hgetall<Record<string, unknown>>(k.user(chatId))) ?? {};
  const source = raw.source === "photo" || raw.source === "text" ? raw.source : null;
  return {
    status: (raw.status as UserStatus) ?? "started",
    name: raw.name ? String(raw.name) : "",
    username: raw.username ? String(raw.username) : "",
    // Значение из KV не бывает доверенным: реестр моделей мог поменяться между деплоями.
    model: isModelId(raw.model) ? raw.model : null,
    source,
    topupFrom: raw.topupFrom ? String(raw.topupFrom) : "",
    fails: num(raw.fails),
    createdAt: num(raw.createdAt),
  };
}

/**
 * Имя и юзернейм запоминаются, а не берутся из апдейта: экран перерисовывается
 * и по крону, а админка ищет людей вообще без входящего сообщения.
 *
 * Здесь же чинится индекс людей: профили, заведённые до появления админки,
 * иначе не попали бы в список никогда. `nx` не даёт свежей дате затереть
 * настоящую дату регистрации у тех, кто уже в индексе.
 */
export async function touchUser(
  chatId: number,
  name?: string,
  username?: string
): Promise<void> {
  const patch: Record<string, string> = {};
  if (name) patch.name = name;
  if (username) patch.username = username;
  if (Object.keys(patch).length > 0) await redis.hset(k.user(chatId), patch);
  if (username) await redis.set(k.uname(username), chatId);
  await redis.zadd(k.users, { nx: true }, { score: Date.now(), member: String(chatId) });
}

export async function setStatus(chatId: number, status: UserStatus): Promise<void> {
  await redis.hset(k.user(chatId), { status });
}

export async function setModel(chatId: number, model: ModelId): Promise<void> {
  await redis.hset(k.user(chatId), { model });
}

export async function getModel(chatId: number): Promise<ModelId | null> {
  const raw = await redis.hget(k.user(chatId), "model");
  return isModelId(raw) ? raw : null;
}

export async function setSource(chatId: number, source: Source): Promise<void> {
  await redis.hset(k.user(chatId), { source });
}

/**
 * Куда вернуть по «Назад» с пополнения. Хранится callback_data целевого экрана:
 * человек, пришедший с экрана модели, не должен вылетать на корень и терять выбор.
 */
export async function setTopupFrom(chatId: number, ref: string): Promise<void> {
  await redis.hset(k.user(chatId), { topupFrom: ref });
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

/** Идёт ли прямо сейчас генерация. Экран busy выводится из этого, а не из флага в профиле. */
export async function isGenerating(chatId: number): Promise<boolean> {
  return (await redis.exists(k.genLock(chatId))) === 1;
}

// ── Очередь чата ─────────────────────────────────────────────────────────────
/**
 * Апдейты одного человека обрабатываются по очереди. Плагин `sequentialize`
 * из grammY тут бесполезен: он держит очередь в памяти процесса, а на Vercel
 * альбом из четырёх селфи приезжает в четыре разных процесса одновременно.
 * Общая очередь может жить только в KV.
 *
 * Токен тот же приём, что у замка генерации: свой замок снимается своим ключом,
 * чужой не трогается никогда.
 */
export async function acquireChatLock(chatId: number): Promise<string | null> {
  const token = `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const res = await redis.set(k.chatLock(chatId), token, {
    nx: true,
    ex: CHAT_LOCK_TTL_SEC,
  });
  return res === "OK" ? token : null;
}

export async function releaseChatLock(chatId: number, token: string): Promise<void> {
  await redis.eval(UNLOCK_LUA, [k.chatLock(chatId)], [token]);
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
 *
 * GETDEL, а не GET и следом DEL: между двумя командами помещается второй
 * процесс, и тогда один и тот же экран удаляют дважды, а новых присылают два.
 */
export async function takeHubId(chatId: number): Promise<number | null> {
  const id = num(await redis.getdel(k.hub(chatId)));
  return id > 0 ? id : null;
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
  // Срок ставится на первом слоте и больше не продлевается: счётчик обязан
  // умереть не позже списка ссылок, иначе слоты останутся заняты при пустом
  // списке и человек не сможет прислать новое селфи.
  if (slot === 1) await redis.expire(k.photoSlots(chatId), PHOTO_TTL_SEC);
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
  const length = num(await redis.rpush(k.photos(chatId), url));
  // Срок отсчитывается от ПЕРВОГО селфи, а не от последнего: в kie раньше всех
  // умрёт именно первый файл, и список должен уйти вместе с ним целиком.
  if (length === 1) await redis.expire(k.photos(chatId), PHOTO_TTL_SEC);
  return length;
}

/** Селфи сбрасываются, баланс искр остаётся — он привязан к человеку, а не к фото. */
export async function clearPhotos(chatId: number): Promise<void> {
  await redis.del(k.photos(chatId), k.photoSlots(chatId));
  await setStatus(chatId, "started");
}

// ── Задачи ───────────────────────────────────────────────────────────────────

export async function createTaskRecord(
  taskId: string,
  chatId: number,
  model: ModelId,
  prompt: string,
  cost: number,
  lock: string
): Promise<void> {
  const now = Date.now();
  // sent и refunded НЕ пишутся заранее: claimSend/claimRefund держатся на HSETNX,
  // а он не сработает, если поле уже существует. Отсутствие поля и значит «ещё нет».
  await redis.hset(k.task(taskId), { chatId, model, prompt, cost, lock, createdAt: now });
  await redis.expire(k.task(taskId), TASK_TTL_SEC);
  await redis.zadd(k.pending, { score: now, member: taskId });
  await redis.set(k.chatTask(chatId), taskId, { ex: TASK_TTL_SEC });
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
  const raw = await redis.hgetall<Record<string, unknown>>(k.task(taskId));
  if (!raw || raw.chatId === undefined) return null;
  return {
    chatId: num(raw.chatId),
    model: isModelId(raw.model) ? raw.model : null,
    prompt: raw.prompt === undefined || raw.prompt === null ? "" : String(raw.prompt),
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

/**
 * Задача, которую человек ждёт прямо сейчас. Указатель нарочно не стирается
 * после выдачи: добор всё равно перечитывает саму задачу и по флагам sent /
 * refunded видит, что делать больше нечего.
 */
export async function getChatTask(chatId: number): Promise<string | null> {
  const id = await redis.get<string>(k.chatTask(chatId));
  return id ? String(id) : null;
}

/** Задачи старше cutoff, всё ещё висящие без результата. */
export async function pendingOlderThan(
  cutoffMs: number,
  limit = SWEEP_BATCH
): Promise<string[]> {
  const ids = await redis.zrange<string[]>(k.pending, 0, cutoffMs, { byScore: true });
  return (ids ?? []).slice(0, limit).map(String);
}

/** Сколько задач висит без результата прямо сейчас. Первое число экрана здоровья. */
export async function pendingSize(): Promise<number> {
  return num(await redis.zcard(k.pending));
}

/**
 * Когда была заведена самая старая висящая задача, мс. 0 — очередь пуста.
 * Возраст старейшей задачи и есть ответ на вопрос «добор вообще работает?»:
 * при живом доборе он не превышает таймаута, при мёртвом растёт часами.
 */
export async function oldestPendingAt(): Promise<number> {
  const rows = await redis.zrange<(string | number)[]>(k.pending, 0, 0, {
    withScores: true,
  });
  return num(rows?.[1]);
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

/** То же для пополнения: в воронке считаем людей, а не показы. */
export async function markTopupShown(chatId: number): Promise<boolean> {
  return (await redis.hsetnx(k.user(chatId), "topupCounted", 1)) === 1;
}

// ── Люди для админки ─────────────────────────────────────────────────────────

/**
 * Карточка человека одним объектом. Собирается для карточки и для списков,
 * поэтому баланс лежит рядом с профилем, а не читается вторым заходом.
 */
export interface Person extends UserProfile {
  chatId: number;
  balance: number;
}

export async function getPerson(chatId: number): Promise<Person> {
  const [user, balance] = await Promise.all([getUser(chatId), getBalance(chatId)]);
  return { ...user, chatId, balance };
}

/** Последние зарегистрированные — новые сверху. */
export async function recentUsers(limit: number): Promise<number[]> {
  const ids = await redis.zrange<string[]>(k.users, 0, limit - 1, { rev: true });
  return (ids ?? []).map((id) => num(id)).filter((id) => id !== 0);
}

/** Сколько людей в индексе. Дашборд считает воронку от этого числа, а не от счётчика. */
export async function usersCount(): Promise<number> {
  return num(await redis.zcard(k.users));
}

/**
 * Люди пачкой. Профиль и баланс каждого — отдельные ключи, поэтому запросы
 * уходят параллельно: список из восьми не должен стоить восьми задержек подряд.
 */
export async function getPeople(ids: number[]): Promise<Person[]> {
  return Promise.all(ids.map((id) => getPerson(id)));
}

/**
 * Поиск по @username. Индекс наш, а юзернейм в Telegram можно сменить и отдать
 * другому человеку — поэтому найденный профиль обязан подтвердить юзернейм сам.
 * Иначе искры уехали бы не тому.
 */
export async function findByUsername(username: string): Promise<number | null> {
  const clean = username.replace(/^@/, "").trim();
  if (!clean) return null;
  const id = num(await redis.get(k.uname(clean)));
  if (id === 0) return null;
  const user = await getUser(id);
  return user.username.toLowerCase() === clean.toLowerCase() ? id : null;
}

/** Есть ли вообще такой профиль. Пустой хеш — человека в боте не было. */
export async function userExists(chatId: number): Promise<boolean> {
  return (await redis.exists(k.user(chatId))) === 1;
}

// ── Воронка по людям ─────────────────────────────────────────────────────────
/**
 * Счётчики `gen_*` и `paid_*` считают события, а воронка меряется людьми:
 * один человек с сорока кадрами не должен выглядеть как сорок дошедших.
 */

/** true — этот человек запустил свой первый кадр. */
export async function markGenerated(chatId: number): Promise<boolean> {
  return (await redis.hsetnx(k.user(chatId), "genCounted", 1)) === 1;
}

/** true — этот человек заплатил впервые. */
export async function markPaid(chatId: number): Promise<boolean> {
  return (await redis.hsetnx(k.user(chatId), "paidCounted", 1)) === 1;
}

// ── Состояние админа ─────────────────────────────────────────────────────────
/**
 * Админ ходит по своим экранам и иногда пишет текстом: id человека или сумму.
 * Отдельный ключ, а не поле в профиле, — админ и сам пользуется ботом, и его
 * воронка не должна путаться со служебным состоянием.
 */

/** Куда вернёт «Назад» с карточки: человек мог прийти из сбоев, из списка или из поиска. */
export type AdminBack = "home" | "fails" | "users" | "find";

export interface AdminState {
  /** Чью карточку смотрим. 0 — никого. */
  target: number;
  /**
   * Чего ждём от админа текстом: `find` — id или @username, `sum:<причина>` — число.
   * Пусто — админ ничего не пишет, и текст уходит в обычный сценарий бота.
   */
  wait: string;
  back: AdminBack;
}

function isAdminBack(v: unknown): v is AdminBack {
  return v === "home" || v === "fails" || v === "users" || v === "find";
}

export async function getAdminState(chatId: number): Promise<AdminState> {
  const raw = (await redis.hgetall<Record<string, unknown>>(k.admin(chatId))) ?? {};
  return {
    target: num(raw.target),
    wait: raw.wait ? String(raw.wait) : "",
    back: isAdminBack(raw.back) ? raw.back : "home",
  };
}

export async function setAdminTarget(chatId: number, target: number): Promise<void> {
  await redis.hset(k.admin(chatId), { target });
}

export async function setAdminBack(chatId: number, back: AdminBack): Promise<void> {
  await redis.hset(k.admin(chatId), { back });
}

/** Пустая строка снимает ожидание: текст снова уходит в обычный сценарий. */
export async function setAdminWait(chatId: number, wait: string): Promise<void> {
  await redis.hset(k.admin(chatId), { wait });
}
