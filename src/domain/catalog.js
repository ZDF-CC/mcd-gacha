/**
 * src/domain/catalog.js
 * ------------------------------------------------------------------
 * 在售目录的内存索引与查询。领域层，不认识 MCP，只认识「商品」和「券」。
 *
 * 职责：
 *   - 承载一次会话内的门店菜单、券、营养表
 *   - 提供抽签算法需要的高效查询：按品类取、按忌口过滤、按关键词搜
 *   - 顺便在这里做缓存，纯函数、易测
 */

export class Catalog {
  /**
   * @param {object} input
   * @param {Array}  input.meals      归一化后的商品列表
   * @param {Array}  input.coupons    归一化后的券列表
   * @param {Map}    input.nutrition  名称 → 营养成分
   */
  constructor({ meals = [], coupons = [], nutrition = new Map() } = {}) {
    this.meals = meals.filter((m) => m && m.code && m.priceCents > 0);
    this.coupons = coupons;
    this.nutrition = nutrition;
    this.byCode = new Map(this.meals.map((m) => [m.code, m]));
  }

  get size() {
    return this.meals.length;
  }

  get categories() {
    return [...new Set(this.meals.map((m) => m.category))];
  }

  /**
   * 按品类取商品。品类用领域内的中文分类，
   * 避免「用户想吃的汉堡」直接写 '汉堡' 而漏掉「巨无霸套餐」这类名字。
   */
  byCategory(category) {
    return this.meals.filter((m) => m.category === category);
  }

  get(code) {
    return this.byCode.get(code) ?? null;
  }

  /** 模糊搜索：名称或描述包含关键词 */
  search(keyword) {
    const kw = String(keyword ?? '').trim().toLowerCase();
    if (!kw) return [];
    return this.meals.filter(
      (m) =>
        m.name.toLowerCase().includes(kw) ||
        m.desc.toLowerCase().includes(kw) ||
        m.tags.some((t) => t.toLowerCase().includes(kw))
    );
  }

  /** 查某个商品的营养成分（按名称匹配，麦当劳 MCP 的营养表是按餐品名组织的） */
  nutritionOf(meal) {
    return this.nutrition.get(String(meal?.name ?? '').trim().toLowerCase()) ?? null;
  }

  /** 价格区间，用于校验用户预算是否现实 */
  priceRange() {
    if (!this.meals.length) return { min: 0, max: 0 };
    const prices = this.meals.map((m) => m.priceCents);
    return { min: Math.min(...prices), max: Math.max(...prices) };
  }
}

/**
 * 忌口过滤器。
 *
 * 麦当劳的「忌口」不是布尔字段，而是靠配料和名字里的关键词体现的
 * （如「香辣鸡腿堡」含辣、「板烧鸡腿堡」有酱、「中辣薯条」有辣）。
 * 所以用关键词规则匹配，命中任一即排除。
 *
 * 规则表放在这里而不是配置文件，是因为它属于「业务语义」而不是「部署配置」，
 * 需要版本管理和评审。
 */
export const ALLERGY_RULES = {
  spicy: { label: '辣', patterns: [/辣/, /香辣/, /麻辣/, /变态辣/] },
  pork: { label: '猪肉', patterns: [/猪/, /培根/, /火腿/] },
  beef: { label: '牛肉', patterns: [/牛肉/, /巨无霸/, /汉堡 beef/] },
  chicken: { label: '鸡肉', patterns: [/鸡/, /鸡腿/, /鸡翅/, /鸡块/] },
  seafood: { label: '海鲜', patterns: [/虾/, /蟹/, /鱼/, /鱿鱼/, /麦香鱼/] },
  dairy: { label: '乳制品', patterns: [/奶/, /乳/, /芝士/, /酸奶/] },
  gluten: { label: '麸质', patterns: [/面包/, /汉堡胚/, /麦满分/, /饼干/] },
  nuts: { label: '坚果', patterns: [/坚果/, /花生/, /杏仁/] },
  onionGarlic: { label: '葱蒜', patterns: [/洋葱/, /蒜/] },
};

/** 素食友好（不是严格的纯素，麦当劳的汉堡胚常含奶蛋，仅作温和提示） */
const VEGGIE_FRIENDLY = /蔬菜|生菜|沙拉|轻食|素/

/**
 * 按忌口集合过滤商品。
 * @param {Catalog} catalog
 * @param {string[]} avoidTags 忌口键，见 ALLERGY_RULES 的 key
 * @returns {{ kept: Array, filteredOut: Array }}
 */
export function applyAvoidRules(catalog, avoidTags = []) {
  const activeRules = avoidTags
    .map((tag) => ALLERGY_RULES[tag])
    .filter(Boolean);

  if (activeRules.length === 0) {
    return { kept: catalog.meals, filteredOut: [] };
  }

  const kept = [];
  const filteredOut = [];

  for (const meal of catalog.meals) {
    const haystack = `${meal.name} ${meal.desc} ${meal.tags.join(' ')}`;
    const hit = activeRules.find((rule) => rule.patterns.some((p) => p.test(haystack)));
    if (hit) {
      filteredOut.push({ ...meal, blockedBy: hit.label });
    } else {
      kept.push(meal);
    }
  }

  return { kept, filteredOut };
}

/** 素食友好度打分，0~1 */
export function veggieScore(meal) {
  if (VEGGIE_FRIENDLY.test(meal.name)) return 1;
  if (/沙拉|轻食/.test(meal.name)) return 0.9;
  if (/水果|优格/.test(meal.name)) return 0.7;
  return 0.3;
}
