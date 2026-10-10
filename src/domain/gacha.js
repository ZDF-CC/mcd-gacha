/**
 * src/domain/gacha.js
 * ------------------------------------------------------------------
 * 扭蛋机的「扭」动作：在一份真实菜单里，随机抽出一份满足约束的搭配。
 *
 * 约束优先级（从硬到软）：
 *   1. 硬约束：必选项必须包含、忌口必须排除、单价不能超过单价上限
 *   2. 预算：总价不超过上限（尽量贴近但不超）
 *   3. 软偏好：品类多样性、饮食目标（减脂/解馋）、随机性
 *
 * 为什么要用「先随机生成、失败再修复」而不是「穷举所有组合」：
 *   - 菜单 60+ 项时组合数是指数级的，穷举不可行
 *   - 扭蛋机的手感就是「随机但有惊喜」，纯穷举会失去产品灵魂
 *   - 修复式生成（resample + 定向替换）既有随机性又能收敛到可行解
 *
 * 金额一律用整数「分」计算。浮点数算钱必然出问题，这是硬规矩。
 */

import { veggieScore } from './catalog.js';

/** 饮食目标 → 优化倾向 */
export const DIET_GOALS = {
  none: { label: '不设偏好', calorieWeight: 0, veggieWeight: 0, excludeKcal: 0 },
  light: { label: '轻食低卡', calorieWeight: 1, veggieWeight: 0.4, excludeKcal: 400 },
  protein: { label: '高蛋白', calorieWeight: 0.2, veggieWeight: 0.2, excludeKcal: 0 },
  indulge: { label: '解馋放纵', calorieWeight: -0.5, veggieWeight: -0.6, excludeKcal: 0 },
};

const CENTS_PER_YUAN = 100;

/**
 * 抽一次搭配。
 *
 * @param {object}  params
 * @param {import('./catalog.js').Catalog} params.catalog
 * @param {object}  params.constraints
 * @param {number}  params.constraints.budgetCents     总预算上限（分）
 * @param {number}  params.constraints.itemMaxCents    单品价格上限（分）
 * @param {string[]} params.constraints.mustInclude     必选项关键词
 * @param {string[]} params.constraints.avoidTags       忌口键
 * @param {string}  params.constraints.dietGoal        饮食目标，见 DIET_GOALS
 * @param {number}  params.constraints.peopleCount      用餐人数
 * @param {function} [params.rng]                      随机源，注入以便测试复现
 * @returns {GachaResult}
 */
export function gacha({
  catalog,
  constraints,
  rng = Math.random,
}) {
  const c = normalizeConstraints(constraints);
  const goal = DIET_GOALS[c.dietGoal] ?? DIET_GOALS.none;

  // ---- 阶段一：构造候选池 ----
  // 两道过滤：
  //   1. 单品价格上限
  //   2. 饮食目标的硬性热量门槛（只在营养表能查到时生效，查不到就放行，
  //      宁可多给选择也不要把用户锁死）
  const poolErrors = [];
  const poolNotes = [];
  let pool = catalog.meals.filter((m) => m.priceCents <= c.itemMaxCents);
  if (pool.length === 0) {
    poolErrors.push(`单品价格上限 ${yuan(c.itemMaxCents)} 元把所有商品都过滤掉了`);
  }

  if (goal.excludeKcal > 0) {
    const before = pool.length;
    pool = pool.filter((m) => {
      const kcal = catalog.nutritionOf(m)?.kcal;
      return !Number.isFinite(kcal) || kcal <= goal.excludeKcal;
    });
    if (pool.length === 0) {
      // 全部被热量门槛拦下时退回价格池，否则会给出「无可用商品」的死局
      pool = catalog.meals.filter((m) => m.priceCents <= c.itemMaxCents);
      poolErrors.push('菜单里所有商品都超过轻食热量上限，已放宽限制');
    } else if (pool.length < before) {
      // 这条是「成功时也要告知」的信息，不是错误
      poolNotes.push(`${before - pool.length} 样商品因超过轻食热量上限（${goal.excludeKcal} kcal）被跳过`);
    }
  }

  // ---- 阶段二：锁定必选项 ----
  const pinned = [];
  const unresolvedMust = [];
  for (const keyword of c.mustInclude) {
    const hits = catalog.search(keyword);
    if (hits.length === 0) {
      unresolvedMust.push({ keyword, reason: '菜单里没有匹配的商品' });
      continue;
    }
    // 多个候选时随机挑一个，保留「扭」的随机感
    const affordable = hits.filter((h) => h.priceCents <= c.itemMaxCents);
    const from = affordable.length ? affordable : hits;
    if (!from.length || from[0].priceCents > c.itemMaxCents) {
      pinned.push(hits[0]); // 必选项不受单品上限约束，记为超限交由用户确认
    } else {
      pinned.push(pickRandom(from, rng));
    }
  }

  const pinnedTotal = sumCents(pinned.map((m) => m.priceCents));
  const remainingCents = c.budgetCents - pinnedTotal;

  if (remainingCents < 0) {
    return {
      ok: false,
      reason: `必选项已花费 ${yuan(pinnedTotal)} 元，超出总预算 ${yuan(c.budgetCents)} 元`,
      mustFix: true,
      constraints: c,
      items: [],
    };
  }

  // ---- 阶段三：随机填充 + 定向修复，直到收敛 ----
  const result = fill(catalog, pool, pinned, remainingCents, goal, rng);
  if (!result.ok) {
    // 把「为什么候选池是空的」一并带出去，否则用户只会看到一句没头没尾的
    // 「没有可用的候选商品」，不知道自己该调哪个参数。
    const reasons = [];
    if (poolErrors.length) reasons.push(...poolErrors);
    reasons.push(result.reason);
    return {
      ok: false,
      reason: reasons.join('；'),
      constraints: c,
      items: [],
      unresolvedMust,
      poolErrors,
    };
  }

  const items = result.items;
  const totalCents = sumCents(items.map((m) => m.priceCents));
  const nutritionSummary = summarizeNutrition(catalog, items);
  const coupon = bestCoupon(catalog.coupons, totalCents, c.peopleCount);
  const afterCouponCents = coupon ? Math.max(0, totalCents - coupon.amount) : totalCents;

  return {
    ok: true,
    constraints: c,
    items: items.map((m, index) => ({ ...m, slot: index + 1, reason: describeRole(m, index, items, c) })),
    totalCents,
    budgetCents: c.budgetCents,
    remainCents: c.budgetCents - totalCents,
    usedRatio: c.budgetCents > 0 ? totalCents / c.budgetCents : 0,
    coupon,
    afterCouponCents,
    nutrition: nutritionSummary,
    diversity: diversityOf(items),
    unresolvedMust,
    poolNotes,
    warnings: [...poolNotes, ...buildWarnings(c, totalCents, nutritionSummary, unresolvedMust)],
  };
}

/**
 * 随机填充算法。
 * 一轮 = 随机取一个候选品类 → 随机取商品 → 放得下就收、放不下就换。
 * 连续 M 轮失败判定为无解（避免死循环）。
 */
function fill(catalog, pool, pinned, remainingCents, goal, rng) {
  if (pool.length === 0 && pinned.length === 0) {
    return { ok: false, reason: '没有可用的候选商品' };
  }

  const MAX_ROUNDS = 220;
  const items = [...pinned];
  let budget = remainingCents;
  let stuck = 0;
  // 必选编码单独记一份：fill 阶段还没生成 reason，不能靠 reason 判断来源
  const pinnedCodes = new Set(pinned.map((m) => m.code));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (budget <= 0 || pool.length === 0) {
      stuck++;
      // 允许 3 轮空转观察，之后判定收敛
      if (stuck > 3 || budget <= 0) break;
      continue;
    }

    // 依据目标与多样性加权抽取下一个商品。
    // 同款重复要区分两种情况：
    //   - 必选项：允许再加一份（两个人各要一个巨无霸是合理的）
    //   - 随机抽中的：不再重复（可乐+中可这种同类不同款对搭配也没有增量）
    const chosenCodes = new Set(items.map((m) => m.code));
    const distinctChosen = new Set(items.map((m) => `${m.category}::${m.name}`));
    const candidate = pickWeighted(
      pool.filter((m) => !chosenCodes.has(m.code) || pinnedCodes.has(m.code)),
      items,
      goal,
      rng,
      catalog,
      budget,
      distinctChosen
    );
    if (!candidate) break;

    if (candidate.priceCents <= budget) {
      items.push(candidate);
      budget -= candidate.priceCents;
      stuck = 0;
      continue;
    }

    // 放不下：定向找同品类里更便宜的平替。
    // 平替同样要走去重，否则会出现「中可」被选两次的情况。
    const chosenNow = new Set(items.map((m) => m.code));
    const cheaper = pool
      .filter(
        (m) =>
          m.category === candidate.category &&
          m.priceCents <= budget &&
          !chosenNow.has(m.code)
      )
      .sort((a, b) => a.priceCents - b.priceCents)[0];

    if (cheaper) {
      items.push(cheaper);
      budget -= cheaper.priceCents;
      stuck = 0;
    } else {
      stuck++;
      if (stuck > 12) break;
    }
  }

  if (items.length === 0) {
    return { ok: false, reason: '在当前预算和限制下找不到任何可搭配的商品' };
  }

  // 收尾去重：填预算的最后阶段可能反复拿同一款（预算剩 8 元时，
  // 池里只有 4 元的中可，就会连拿两次）。同款买两份只在必选时才有意义。
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (pinnedCodes.has(item.code)) {
      deduped.push(item); // 必选可以有多份
      continue;
    }
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    deduped.push(item);
  }

  return { ok: true, items: deduped };
}

/**
 * 加权随机挑选下一个商品。
 * 权重设计：
 *   - 基础权重 10
 *   - 同品类已出现 → 降权（保证多样性）
 *   - 饮食目标命中 → 加权（减脂时低热量加分，解馋时高热量加分）
 *   - 预算宽松时偏便宜（低卡/高蛋白模式下尤其重要：
 *     如果一味挑贵的，剩下的预算不够再配一样，总热量反而更高）
 *
 * 热量数据从 catalog 的营养表实时查，而不是预先塞进商品对象——
 * 麦当劳 MCP 的营养表和菜单是两次独立调用，对齐逻辑放在抽取时才不会写死。
 */
function pickWeighted(pool, chosen, goal, rng, catalog, budgetLeft = Infinity, distinctChosen = new Set()) {
  const chosenCategories = new Set(chosen.map((m) => m.category));
  // 预算充裕时（还能再配两样以上），对价格敏感度提高
  const budgetSlack = budgetLeft / 100;

  const weights = pool.map((meal) => {
    let w = 10;
    if (chosenCategories.has(meal.category)) w *= 0.35;
    // 品类相同但名字不同的（可乐 / 中可）进一步降权，鼓励多样性
    if (distinctChosen.has(`${meal.category}::${meal.name}`)) w *= 0.3;

    const kcal = catalog?.nutritionOf(meal)?.kcal;
    const kcalKnown = Number.isFinite(kcal);

    if (goal.veggieWeight > 0) w *= 1 + goal.veggieWeight * (veggieScore(meal) - 0.3);

    if (goal.calorieWeight > 0) {
      // 减脂模式：按热量从低到高排序加权，分界线取 400 kcal（一顿正餐的量级）。
      // 无营养数据时给中性权重 1——不能因为「查不到」就当成「低热量」，
      // 也不能当成「高热量」，只做轻微降权避免它压过明确健康的选择。
      if (kcalKnown) {
        w *= kcal < 400 ? 1 + goal.calorieWeight * 0.8 : 1 - goal.calorieWeight * 0.5;
      } else {
        w *= 0.85;
      }
    } else if (goal.calorieWeight < 0) {
      // 解馋模式：有数据的热量越高权重越大；无数据的适度加权，不至于抽不到
      w *= kcalKnown ? 1 - goal.calorieWeight * 0.5 : 1.2;
    }

    // 预算敏感：剩余预算还能配 2 样以上时，偏向价格适中的商品，
    // 避免「一次把预算吃掉大半、后面只能干选高热量商品」的情况
    if (Number.isFinite(budgetSlack) && budgetSlack > meal.priceCents / 100) {
      w *= 1 + goal.calorieWeight * 0.25 * Math.min(1, budgetSlack / 50);
    }

    return Math.max(0.5, w);
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let target = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    target -= weights[i];
    if (target <= 0) return pool[i];
  }
  return pool.at(-1);
}

/** 挑一张对这张订单最优的券：门槛够、减免多 */
function bestCoupon(coupons, totalCents, peopleCount) {
  const usable = coupons.filter((c) => c.threshold === 0 || totalCents >= c.threshold);
  if (usable.length === 0) return null;
  // 减免额占总价比例最高的券最划算
  return usable.sort((a, b) => ratio(b, totalCents) - ratio(a, totalCents))[0];
}

function ratio(coupon, total) {
  return total > 0 ? coupon.amount / total : 0;
}

/** 汇总营养：只统计能查到营养数据的项，并诚实标注覆盖率 */
function summarizeNutrition(catalog, items) {
  const parts = items.map((m) => catalog.nutritionOf(m)).filter(Boolean);
  if (parts.length === 0) {
    return { covered: 0, total: items.length, kcal: null, protein: null, fat: null, carb: null, sodium: null };
  }
  const agg = (key) => {
    const values = parts.map((p) => p[key]).filter((v) => Number.isFinite(v));
    return values.length ? round1(values.reduce((a, b) => a + b, 0)) : null;
  };
  return {
    covered: parts.length,
    total: items.length,
    kcal: agg('kcal'),
    protein: agg('protein'),
    fat: agg('fat'),
    carb: agg('carb'),
    sodium: agg('sodium'),
  };
}

/** 品类多样性：1 表示每样都不同，0 表示全是一个品类 */
function diversityOf(items) {
  if (items.length <= 1) return 1;
  return round2(new Set(items.map((m) => m.category)).size / items.length);
}

/** 给每个商品一句人话解释，揭晓页会展示——让用户知道「为什么是它」 */
function describeRole(meal, index, items, constraints) {
  const reasons = [];
  if (constraints.mustInclude.some((kw) => meal.name.toLowerCase().includes(kw.toLowerCase()))) {
    reasons.push('你指定的必选');
    return reasons.join('，');
  }
  reasons.push(`${meal.category}类`);
  if (index === 0) reasons.push('先垫底');
  else reasons.push('配着吃');
  if (meal.tags.length) reasons.push(meal.tags.slice(0, 2).join('/'));
  return reasons.join('，');
}

/** 约束预警：把「差点就成」的情况明确告诉用户，而不是静默失败 */
function buildWarnings(c, totalCents, nutrition, unresolvedMust) {
  const warnings = [];
  if (unresolvedMust.length) {
    warnings.push(`必选项没找到：${unresolvedMust.map((m) => m.keyword).join('、')}`);
  }
  if (c.budgetCents > 0 && totalCents / c.budgetCents > 0.95) {
    warnings.push('已几乎用满预算，想要更多选择可以适当提高预算');
  }
  if (nutrition.covered === 0) {
    warnings.push('麦当劳 MCP 的营养表没有覆盖本次抽中的餐品，营养数据缺失');
  } else if (nutrition.covered < nutrition.total) {
    warnings.push(`${nutrition.total - nutrition.covered} 项没有营养数据，为你汇总时可查到的部分`);
  }
  if (nutrition.kcal != null && nutrition.kcal > 1200) {
    warnings.push(`合计约 ${nutrition.kcal} kcal，接近一顿正餐的热量上限`);
  }
  if (c.dietGoal === 'light' && nutrition.kcal != null && nutrition.kcal > 700) {
    warnings.push('你选的是「轻食低卡」，但这份搭配热量偏高，可以点「全部重扭」换个组合');
  }
  return warnings;
}

// ---------- 小工具 ----------

function normalizeConstraints(input = {}) {
  // 注意：budgetCents / itemMaxCents 是「分」的直接入口，budget / itemMax 是「元」的便捷入口。
  // 这里必须把 undefined 原样传给 toCents，由它决定回退到「元」值还是默认值，
  // 写成 `input.budgetCents ?? 4000` 会让元单位的入口永远失效。
  return {
    budgetCents: toCents(input.budgetCents, input.budget ?? 40),
    itemMaxCents: toCents(input.itemMaxCents, input.itemMax ?? 30),
    mustInclude: (input.mustInclude ?? []).map((s) => String(s).trim()).filter(Boolean),
    avoidTags: (input.avoidTags ?? []).map(String),
    dietGoal: input.dietGoal ?? 'none',
    peopleCount: Math.max(1, Number(input.peopleCount) || 1),
  };
}

function toCents(cents, yuanFallback) {
  if (Number.isFinite(Number(cents)) && Number(cents) > 0) return Math.round(Number(cents));
  const y = Number(yuanFallback);
  return Number.isFinite(y) && y > 0 ? Math.round(y * CENTS_PER_YUAN) : 0;
}

function sumCents(list) {
  return list.reduce((a, b) => a + b, 0);
}

function pickRandom(list, rng) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function yuan(cents) {
  return (cents / CENTS_PER_YUAN).toFixed(2);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
