/**
 * src/app/gachaService.js
 * ------------------------------------------------------------------
 * 用例编排层：把「找店 → 拉菜单 → 拉券 → 抽签」这条链路串成一个可复用的服务。
 *
 * 这一层负责所有 I/O 编排与缓存，领域层保持纯净（可离线测试）。
 */

import { Catalog, applyAvoidRules, ALLERGY_RULES } from '../domain/catalog.js';
import { gacha, DIET_GOALS } from '../domain/gacha.js';
import { rerollSlot, confirmCombination } from '../domain/reveal.js';
import { funName, scenePrefix } from '../domain/naming.js';
import { McdAdapter } from '../infra/mcdAdapter.js';

export class GachaService {
  #adapter;
  #cache = new Map(); // address -> { store, catalog, coupons, clock, at }
  #orderLocks = new Map(); // "order:<storeId>" -> { state: 'inflight'|'done', at, created }
  cacheTtlMs = 5 * 60 * 1000;
  // 下单成功后的冷却时长：这段时间内同一门店拒绝再次下单，
  // 防的是「用户双击确认」和「页面卡了用户再点一次」这两种真实误操作。
  orderCooldownMs = 3 * 60 * 1000;

  constructor(adapter) {
    this.#adapter = adapter;
  }

  static async fromEnv() {
    return new GachaService(await McdAdapter.fromEnv());
  }

  /**
   * 拉取某地址门店的完整上下文（菜单 + 券 + 营养）。
   * 带 TTL 缓存：扭蛋机是「连扭多次」的场景，重复打接口既慢又浪费配额。
   */
  async loadContext(address) {
    const cached = this.#cache.get(address);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) return cached;

    const store = await this.#adapter.findNearbyStore(address);
    if (!store) {
      throw Object.assign(new Error(`没找到「${address}」附近的麦当劳门店，换个说法试试？`), { code: 'MCD-2001' });
    }

    // 三块数据互不依赖，并行拉取，把等待时间压到最短。
    // 每块都单独兜底：营养表拿不到就降级为「不显示营养」，
    // 而不是让整个扭蛋失败——这符合「不请求无关权限」也「不因附属功能拖垮主流程」。
    const [meals, coupons, nutrition, clock] = await Promise.all([
      this.#adapter.listMeals().catch(() => []),
      this.#adapter.listStoreCoupons().catch(() => []),
      this.#adapter.listNutrition().catch(() => new Map()),
      this.#adapter.now().catch(() => null),
    ]);

    const context = {
      store,
      catalog: new Catalog({ meals, coupons, nutrition }),
      coupons,
      clock,
      at: Date.now(),
    };
    this.#cache.set(address, context);
    return context;
  }

  /**
   * 完整扭一次。
   * @param {{address:string, budget:number, itemMax?:number, mustInclude?:string[],
   *          avoidTags?:string[], dietGoal?:string, peopleCount?:number}} params
   */
  async spin(rawParams) {
    // 参数归一化：CLI / HTTP / 网页各层的字段名不完全一致（avoid / avoidTags、
    // diet / dietGoal、people / peopleCount），在这里统一一次。
    // 少了这层，一旦某个入口拼错字段名，忌口会静默失效——用户以为避开了辣，
    // 结果还是抽到香辣鸡腿堡，而代码里看不出任何异常。
    const params = normalizeParams(rawParams);
    const { address } = params;
    const { store, catalog, clock } = await this.loadContext(address);

    // 忌口过滤在这里做，不污染缓存的 catalog——同一门店换个忌口重抽不用重新拉接口
    const { kept, filteredOut } = applyAvoidRules(catalog, params.avoidTags);
    const filteredCatalog = new Catalog({
      meals: kept,
      coupons: catalog.coupons,
      nutrition: catalog.nutrition,
    });

    const result = gacha({
      catalog: filteredCatalog,
      constraints: params,
    });

    if (!result.ok) {
      return {
        ...result,
        store,
        clock,
        options: {
          budget: params.budget,
          itemMax: params.itemMax,
          avoidTags: params.avoidTags ?? [],
          dietGoal: params.dietGoal ?? 'none',
          mustInclude: params.mustInclude ?? [],
          peopleCount: params.peopleCount ?? 1,
        },
        catalogStats: {
          total: catalog.size,
          afterAvoid: filteredCatalog.size,
          filteredOut: filteredOut.slice(0, 20).map((m) => ({ name: m.name, blockedBy: m.blockedBy })),
        },
        suggestAdjustments: suggestAdjustments(filteredCatalog, params, result.reason),
      };
    }

    return {
      ...result,
      store,
      clock,
      // 时段标签：让揭晓文案贴合当下场景，而不是永远泛泛地"今日搭配"
      sceneLabel: sceneLabel(clock),
      // 趣味组合名由领域层统一生成，CLI 与网页共用同一套逻辑
      funName: funName(result),
      scenePrefix: scenePrefix(sceneLabel(clock)),
      options: { ...params },
      catalogStats: {
        total: catalog.size,
        afterAvoid: filteredCatalog.size,
        filteredOut: filteredOut.slice(0, 20).map((m) => ({ name: m.name, blockedBy: m.blockedBy })),
      },
    };
  }

  /**
   * 确认搭配并创建订单。
   *
   * 这是全流程唯一会产生真实订单的地方，所以刻意设计得「多重确认」：
   *   1. 必须由用户显式调用（扭蛋、拉杆、重抽、分享都不会走到这里）
   *   2. 调用前先 auto-bind-coupons 领券，确保用的是最新最优的券
   *   3. 后端有并发锁，同一门店同时只允许一笔下单请求，避免重复提交
   *
   * @param {{address, current, peopleCount}} params
   */
  async placeOrder({ address, current, peopleCount }) {
    const { store, catalog } = await this.loadContext(address);

    // 并发保护。
    //
    // 注意这里的锁语义：不能只在「请求进行中」加锁。
    // 真实场景是用户双击——第一次下单完成后锁就释放了，第二次点击会真的再下一单。
    // 所以用的是「一段时间内只允许成功一单」的冷却锁：
    //   - 请求在途 → 直接拒绝（MCD-3002）
    //   - 刚成功过 → 拒绝（MCD-3003），提示这次订单已创建
    // 失败则立即释放锁，允许重试（失败时本来就没产生订单）。
    const lockKey = `order:${store.storeId}`;
    const nowMs = Date.now();
    const existing = this.#orderLocks.get(lockKey);

    if (existing) {
      if (existing.state === 'inflight') {
        return { ok: false, code: 'MCD-3002', error: '上一笔订单正在创建中，请稍候再试' };
      }
      if (existing.state === 'done' && nowMs - existing.at < this.orderCooldownMs) {
        return {
          ok: false,
          code: 'MCD-3003',
          error: '刚刚已经创建过订单了，为避免重复下单请先到官方渠道核对',
          created: existing.created,
        };
      }
    }

    this.#orderLocks.set(lockKey, { state: 'inflight', at: nowMs });

    try {
      const confirmed = confirmCombination({ current, storeId: store.storeId, peopleCount });
      if (!confirmed.ok) {
        // 参数校验没过，没产生任何订单，立即解锁让用户改完再来
        this.#orderLocks.delete(lockKey);
        return confirmed;
      }

      // 领券后再下单，避免用户少用了刚领到的券
      let coupons = catalog.coupons;
      try {
        const mine = await this.#adapter.bindAndListCoupons();
        if (mine.length > 0) coupons = mine;
      } catch {
        // 领券失败不阻断：门店券仍可用
      }

      // 用最新的券重新算一次实付价
      const adjusted = recheckPriceWithCoupons(confirmed.order, coupons);

      // 只把 MCP 下单真正需要的字段传下去。
      // adjusted.order 是「内部订单结构」（含名称、价格、品类等展示字段），
      // 直接整个丢给适配器会让 MCP 层收下一堆它不认识的字段——
      // 字段映射必须发生在适配器里，不能靠调用方传对。
      const created = await this.#adapter.createOrder({
        storeId: store.storeId,
        items: adjusted.items.map((i) => ({ code: i.code, qty: i.qty ?? 1 })),
        couponId: adjusted.coupon?.id ?? null,
        peopleCount,
      });

      // 订单已创建。把锁从「在途」转为「已成功」，
      // 这样冷却期内的重复提交会被 MCD-3003 拦掉，而不是真的再下一单。
      this.#orderLocks.set(lockKey, { state: 'done', at: Date.now(), created });

      return {
        ok: true,
        summary: confirmed.summary,
        order: adjusted,
        created,
        needsUserConfirm: true,
      };
    } catch (error) {
      // 下单失败：没拿到订单号，说明大概率没产生订单（但用户仍需自行核对）。
      // 立即释放锁允许重试——这里不做自动重试，避免重复下单。
      this.#orderLocks.delete(lockKey);
      throw error;
    }
    // 注意：成功路径不删除锁，而是由冷却锁继续拦截重复提交
  }

  /** 重抽单个槽位。address 相同则复用缓存。 */
  async reroll({ address, current, slot, rng }) {
    const { catalog } = await this.loadContext(address);
    const result = await rerollSlot({ catalog, current, slot, rng });
    // 商品变了，组合名也要跟着重算，否则会出现「名不副实」
    if (result.ok) result.result.funName = funName(result.result);
    return result;
  }

  /** 确认搭配并生成订单结构 */
  async confirm({ address, current, peopleCount }) {
    const { store } = await this.loadContext(address);
    return confirmCombination({ current, storeId: store.storeId, peopleCount });
  }

  /** 透出健康检查，供 CLI 的 doctor 命令使用 */
  async adapterHealthCheck() {
    return this.#adapter.healthCheck();
  }

  /** 展示能力清单，让用户知道自己能设什么条件 */
  capabilities() {    return {
      avoidTags: Object.entries(ALLERGY_RULES).map(([key, v]) => ({ key, label: v.label })),
      dietGoals: Object.entries(DIET_GOALS).map(([key, v]) => ({ key, label: v.label })),
      defaultConstraints: {
        budget: 40,
        itemMax: 30,
        mustInclude: [],
        avoidTags: [],
        dietGoal: 'none',
        peopleCount: 1,
      },
    };
  }
}

/**
 * 时段标签。麦当劳的菜单在早中晚差别很大，把时段摊在结果上，
 * 揭晓文案才不���「不管什么时候都是同一句推荐」。
 * 时间优先取 MCP 的 now-time-info，拿不到就用本机时间兜底。
 */
function sceneLabel(clock) {
  const hour = Number.isFinite(clock?.hour) ? clock.hour : new Date().getHours();
  if (hour < 5) return '深夜档';
  if (hour < 10) return '早餐档';
  if (hour < 14) return '午餐档';
  if (hour < 17) return '下午茶档';
  if (hour < 21) return '晚餐档';
  return '夜宵档';
}

/**
 * 用最新的券重新核对实付价。
 * 不改商品明细，只重算应付金额——券变了，价就得跟着变。
 */
function recheckPriceWithCoupons(order, coupons) {
  const usable = (coupons ?? []).filter(
    (c) => c.threshold === 0 || order.totalCents >= c.threshold
  );
  const best = usable.length
    ? usable.sort((a, b) => b.amount / order.totalCents - a.amount / order.totalCents)[0]
    : null;
  return {
    ...order,
    coupon: best,
    payCents: best ? Math.max(0, order.totalCents - best.amount) : order.totalCents,
  };
}

/**
 * 把各入口传来的参数统一成内部契约。
 * 入口层的字段名对使用者更友好（CLI 敲 --avoid，网页传 avoid），
 * 但内部只认 avoidTags / dietGoal / peopleCount 这一套。
 */
export function normalizeParams(raw = {}) {
  const toList = (v) =>
    (Array.isArray(v) ? v : String(v ?? '').split(/[,，]/))
      .map((s) => String(s).trim())
      .filter(Boolean);

  return {
    address: String(raw.address ?? '').trim(),
    // 金额：分单位的键优先，其次元单位的键
    budget: numOr(raw.budget, raw.budgetCents != null ? raw.budgetCents / 100 : 40),
    itemMax: numOr(raw.itemMax, raw.itemMaxCents != null ? raw.itemMaxCents / 100 : 30),
    budgetCents: raw.budgetCents,
    itemMaxCents: raw.itemMaxCents,
    mustInclude: toList(raw.must ?? raw.mustInclude),
    avoidTags: toList(raw.avoid ?? raw.avoidTags),
    dietGoal: raw.diet ?? raw.dietGoal ?? 'none',
    peopleCount: Number(raw.people ?? raw.peopleCount) || 1,
  };
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 抽不出来时，别只说「失败」，要给出「你改什么就能成」的具体建议。
 * 这是产品可用性的关键——参数求解失败时，用户最需要的是下一步动作。
 */
function suggestAdjustments(catalog, params, reason) {
  const tips = [];
  if (reason) tips.push(reason);

  if (catalog.size === 0) {
    tips.push('当前忌口把所有商品都排除了，可以先放开一项试试');
    return tips;
  }

  const range = catalog.priceRange();
  const budgetYuan = Number(params.budget) || 40;
  const itemMaxYuan = Number(params.itemMax) || 30;

  if (range.min / 100 > budgetYuan) {
    tips.push(`最便宜的商品也要 ${(range.min / 100).toFixed(2)} 元，预算建议提到这个数以上`);
  }
  if (itemMaxYuan < range.min / 100) {
    tips.push(`单品上限 ${itemMaxYuan} 元低于最便宜的商品（${(range.min / 100).toFixed(2)} 元），把单品上限调到 ${Math.ceil(range.min / 100)} 元`);
  }
  if ((params.mustInclude ?? []).length >= 3) {
    tips.push('必选项超过 2 个时预算容易不够，建议保留 1～2 个最想要的');
  }
  if (catalog.size <= 3) {
    tips.push('过滤后可选商品太少，放开忌口会有更多花样');
  }
  if (tips.length === 1) {
    tips.push(`当前条件下约有 ${catalog.size} 样可选，把预算提到 ${Math.ceil((range.min / 100) * 2)} 元会有更丰富的组合`);
  }
  return tips;
}
