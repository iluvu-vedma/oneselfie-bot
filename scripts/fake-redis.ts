/**
 * Заглушка Redis для прогонов без сети.
 * Проверяет ЛОГИКУ (что мы смотрим на результат DECRBY, а не читаем-пишем объект),
 * а не саму атомарность — её обеспечивает настоящий Redis.
 */
type Entry = { v: any; exp?: number };

export class FakeRedis {
  private m = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  private hash(key: string): Record<string, any> {
    const e = this.live(key);
    if (e) return e.v;
    const v: Record<string, any> = {};
    this.m.set(key, { v });
    return v;
  }

  async get(key: string) {
    const e = this.live(key);
    return e === undefined ? null : e.v;
  }
  /**
   * Читает и стирает одной командой. На этом стоит переезд экрана вниз.
   * Между чтением и стиранием нет `await` — иначе заглушка не воспроизводила
   * бы ровно то свойство, ради которого GETDEL и взят вместо GET плюс DEL.
   */
  async getdel(key: string) {
    const e = this.live(key);
    if (e === undefined) return null;
    this.m.delete(key);
    return e.v;
  }
  async set(key: string, val: any, opts?: { nx?: boolean; ex?: number }) {
    if (opts?.nx && this.live(key) !== undefined) return null;
    this.m.set(key, { v: val, exp: opts?.ex ? Date.now() + opts.ex * 1000 : undefined });
    return "OK";
  }
  /** Понимает ровно один скрипт — compare-and-delete из releaseGenLock. */
  async eval(_script: string, keys: string[], args: any[]) {
    if ((await this.get(keys[0])) !== args[0]) return 0;
    return this.del(keys[0]);
  }
  async mget(...keys: string[]) {
    return Promise.all(keys.map((key) => this.get(key)));
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const key of keys) if (this.m.delete(key)) n++;
    return n;
  }
  async exists(key: string) {
    return this.live(key) === undefined ? 0 : 1;
  }
  async expire(key: string, sec: number) {
    const e = this.live(key);
    if (e) e.exp = Date.now() + sec * 1000;
    return 1;
  }
  /** Секунд до смерти ключа. -1 — живёт вечно, -2 — ключа нет. Как в Redis. */
  async ttl(key: string) {
    const e = this.live(key);
    if (e === undefined) return -2;
    return e.exp === undefined ? -1 : Math.ceil((e.exp - Date.now()) / 1000);
  }
  async incrby(key: string, by: number) {
    const cur = Number((await this.get(key)) ?? 0);
    const next = cur + by;
    const e = this.live(key);
    this.m.set(key, { v: next, exp: e?.exp });
    return next;
  }
  async decrby(key: string, by: number) {
    return this.incrby(key, -by);
  }
  async incr(key: string) {
    return this.incrby(key, 1);
  }
  async decr(key: string) {
    return this.incrby(key, -1);
  }
  async hset(key: string, obj: Record<string, any>) {
    Object.assign(this.hash(key), obj);
    return Object.keys(obj).length;
  }
  async hsetnx(key: string, field: string, val: any) {
    const h = this.hash(key);
    if (field in h) return 0;
    h[field] = val;
    return 1;
  }
  async hdel(key: string, ...fields: string[]) {
    const h = this.hash(key);
    let n = 0;
    for (const f of fields) if (delete h[f]) n++;
    return n;
  }
  async hget(key: string, field: string) {
    return this.hash(key)[field] ?? null;
  }
  async hgetall(key: string) {
    const h = this.live(key)?.v;
    return h && Object.keys(h).length ? h : null;
  }
  async hincrby(key: string, field: string, by: number) {
    const h = this.hash(key);
    h[field] = Number(h[field] ?? 0) + by;
    return h[field];
  }
  private list(key: string): any[] {
    const e = this.live(key);
    if (e) return e.v;
    const v: any[] = [];
    this.m.set(key, { v });
    return v;
  }
  async rpush(key: string, ...vals: any[]) {
    const list = this.list(key);
    list.push(...vals);
    return list.length;
  }
  /** Журналы растут вверх: новое сверху, старое подрезается с хвоста. */
  async lpush(key: string, ...vals: any[]) {
    const list = this.list(key);
    list.unshift(...vals);
    return list.length;
  }
  async ltrim(key: string, start: number, stop: number) {
    const list = this.list(key);
    const kept = stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
    list.length = 0;
    list.push(...kept);
    return "OK";
  }
  async lrange(key: string, start: number, stop: number) {
    const list: any[] = this.live(key)?.v ?? [];
    return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
  }
  async llen(key: string) {
    return (this.live(key)?.v ?? []).length;
  }
  /** Понимает обе формы: `zadd(key, item)` и `zadd(key, { nx: true }, item)`. */
  async zadd(
    key: string,
    a: { nx?: true } | { score: number; member: string },
    b?: { score: number; member: string }
  ) {
    const opts = b === undefined ? undefined : (a as { nx?: true });
    const item = (b ?? a) as { score: number; member: string };
    const e = this.live(key);
    const z: Map<string, number> = e ? e.v : new Map();
    if (!e) this.m.set(key, { v: z });
    if (opts?.nx && z.has(item.member)) return null;
    z.set(item.member, item.score);
    return 1;
  }
  /**
   * Без `byScore` это диапазон по порядку, а не по счёту — на этом стоит
   * список последних людей, и подменять одно другим нельзя.
   */
  async zrange(
    key: string,
    min: number,
    max: number,
    o?: { byScore?: boolean; rev?: boolean; withScores?: boolean }
  ) {
    const z: Map<string, number> = this.live(key)?.v ?? new Map();
    let items = [...z.entries()].sort((a, b) => a[1] - b[1]);
    if (o?.rev) items.reverse();
    items = o?.byScore
      ? items.filter(([, s]) => s >= min && s <= max)
      : items.slice(min, max === -1 ? undefined : max + 1);
    // Со счётами Redis отдаёт плоский список: член, счёт, член, счёт.
    // Возраст старейшей задачи в очереди читается именно так.
    if (o?.withScores) return items.flatMap(([mem, score]) => [mem, score]);
    return items.map(([mem]) => mem);
  }
  async zcard(key: string) {
    const z: Map<string, number> = this.live(key)?.v ?? new Map();
    return z.size;
  }
  async zrem(key: string, member: string) {
    const z: Map<string, number> = this.live(key)?.v ?? new Map();
    return z.delete(member) ? 1 : 0;
  }
}
