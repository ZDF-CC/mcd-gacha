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
   *
   * 【已按真实 schema 联调校准】query-nearby-stores 的官方参数定义：
   *   - beType 必填：1=到店自提，5=得来速。本应用只做到店，固定传 1
   *   - searchType 必填：1=搜收藏餐厅，2=按位置搜索。匿名场景固定传 2
   *   - city 必填：必须是纯城市名（如「上海」）。传「上海虹桥站」会被拒绝
   *   - keyword：位置关键词，可以带城市前缀（「上海虹桥站」可用）
   *   实测（2026-10-10）：city=上海 + keyword=上海虹桥站 返回 5 家门店。
   *
   * @param {string} address 地址，如「上海虹桥站」「深圳市南山区」
   */
  async findNearbyStore(address) {
    const { city, keyword } = splitCityKeyword(address);
    const result = await this.#client.callTool('query-nearby-stores', {
      beType: 1,
      searchType: 2,
      city,
      keyword,
    });

    const payload = result.data ?? {};
    // 服务端校验失败（如城市名不认识）时把原文透给用户，别只说「没找到」
    if (payload.success === false) {
      throw new McdMcpError(
        'MCD-1002',
        `${payload.message ?? '门店查询失败'}。试试「城市 + 地标」的写法，例如：上海虹桥站、深圳市南山区`
      );
    }

    const list = pickList(payload, ['stores', 'storeList', 'data', 'list', 'nearbyStores']);
    if (!list?.length) return null;
    const store = list[0];
    this.#cache.store = store;
    this.#cache.meals = null;
    this.#cache.coupons = null;
    return normalizeStore(store);
  }

  /**
   * 门店在售菜单。依赖上一步设置的门店上下文。
   *
   * 【已按真实 schema 联调校准】（2026-10-10，上海虹桥站门店实测）
   *   query-meals 返回的是 categories[].meals[]，且每个商品**只有 code**，
   *   名字和价格都不在这里。价格由 calculate-price 提供，单位是「分」
   *   （如 6250 = ¥62.50），一次批量调用可返回全部商品的名称与单价。
   *   所以这里两步走：query-meals 拿结构 → calculate-price 批量拿名价。
   */
  async listMeals() {
    if (this.#cache.meals) return this.#cache.meals;
    const store = this.#cache.store;
    if (!store) throw new McdMcpError('MCD-1001', '请先调用 findNearbyStore 确定门店');

    const storeCode = pick(store, ['storeCode', 'storeId', 'id', 'code']);
    const baseArgs = { storeCode, orderType: 1, beType: 1 }; // 到店自取，不传 beCode

    // 第一步：分类与商品 code
    const { data } = await this.#client.callTool('query-meals', baseArgs);
    if (data?.success === false) {
      throw new McdMcpError('MCD-1003', data.message ?? '菜单查询失败');
    }
    const categories = data?.data?.categories ?? [];
    const entries = [];
    const seen = new Set();
    for (const cat of categories) {
      for (const meal of cat.meals ?? []) {
        const code = String(meal?.code ?? '');
        if (!code || seen.has(code)) continue; // 同一商品可能出现在多个分类
        seen.add(code);
        entries.push({ code, category: String(cat.name ?? '其他') });
      }
    }
    if (!entries.length) return [];

    // 第二步：批量算价拿名字与单价（分）
    const { data: priceData } = await this.#client.callTool('calculate-price', {
      ...baseArgs,
      items: entries.map((e) => ({ productCode: e.code, quantity: 1 })),
    });
    if (priceData?.success === false) {
      throw new McdMcpError('MCD-1003', priceData.message ?? '价格计算失败');
    }
    const priceMap = new Map();
    for (const p of priceData?.data?.productList ?? []) {
      const code = String(p?.productCode ?? '');
      const cents = Number(p?.originalSubtotal ?? p?.subtotal) || 0;
      if (code && cents > 0) priceMap.set(code, { name: String(p.productName), cents });
    }

    this.#cache.meals = entries
      .map(({ code, category }) => {
        const info = priceMap.get(code);
        if (!info) return null; // 拿不到名字或价格的商品无法参与扭蛋
        return {
          code,
          name: info.name,
          priceCents: info.cents,
          category,
          tags: [],
          desc: '',
        };
      })
      .filter(Boolean);
    return this.#cache.meals;
  }

  // ---------- 优惠 ----------

  /** 门店当前可用的优惠券 */
  async listStoreCoupons() {
    const store = this.#cache.store;
    if (!store) throw new McdMcpError('MCD-1001', '请先调用 findNearbyStore 确定门店');
    if (this.#cache.coupons) return this.#cache.coupons;

    // 【已按真实 schema 联调校准】必填 orderType / beType / storeCode，与 query-meals 同一套
    const result = await this.#client.callTool('query-store-coupons', {
      storeCode: pick(store, ['storeCode', 'storeId', 'id', 'code']),
      orderType: 1,
      beType: 1,
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

  /**
   * 餐品营养成分，用于「减脂 / 增肌」等饮食目标下的取舍。
   *
   * 【已按真实返回联调校准】list-nutrition-foods 无参数，但返回的
   * data.data 是一段自定义紧凑表格（不是 JSON）：
   *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
   *     猪柳麦满分,null,1288,308,16,16,24,781,213
   *     ...
   * 首行声明行数与列名，其后每行一条记录、逗号分隔。
   */
  async listNutrition() {
    if (this.#cache.nutrition) return this.#cache.nutrition;
    const result = await this.#client.callTool('list-nutrition-foods', {});
    const rows = parseCompactTable(result.data?.data ?? result.text ?? '');
    this.#cache.nutrition = new Map(
      rows.map((item) => [normalizeKey(item.productName), normalizeNutrition(item)])
    );
    return this.#cache.nutrition;
  }

  // ---------- 下单 ----------

  /**
   * 创建订单。仅由用户显式确认后触发。
   *
   * 【已按真实 schema 校准参数名】create-order 必填 storeCode/orderType/beType；
   * items 为 [{productCode, quantity}]；takeWayCode 来自 calculate-price 返回的
   * takeWayList（eat-in=堂食，take-in-store=外带），默认外带。
   * 注意：本方法只拼参数并调用，下单前的所有确认逻辑在 GachaService 双重锁里。
   * 真实下单链路还需要一次端到端验证，MCP_INTEGRATION.md 中有记录。
   */
  async createOrder({ storeId, items, couponId, peopleCount }) {
    const payload = {
      storeCode: storeId,
      orderType: 1, // 到店
      beType: 1, // 到店自取
      takeWayCode: 'take-in-store',
      items: items.map((i) => ({ productCode: i.code, quantity: i.qty ?? 1 })),
    };
    if (couponId) payload.couponId = couponId;
    if (peopleCount > 1) payload.remark = `${peopleCount} 人份`;
    const result = await this.#client.callTool('create-order', payload);
    return normalizeCreatedOrder(result);
  }

  // ---------- 时间 ----------

  /**
   * 当前时间。抽签文案里要说人话（「现在是夜宵时段」），不能硬编码假设。
   *
   * 【已按真实返回联调校准】now-time-info 无参数，返回字段：
   *   { timestamp, datetime, formatted: "2026-10-10 14:08:11", date, year,
   *     month, day, dayOfWeek, timezone: "GMT+08:00", ... }
   * 没有 hour 字段，从 formatted 里取。
   */
  async now() {
    if (this.#cache.time) return this.#cache.time;
    const result = await this.#client.callTool('now-time-info', {});
    const data = result.data ?? {};
    const formatted = String(pick(data, ['formatted', 'datetime']) ?? '');
    const hourMatch = formatted.match(/\b(\d{1,2}):\d{2}/);
    const hour = hourMatch ? Number(hourMatch[1]) : new Date().getHours();
    this.#cache.time = { hour: Number.isFinite(hour) ? hour : new Date().getHours(), raw: formatted || data };
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
  const open = pick(raw, ['businessStartTime']);
  const close = pick(raw, ['businessEndTime']);
  return {
    storeId,
    name: String(pick(raw, ['storeName', 'name', 'restaurantName']) ?? '麦当劳门店'),
    address: String(pick(raw, ['address', 'addressText', 'addr']) ?? ''),
    distance: Number(pick(raw, ['distance', 'distanceMeter', 'distanceMeters']) ?? 0) || null,
    businessHours:
      pick(raw, ['businessHours', 'openTime', 'openingHours']) ??
      (open && close ? `${open}-${close}` : null),
  };
}

/**
 * 把用户输入拆成 query-nearby-stores 需要的 { city, keyword }。
 *
 * 实测结论（2026-10-10）：
 *   city=上海 + keyword=上海虹桥站 → 成功
 *   city=上海虹桥站               → 「没有查询到该地址」
 *   city 为空                     → 「城市名或者关键词不能为空」
 * 即：city 必须是纯城市名；keyword 随意，带不带城市前缀都行。
 *
 * 拆分策略（按优先级）：
 *   1. 输入含「市」：取「市」前部分为城市，去掉省/自治区前缀
 *      「广东省深圳市南山区」→ city=深圳, keyword=原串
 *   2. 以已知城市名开头：直接取该前缀（长名优先，防止「武汉」被短名抢先）
 *   3. 兜底：整个输入同时当城市和关键词，交给服务端校验，
 *      失败时把服务端 message 透传并提示正确写法
 */
const KNOWN_CITIES = [
  // 四字及以上
  '乌鲁木齐', '呼和浩特', '石家庄', '鄂尔多斯', '齐齐哈尔',
  // 三字
  '哈尔滨', '张家口', '秦皇岛', '连云港', '平顶山', '马鞍山', '六盘水',
  // 直辖市
  '北京', '上海', '天津', '重庆',
  // 广东省地级市（本项目主要用户群在广东）
  '广州', '深圳', '珠海', '汕头', '佛山', '韶关', '湛江', '肇庆', '江门',
  '茂名', '惠州', '梅州', '汕尾', '河源', '阳江', '清远', '东莞', '中山',
  '潮州', '揭阳', '云浮',
  // 其他省会与主要城市
  '南京', '苏州', '无锡', '常州', '南通', '徐州', '杭州', '宁波', '温州',
  '嘉兴', '合肥', '福州', '厦门', '南昌', '济南', '青岛', '郑州', '武汉',
  '长沙', '太原', '沈阳', '大连', '长春', '成都', '贵阳', '昆明', '南宁',
  '桂林', '海口', '西安', '兰州', '西宁', '银川', '拉萨',
];

export function splitCityKeyword(address) {
  const input = String(address ?? '').trim();

  // 「XX市…」：取市名。注意省前缀：「广东省深圳市」的「市」前是「广东省深圳」
  const shiMatch = input.match(/^(.+?)市/);
  if (shiMatch) {
    const city = shiMatch[1].replace(/^.*?(省|自治区)/, '');
    if (city) return { city, keyword: input };
  }

  // 已知城市前缀（长名优先匹配）
  const sorted = [...KNOWN_CITIES].sort((a, b) => b.length - a.length);
  for (const city of sorted) {
    if (input.startsWith(city)) return { city, keyword: input };
  }

  // 兜底：交给服务端校验
  return { city: input, keyword: input };
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

/**
 * 解析 list-nutrition-foods 返回的紧凑表格。
 * 格式：首行 `[行数]{列1,列2,...}:`，随后每行一条记录，逗号分隔，可有缩进。
 * 值可能为 null 字面量，统一转成空串；数字列由调用方自行转换。
 */
export function parseCompactTable(text) {
  const raw = String(text ?? '');
  const header = raw.match(/\[?\d*\]?\{([^}]+)\}\s*:?/);
  if (!header) return [];
  const columns = header[1].split(',').map((c) => c.trim());

  const rows = [];
  for (const line of raw.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(',')) continue;
    const values = trimmed.split(',').map((v) => (v === 'null' ? '' : v.trim()));
    const row = {};
    columns.forEach((col, i) => {
      row[col] = values[i] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function normalizeNutrition(raw) {
  return {
    kcal: numOrNull(pick(raw, ['energyKcal', 'energy', 'calories', 'kcal'])),
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

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeKey(text) {
  return String(text ?? '').trim().toLowerCase();
}
