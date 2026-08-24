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
  hub: (id: any) => `hub:${id}`,
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
const { MODELS } = require("../src/config") as typeof import("../src/config");

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

  // Модель, источник и адрес возврата с пополнения живут в профиле.
  check((await S.getModel(chat)) === null, "модель не выбрана — воронки ещё нет");
  await S.setModel(chat, "nbpro");
  await S.setSource(chat, "photo");
  await S.setTopupFrom(chat, "nbpro");
  const user = await S.getUser(chat);
  check(user.model === "nbpro" && user.source === "photo", "модель и источник запомнились");
  check(user.topupFrom === "nbpro", "«Назад» с пополнения вернёт на экран модели");

  // Мусор в KV не должен пролезть в экран: реестр моделей меняется между деплоями.
  await fake.hset(k.user(chat), { model: "nano-banana-9000" });
  check((await S.getModel(chat)) === null, "неизвестная модель из KV читается как «не выбрана»");
  await S.setModel(chat, "nb2");

  // Двойной тап: замок пускает одного.
  const locks = await Promise.all([S.acquireGenLock(chat), S.acquireGenLock(chat)]);
  const token = locks.find(Boolean)!;
  check(locks.filter(Boolean).length === 1, `замок генерации взят один раз (${locks})`);

  // Опоздавший возврат по старой задаче не должен снимать чужой замок.
  await S.releaseGenLock(chat, "l-чужой-токен");
  check((await S.acquireGenLock(chat)) === null, "чужой токен замок не снял");
  await S.releaseGenLock(chat, token);
  const reacquired = await S.acquireGenLock(chat);
  check(reacquired !== null, "свой токен замок снял");
  await S.releaseGenLock(chat, reacquired!);

  // Списание: цена берётся из модели, третье списание не проходит.
  const price = MODELS.nb2.price; // 12
  check((await S.trySpend(chat, price)) === 12, `первое списание ${price}: остаток 12`);
  check((await S.trySpend(chat, price)) === 0, "второе списание: остаток 0");
  check((await S.trySpend(chat, price)) === null, "третье списание отклонено");
  check((await S.getBalance(chat)) === 0, "баланс не ушёл в минус");

  // Селфи: пятое не пролезает.
  const slots: (number | null)[] = [];
  for (let i = 0; i < 5; i++) slots.push(await S.reservePhotoSlot(chat));
  check(
    slots.filter((s) => s !== null).length === 4 && slots[4] === null,
    `принято 4 слота, пятый отклонён (${slots.join(",")})`
  );

  // Задача: модель и промпт лежат в ней, а не берутся из состояния при выдаче —
  // человек мог за это время выбрать другую модель.
  await S.createTaskRecord("t1", chat, "nbpro", "кот в скафандре", 20, "lock-1");
  const sends = await Promise.all([S.claimSend("t1"), S.claimSend("t1")]);
  check(sends.filter(Boolean).length === 1, `двойной коллбэк отдаёт кадр один раз (${sends})`);
  const t1 = await S.getTask("t1");
  check(
    t1?.model === "nbpro" && t1.prompt === "кот в скафандре" && t1.cost === 20,
    "модель, промпт и цена лежат в задаче"
  );

  await S.createTaskRecord("t2", chat, "gpt2", "закат", 10, "lock-2");
  const refunds = await Promise.all([S.claimRefund("t2"), S.claimRefund("t2")]);
  check(refunds.filter(Boolean).length === 1, `возврат искр происходит один раз (${refunds})`);

  const t2 = await S.getTask("t2");
  check(
    t2?.cost === 10 && t2.refunded === true && t2.lock === "lock-2",
    "стоимость и токен замка лежат в задаче, а не берутся из константы"
  );

  // Платёж зачисляется ровно один раз.
  const pays = await Promise.all([S.claimPayment("charge-1"), S.claimPayment("charge-1")]);
  check(pays.filter(Boolean).length === 1, `искры зачисляются один раз на платёж (${pays})`);

  // Аварийный добор видит только просроченные задачи.
  const stale = await S.pendingOlderThan(Date.now() + 1000);
  check(stale.length === 2 && stale.includes("t1"), `в очереди добора: ${stale.join(",")}`);
  await S.forgetPending("t1");
  check(
    (await S.pendingOlderThan(Date.now() + 1000)).length === 1,
    "выданная задача ушла из очереди"
  );

  // Экран: id читается один раз и сразу забывается — иначе после переезда вниз
  // бот будет править сообщение, которого пользователь уже не видит.
  await S.setHubId(chat, 4242);
  check((await S.getHubId(chat)) === 4242, "id экрана запомнился");
  check((await S.takeHubId(chat)) === 4242, "takeHubId вернул id");
  check((await S.getHubId(chat)) === null, "takeHubId забыл id");
  check((await S.takeHubId(chat)) === null, "второй takeHubId ничего не вернул");

  // Стадия «идёт работа» выводится из замка, а не из отдельного флага.
  check((await S.isGenerating(chat)) === false, "без замка генерация не идёт");
  const genToken = (await S.acquireGenLock(chat))!;
  check((await S.isGenerating(chat)) === true, "с замком генерация идёт");
  await S.releaseGenLock(chat, genToken);

  // «Заменить фото»: селфи сбрасываются, баланс и выбранная модель остаются.
  await S.credit(chat, 60);
  await S.clearPhotos(chat);
  check(
    (await S.getPhotos(chat)).length === 0 &&
      (await S.getBalance(chat)) === 60 &&
      (await S.getModel(chat)) === "nb2",
    "сброс фото сохранил баланс и выбранную модель"
  );

  console.log(failed === 0 ? "\nВсё сошлось." : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
