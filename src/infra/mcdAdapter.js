/**
 * src/infra/mcdAdapter.js
 * ------------------------------------------------------------------
 * 把麦当劳 MCP 的各个 Tool 返回，翻译成麦麦扭蛋机内部统一使用的「领域模型」。
 *
 * 为什么需要这一层：
 *   MCP 的返回结构是按「接口」组织的（门店一个样、菜单一个样、券又一个样），
 *   而抽签算法需要的是「商品」和「门店」的统一视图。
 *   如果让领域层直接依赖 MCP 的原始结构，MCP 哪天改字段就会把抽签逻辑一起带崩。
 *   所以这里做一次收敛：外部结构变动的风险全部封在本文件内。
 *
 * 涉及的 MCP Tool（详见 MCP_INTEGRATION.md）：
 *   - query-nearby-stores   找附近门店
 *   - query-store-coupons   查门店可用券
 *   - auto-bind-coupons     一键领券
 *   - query-my-coupons      我的券
 *   - query-meals           门店在售菜单
 *   - list-nutrition-foods  营养成分
 *   - calculate-price       算价（可选，优先用本地算法兜底）
 *   - now-time-info         当前时间
 */

import { McdMcpError } from './mcdMcpClient.js';

/** 一次会话里缓存的门店上下文，避免反复查同一门店 */
export class McdAdapter {
  #client;
  #cache = { store: null, meals: null, nutrition: null, coupons: null, time: null };

  constructor(client) {
    this.#client = client;
  }

  static async fromEnv() {
    const { McdMcpClient } = await import('./mcdMcpClient.js');
    return new McdAdapter(new McdMcpClient());
  }

  // ---------- 门店 ----------

  /**
   * 按地址找最近的可用门店。
   * @param {string} address 地址关键词，如「上海虹桥站」
   * @returns {Promise<{storeId:string,name:string,address:string,distance:number}|null>}
   */
  async findNearbyStore(address) {
    const result = await this.#client.callTool('query-nearby-stores', { address });
    const list = pickList(result.data, ['stores', 'storeList', 'data', 'list', 'nearbyStores']);
    if (!list?.length) return null;
    const store = list[0];
    this.#cache.store = store;
    this.#cache.meals = null;
    this.#cache.coupons = null;
    return normalizeStore(store);
  }

  /** 门店在售菜单。依赖上一步设置的门店上下文。 */
  async listMeals() {
    if (this.#cache.meals) return this.#cache.meals;
    const store = this.#cache.store;
    if (!store) throw new McdMcpError('MCD-1001', '请先调用 findNearbyStore 确定门店');

    const result = await this.#client.callTool('query-meals', {
      storeId: pick(store, ['storeId', 'storeCode', 'id', 'code']),
    });
    const list = pickList(result.data, ['meals', 'mealList', 'products', 'data', 'list']);
    this.#cache.meals = (list ?? []).map(normalizeMeal).filter(Boolean);
    return this.#cache.meals;
  }

  // ---------- 优惠 ----------

  /** 门店当前可用的优惠券 */
  async listStoreCoupons() {
    const store = this.#cache.store;
    if (!store) throw new McdMcpError('MCD-1001', '请先调用 findNearbyStore 确定门店');
    if (this.#cache.coupons) return this.#cache.coupons;

    const result = await this.#client.callTool('query-store-coupons', {
      storeId: pick(store, ['storeId', 'storeCode', 'id', 'code']),
    });
    const list = pickList(result.data, ['coupons', 'couponList', 'data', 'list']);
    this.#cache.coupons = (list ?? []).map(normalizeCoupon).filter(Boolean);
    return this.#cache.coupons;
  }

  /**
   * 一键领取所有可领券，再返回我的券。
   * 这是扭蛋机省钱的实际抓手：先领券再算价。
   */
  async bindAndListCoupons() {
    try {
      await this.#client.callTool('auto-bind-coupons', {});
    } catch (error) {
      // 领券失败不阻断主流程——用户可能已领过全部可领的券
      if (error instanceof McdMcpError && error.code === 'MCP-429') throw error;
    }
    const result = await this.#client.callTool('query-my-coupons', {});
    const list = pickList(result.data, ['coupons', 'couponList', 'myCoupons', 'data', 'list']);
    return (list ?? []).map(normalizeCoupon).filter(Boolean);
  }

  // ---------- 营养 ----------

  /** 餐品营养成分，用于「减脂 / 增肌」等饮食目标下的取舍 */
  async listNutrition() {
    if (this.#cache.nutrition) return this.#cache.nutrition;
    const result = await this.#client.callTool('list-nutrition-foods', {});
    const list = pickList(result.data, ['foods', 'nutritionList', 'data', 'list', 'items']);
    this.#cache.nutrition = new Map(
      (list ?? []).map((item) => [normalizeKey(pick(item, ['name', 'foodName', 'mealName'])), normalizeNutrition(item)])
    );
    return this.#cache.nutrition;
  }

  // ---------- 下单 ----------

  /**
   * 创建订单。仅由用户显式确认后触发。
   *
   * 【待真实联调校准】这里传的参数名（storeId / items / couponId / peopleCount）
   * 是按 create-order 的通用语义写的，麦当劳 MCP 的真实字段名与枚举值
   * （尤其是「就餐方式」对应的字段）需要在拿到真实 Token 后，
   * 通过 tools/list 核验 schema 再调整——不要凭工具名猜参数。
   */
  async createOrder({ storeId, items, couponId, peopleCount }) {
    const payload = {
      storeId,
      orderType: 'selfService', // 到店取餐；真实枚举值需联调核验
      peopleCount,
      items: items.map((i) => ({ mealCode: i.code, count: i.qty ?? 1 })),
      couponId: couponId ?? undefined,
    };
    const result = await this.#client.callTool('create-order', payload);
    return normalizeCreatedOrder(result);
  }

  // ---------- 时间 ----------

  /** 当前时间。抽签文案里要说人话（「现在是夜宵时段」），不能硬编码假设。 */
  async now() {
    if (this.#cache.time) return this.#cache.time;
    const result = await this.#client.callTool('now-time-info', {});
    const data = result.data ?? {};
    const hour = Number(pick(data, ['hour', 'currentHour']));
    const date = pick(data, ['date', 'dateTime', 'dateStr', 'currentDateTime']);
    this.#cache.time = { hour: Number.isFinite(hour) ? hour : new Date().getHours(), raw: date };
    return this.#cache.time;
  }

  /** 健康检查：列一遍服务端 Tool 数量，确认 Token 与网络都通 */
  async healthCheck() {
    const tools = await this.#client.listTools();
    return { ok: true, toolCount: tools.length };
  }
}

// ================= 归一化辅助 =================

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/** MCP 各接口的外层包装名不统一（data/list/...），逐个试一遍 */
function pickList(data, keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function normalizeStore(raw) {
  const storeId = String(pick(raw, ['storeId', 'storeCode', 'id', 'code']) ?? '');
  if (!storeId) return null;
  return {
    storeId,
    name: String(pick(raw, ['storeName', 'name', 'restaurantName']) ?? '麦当劳门店'),
    address: String(pick(raw, ['address', 'addressText', 'addr']) ?? ''),
    distance: Number(pick(raw, ['distance', 'distanceMeter', 'distanceMeters']) ?? 0) || null,
    businessHours: pick(raw, ['businessHours', 'openTime', 'openingHours']) ?? null,
  };
}

function normalizeMeal(raw) {
  const code = String(pick(raw, ['mealCode', 'productCode', 'code', 'skuCode', 'id']) ?? '');
  const name = String(pick(raw, ['mealName', 'productName', 'name', 'title']) ?? '');
  if (!code || !name) return null;

  // 价格单位在不同接口可能是「元」也可能是「分」，这里统一成整数分
  const priceRaw = pick(raw, ['price', 'salePrice', 'currentPrice', 'basePrice']);
  const amountRaw = pick(raw, ['amount', 'money', 'value']);
  const priceCents = toCents(priceRaw, amountRaw);

  return {
    code,
    name,
    priceCents,
    category: classifyCategory(name, pick(raw, ['category', 'categoryName', 'tagName'])),
    tags: normalizeTags(pick(raw, ['tags', 'labelList', 'labels', 'tagNames'])),
    desc: String(pick(raw, ['description', 'desc', 'brief']) ?? ''),
  };
}

function normalizeCoupon(raw) {
  const name = String(pick(raw, ['couponName', 'name', 'title']) ?? '');
  if (!name) return null;
  return {
    id: String(pick(raw, ['couponId', 'id']) ?? name),
    name,
    amount: Number(pick(raw, ['amount', 'discountAmount', 'value', 'couponAmount']) ?? 0) || 0,
    threshold: Number(pick(raw, ['threshold', 'minAmount', 'useThreshold']) ?? 0) || 0,
  };
}

function normalizeNutrition(raw) {
  return {
    kcal: numOrNull(pick(raw, ['energy', 'calories', 'kcal', 'heat'])),
    protein: numOrNull(pick(raw, ['protein', 'proteinG'])),
    fat: numOrNull(pick(raw, ['fat', 'fatG'])),
    carb: numOrNull(pick(raw, ['carbohydrate', 'carb', 'carbs'])),
    sodium: numOrNull(pick(raw, ['sodium', 'salt', 'saltG'])),
  };
}

/**
 * 归一化 create-order 的返回。
 * 【待联调校准】支付链接字段名按常见命名做多候选兜底，
 * 拿到真实返回后应收敛到实际字段。
 */
function normalizeCreatedOrder(result) {
  const data = result.data ?? {};
  const payload = pick(data, ['order', 'orderInfo', 'data']) ?? data;
  return {
    orderId: String(pick(payload, ['orderId', 'orderNo', 'id']) ?? ''),
    // 支付链接必须来自 MCP 真实返回，绝不自己拼接
    payUrl: pick(payload, ['payUrl', 'paymentUrl', 'payLink', 'paymentLink', 'url']) ?? null,
    status: String(pick(payload, ['status', 'orderStatus', 'state']) ?? 'unknown'),
    raw: payload,
  };
}

/** 名称关键词 → 品类。MCP 没给稳定分类字段时用名称兜底，比让用户手选分类好用。 */
function classifyCategory(name, explicit) {
  if (explicit) return String(explicit);
  if (/巨无霸|汉堡|堡/.test(name)) return '汉堡';
  if (/薯条|麦块|鸡块|鸡翅|鸡腿|烤翅/.test(name)) return '小食';
  if (/可乐|雪碧|咖啡|拿铁|茶|奶昔|豆浆|柠檬红茶/.test(name)) return '饮料';
  if (/麦乐鸡|鸡米花|上校|鸡排/.test(name)) return '小食';
  if (/蛋挞|派|蛋糕|甜品|冰淇淋|圆筒|圣代/.test(name)) return '甜品';
  if (/沙拉|轻食|蔬菜/.test(name)) return '轻食';
  return '其他';
}

function normalizeTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/[,，|]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * 价格归一化成「分」。
 * 麦当劳 MCP 目前返回的是元（float），但为了防上游改成厘/分，这里按量级判断：
 *   带小数 → 元；整数且 >= 1000 → 分（否则 20 份套餐会被读成 20 分）。
 */
function toCents(price, amount) {
  const value = Number(price ?? amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (Number.isInteger(value) && value >= 1000) return Math.round(value);
  return Math.round(value * 100);
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeKey(text) {
  return String(text ?? '').trim().toLowerCase();
}
