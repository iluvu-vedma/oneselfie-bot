/**
 * Прогон критичных мест состояния на заглушке KV.
 * Закрывает пункты приёмки про двойной тап, двойной коллбэк, единственный возврат
 * и единственное зачисление платежа.
 */
import { FakeRedis } from "./fake-redis";

// Подменяем модуль KV до того, как его затянет store.
const kvPath = require.resolve("../src/kv");
const fake = new FakeRedis();
const k = {
  user: (id: any) => `user:${id}`,
  balance: (id: any) => `bal:${id}`,
  photos: (id: any) => `photos:${id}`,
  photoSlots: (id: any) => `photoslots:${id}`,
  genLock: (id: any) => `gen:${id}`,
  task: (id: string) => `task:${id}`,
  payment: (id: string) => `pay:${id}`,
  pending: "pending",
  stat: (e: string) => `stat:${e}`,
};
require.cache[kvPath] = {
  id: kvPath,
  filename: kvPath,
  loaded: true,
  exports: {
    redis: fake,
    k,
    num: (v: unknown, f = 0) => (typeof v === "number" ? v : Number(v) || f),
    bump: async () => {},
  },
} as any;

const S = require("../src/store") as typeof import("../src/store");
const { SCENES } = require("../src/scenes") as typeof import("../src/scenes");

let failed = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failed++;
}

async function main() {
  const chat = 777;
  await S.ensureUser(chat);
  check((await S.getUser(chat)).status === "started", "профиль создан со статусом started");

  // Повторный /start ничего не сбрасывает.
  await S.credit(chat, 24);
  await S.ensureUser(chat);
  check((await S.getBalance(chat)) === 24, "повторный /start не сбросил баланс");

  // Двойной тап по «Сделать кадр»: замок пускает одного.
  const locks = await Promise.all([S.acquireGenLock(chat), S.acquireGenLock(chat)]);
  const token = locks.find(Boolean)!;
  check(locks.filter(Boolean).length === 1, `замок генерации взят один раз (${locks})`);

  // Опоздавший возврат по старой задаче не должен снимать чужой замок.
  await S.releaseGenLock(chat, "l-чужой-токен");
  check(await S.acquireGenLock(chat) === null, "чужой токен замок не снял");
  await S.releaseGenLock(chat, token);
  const reacquired = await S.acquireGenLock(chat);
  check(reacquired !== null, "свой токен замок снял");
  await S.releaseGenLock(chat, reacquired!);

  // Списание: два подряд при балансе 24 проходят, третье — нет, и баланс не уходит в минус.
  check((await S.trySpend(chat, 12)) === 12, "первое списание: остаток 12");
  check((await S.trySpend(chat, 12)) === 0, "второе списание: остаток 0");
  check((await S.trySpend(chat, 12)) === null, "третье списание отклонено");
  check((await S.getBalance(chat)) === 0, "баланс не ушёл в минус");

  // Селфи: пятое не пролезает.
  const slots: (number | null)[] = [];
  for (let i = 0; i < 5; i++) slots.push(await S.reservePhotoSlot(chat));
  check(
    slots.filter((s) => s !== null).length === 4 && slots[4] === null,
    `принято 4 слота, пятый отклонён (${slots.join(",")})`
  );

  // Курсор сценариев идёт по кругу и не повторяется на соседях.
  const seen: number[] = [];
  for (let i = 0; i < SCENES.length + 1; i++) seen.push(await S.nextSceneIndex(chat));
  check(seen[0] === 0 && seen[SCENES.length] === 0, "курсор сценариев замкнулся по кругу");
  check(new Set(seen.slice(0, SCENES.length)).size === SCENES.length, "за круг ни одного повтора");

  // Задача: выдача и возврат — строго по одному разу.
  await S.createTaskRecord("t1", chat, 3, 12, "lock-1");
  const sends = await Promise.all([S.claimSend("t1"), S.claimSend("t1")]);
  check(sends.filter(Boolean).length === 1, `двойной коллбэк отдаёт кадр один раз (${sends})`);

  await S.createTaskRecord("t2", chat, 4, 12, "lock-2");
  const refunds = await Promise.all([S.claimRefund("t2"), S.claimRefund("t2")]);
  check(refunds.filter(Boolean).length === 1, `возврат искр происходит один раз (${refunds})`);

  const t2 = await S.getTask("t2");
  check(
    t2?.cost === 12 && t2.refunded === true && t2.lock === "lock-2",
    "стоимость и токен замка лежат в задаче, а не берутся из константы"
  );

  // Платёж зачисляется ровно один раз.
  const pays = await Promise.all([S.claimPayment("charge-1"), S.claimPayment("charge-1")]);
  check(pays.filter(Boolean).length === 1, `искры зачисляются один раз на платёж (${pays})`);

  // Аварийный добор видит только просроченные задачи.
  const stale = await S.pendingOlderThan(Date.now() + 1000);
  check(stale.length === 2 && stale.includes("t1"), `в очереди добора: ${stale.join(",")}`);
  await S.forgetPending("t1");
  check((await S.pendingOlderThan(Date.now() + 1000)).length === 1, "выданная задача ушла из очереди");

  // /new: селфи сбрасываются, баланс остаётся.
  await S.credit(chat, 60);
  await S.clearPhotos(chat);
  check(
    (await S.getPhotos(chat)).length === 0 && (await S.getBalance(chat)) === 60,
    "/new сбросил селфи и сохранил баланс"
  );

  console.log(failed === 0 ? "\nВсё сошлось." : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
