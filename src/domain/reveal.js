/**
 * src/domain/reveal.js
 * ------------------------------------------------------------------
 * 揭晓之后的两个动作：重抽单件、确认搭配。
 *
 * 为什么要把「重抽」做成按槽位（slot）而不是整体重扭：
 *   整体重扭会丢掉用户已经满意的部分——这正是抽签类产品的负面体验来源。
 *   按槽位重抽能让用户「保留 3 样，只换掉不想要的那 1 样」，控制感强得多。
 */

import { gacha } from './gacha.js';

/**
 * 重抽某一个槽位。
 * 保持总预算和其他槽位不变，只在候选池里为该槽位找一个同价位段的替代品。
 *
 * @param {object} params
 * @param {import('./catalog.js').Catalog} params.catalog
 * @param {GachaResult} params.current     当前的抽签结果
 * @param {number} params.slot             要重抽的槽位（从 1 开始）
 * @param {function} [params.rng]
 * @returns {{ ok: boolean, result?: GachaResult, reason?: string }}
 */
export function rerollSlot({ catalog, current, slot, rng = Math.random }) {
  if (!current?.ok) return { ok: false, reason: '当前没有有效的抽签结果' };

  const target = current.items.find((i) => i.slot === slot);
  if (!target) return { ok: false, reason: `槽位 ${slot} 不存在` };

  const others = current.items.filter((i) => i.slot !== slot);
  const othersTotal = others.reduce((a, b) => a + b.priceCents, 0);
  const budgetLeft = current.budgetCents - othersTotal;

  if (budgetLeft <= 0) {
    return { ok: false, reason: '预算已被其他项占满，无法重抽' };
  }

  // 候选：同品类优先（保持搭配结构协调），其次任意品类；价格需在剩余预算内
  const affordable = catalog.meals.filter(
    (m) => m.priceCents <= budgetLeft && !others.some((o) => o.code === m.code)
  );
  if (affordable.length === 0) {
    return { ok: false, reason: `剩余预算 ${fmtYuan(budgetLeft)} 元内没有其他可换的商品` };
  }

  const sameCategory = affordable.filter((m) => m.category === target.category);
  const candidates = sameCategory.length ? sameCategory : affordable;

  // 硬性排除「同一款商品」，否则槽位 1 会出现"没换任何东西"的假动作。
  // 同品类内如果只有原来那一款，就放开到任意品类去换——换品类比不换好。
  const notSameItem = candidates.filter((m) => m.code !== target.code);
  let from = notSameItem;
  let crossCategory = false;
  if (notSameItem.length === 0) {
    from = affordable.filter((m) => m.code !== target.code);
    crossCategory = from.length > 0;
  }
  if (from.length === 0) {
    return { ok: false, reason: '预算内已经没有其他可换的商品了' };
  }

  const picked = from[Math.floor(rng() * from.length) % from.length];

  const merged = [...others, { ...picked, slot }].sort((a, b) => a.slot - b.slot);
  const totalCents = merged.reduce((a, b) => a + b.priceCents, 0);

  if (totalCents > current.budgetCents) {
    return { ok: false, reason: '重抽后的总价超预算了，请提高预算或换个槽位' };
  }

  const coupon = current.coupon;
  return {
    ok: true,
    result: {
      ...current,
      items: merged,
      totalCents,
      remainCents: current.budgetCents - totalCents,
      usedRatio: current.budgetCents > 0 ? totalCents / current.budgetCents : 0,
      afterCouponCents: coupon ? Math.max(0, totalCents - coupon.amount) : totalCents,
      adjustedSlots: [...(current.adjustedSlots ?? []), slot],
    },
    replaced: { from: target.name, to: picked.name, crossCategory },
  };
}

/**
 * 确认搭配，生成下单所需的结构化数据。
 *
 * 注意：这里「确认」指的是把订单结构整理好、交给上层去调 calculate-price / create-order，
 * 领域层不直接发网络请求——保持纯函数，才能离线测试。
 */
export function confirmCombination({ current, storeId, peopleCount = 1 }) {
  if (!current?.ok || current.items.length === 0) {
    return { ok: false, reason: '没有可确认的搭配' };
  }

  return {
    ok: true,
    order: {
      storeId,
      peopleCount,
      items: current.items.map((i) => ({
        code: i.code,
        name: i.name,
        priceCents: i.priceCents,
        category: i.category,
        qty: 1,
      })),
      totalCents: current.totalCents,
      coupon: current.coupon,
      payCents: current.afterCouponCents,
    },
    summary: buildSummary(current, peopleCount),
  };
}

function buildSummary(current, peopleCount) {
  const lines = current.items.map((i) => `· ${i.name}（${i.category}）${fmtYuan(i.priceCents)} 元`);
  const couponLine = current.coupon
    ? `优惠券「${current.coupon.name}」立减 ${fmtYuan(current.coupon.amount)} 元`
    : '暂无可用优惠券';
  return [
    `本次扭出 ${current.items.length} 样${peopleCount > 1 ? `，按 ${peopleCount} 人份算` : ''}：`,
    ...lines,
    `合计 ${fmtYuan(current.totalCents)} 元，${couponLine}，实付约 ${fmtYuan(current.afterCouponCents)} 元`,
    current.remainCents > 0 ? `预算还剩 ${fmtYuan(current.remainCents)} 元` : '预算刚好用完',
  ].join('\n');
}

function fmtYuan(cents) {
  return (cents / 100).toFixed(2);
}

export { gacha };
