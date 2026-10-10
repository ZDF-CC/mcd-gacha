/**
 * tests/run.js
 * ------------------------------------------------------------------
 * 零依赖测试。用 Node 内置 node:test + assert。
 * 跑法：npm test
 *
 * 重点覆盖：
 *   1. 预算永远不超（整数分运算的正确性）
 *   2. 忌口真的排除了东西
 *   3. 必选项一定在结果里
 *   4. 同一随机种子结果可复现（这是「扭蛋」能被测试的前提）
 *   5. 无解时给得出可操作建议，而不是干巴巴失败
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalog, applyAvoidRules, ALLERGY_RULES } from '../src/domain/catalog.js';
import { gacha, DIET_GOALS } from '../src/domain/gacha.js';
import { rerollSlot, confirmCombination } from '../src/domain/reveal.js';
import { nearestCity, distanceKm, CITY_COORDS } from '../src/domain/cityLocator.js';

// ---------- 测试数据：一份贴近真实麦当劳菜单的假目录 ----------

function fakeCatalog() {
  const meals = [
    { code: 'M1', name: '巨无霸', priceCents: 2200, category: '汉堡', tags: ['牛肉'], desc: '双层牛肉' },
    { code: 'M2', name: '香辣鸡腿堡', priceCents: 2000, category: '汉堡', tags: ['辣', '鸡肉'], desc: '辣味' },
    { code: 'M3', name: '板烧鸡腿堡', priceCents: 2100, category: '汉堡', tags: ['鸡肉'], desc: '酱香' },
    { code: 'M4', name: '麦香鱼', priceCents: 2300, category: '汉堡', tags: ['鱼'], desc: '深海鱼' },
    { code: 'M5', name: '中辣薯条', priceCents: 900, category: '小食', tags: ['辣'], desc: '薯条' },
    { code: 'M6', name: '麦乐鸡块', priceCents: 1900, category: '小食', tags: ['鸡肉'], desc: '鸡块' },
    { code: 'M7', name: '鸡翅', priceCents: 1500, category: '小食', tags: ['鸡肉', '辣'], desc: '炸鸡翅' },
    { code: 'M8', name: '可乐', priceCents: 700, category: '饮料', tags: [], desc: '可乐' },
    { code: 'M9', name: '中可', priceCents: 400, category: '饮料', tags: [], desc: '中杯可乐' },
    { code: 'M10', name: '麦乐鸡堡', priceCents: 2000, category: '汉堡', tags: ['鸡肉'], desc: '' },
    { code: 'M11', name: '田园脆鸡堡', priceCents: 2100, category: '汉堡', tags: ['鸡肉', '蔬菜'], desc: '有蔬菜' },
    { code: 'M12', name: '蔬菜沙拉', priceCents: 1200, category: '轻食', tags: ['蔬菜'], desc: '清爽' },
    { code: 'M13', name: '蛋挞', priceCents: 800, category: '甜品', tags: ['蛋'], desc: '' },
    { code: 'M14', name: '红豆冰', priceCents: 900, category: '甜品', tags: [], desc: '' },
  ].map((m) => ({ ...m, desc: m.desc ?? '', tags: m.tags ?? [] }));

  const nutrition = new Map([
    ['巨无霸', { kcal: 550, protein: 25, fat: 30, carb: 45, sodium: 900 }],
    ['可乐', { kcal: 140, protein: 0, fat: 0, carb: 36, sodium: 10 }],
    ['中可', { kcal: 90, protein: 0, fat: 0, carb: 23, sodium: 6 }],
    ['蔬菜沙拉', { kcal: 120, protein: 4, fat: 6, carb: 14, sodium: 300 }],
  ]);

  const coupons = [
    { id: 'C1', name: '满30减8', amount: 800, threshold: 3000 },
    { id: 'C2', name: '满50减15', amount: 1500, threshold: 5000 },
  ];

  return new Catalog({ meals, coupons, nutrition });
}

/** 可复现的伪随机数发生器（mulberry32） */
function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 目录层 ----------

test('Catalog：价格区间与品类统计正确', () => {
  const c = fakeCatalog();
  assert.equal(c.size, 14);
  assert.equal(c.priceRange().min, 400);
  assert.equal(c.priceRange().max, 2300);
  assert.ok(c.categories.includes('汉堡'));
});

test('Catalog：模糊搜索能按名称、描述、标签命中', () => {
  const c = fakeCatalog();
  assert.equal(c.search('巨无霸').length, 1);
  assert.equal(c.search('鸡腿').length, 2);
  assert.equal(c.search('蔬菜').length, 2); // 田园脆鸡堡的标签 + 蔬菜沙拉的名称
  assert.equal(c.search('不存在的东西').length, 0);
});

test('忌口规则：辣能排除所有辣味商品', () => {
  const c = fakeCatalog();
  const { kept, filteredOut } = applyAvoidRules(c, ['spicy']);
  assert.equal(filteredOut.length, 3, '香辣鸡腿堡、中辣薯条、鸡翅应被排除');
  assert.ok(!kept.some((m) => m.name.includes('辣')));
  assert.ok(filteredOut.every((m) => m.blockedBy === '辣'));
});

test('忌口规则：多个忌口叠加生效', () => {
  const c = fakeCatalog();
  const { kept } = applyAvoidRules(c, ['spicy', 'chicken']);
  assert.ok(!kept.some((m) => m.tags.includes('鸡肉')));
  assert.ok(!kept.some((m) => m.name.includes('辣')));
  assert.ok(kept.length > 0, '不应该把菜单清空');
});

test('忌口规则：不选任何忌口时原样返回', () => {
  const c = fakeCatalog();
  const { kept, filteredOut } = applyAvoidRules(c, []);
  assert.equal(kept.length, c.size);
  assert.equal(filteredOut.length, 0);
});

test('忌口规则：每条规则都能被关键词表覆盖', () => {
  for (const [key, rule] of Object.entries(ALLERGY_RULES)) {
    assert.ok(rule.patterns.length > 0, `${key} 缺少匹配模式`);
    assert.ok(rule.label, `${key} 缺少中文标签`);
  }
});

// ---------- 抽签算法 ----------

test('gacha：结果永远不超预算（跑 200 次随机验证）', () => {
  const c = fakeCatalog();
  for (let i = 0; i < 200; i++) {
    const r = gacha({
      catalog: c,
      constraints: { budgetCents: 5000, itemMaxCents: 3000, rng: seededRng(i) },
      rng: seededRng(i),
    });
    if (r.ok) {
      assert.ok(r.totalCents <= 5000, `第 ${i} 次超预算：${r.totalCents} > 5000`);
      assert.ok(r.remainCents >= 0);
    }
  }
});

test('gacha：必选项一定出现在结果里', () => {
  const c = fakeCatalog();
  for (let i = 0; i < 50; i++) {
    const r = gacha({
      catalog: c,
      constraints: { budgetCents: 6000, itemMaxCents: 3000, mustInclude: ['巨无霸'], rng: seededRng(i) },
      rng: seededRng(i),
    });
    assert.ok(r.ok, '预算足够时应该能抽出来');
    assert.ok(r.items.some((m) => m.name === '巨无霸'), '必选项巨无霸必须存在');
  }
});

test('gacha：单品上限生效', () => {
  const c = fakeCatalog();
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 5000, itemMaxCents: 1000, mustInclude: [], rng: seededRng(7) },
    rng: seededRng(7),
  });
  assert.ok(r.ok);
  for (const item of r.items) {
    assert.ok(item.priceCents <= 1000, `${item.name} 超过单品上限`);
  }
});

test('gacha：忌口在抽签时真正生效（结果里无辣）', () => {
  const c = fakeCatalog();
  const { kept } = applyAvoidRules(c, ['spicy']);
  const filtered = new Catalog({ meals: kept, coupons: c.coupons, nutrition: c.nutrition });
  const r = gacha({
    catalog: filtered,
    constraints: { budgetCents: 6000, itemMaxCents: 3000, avoidTags: ['spicy'], rng: seededRng(3) },
    rng: seededRng(3),
  });
  assert.ok(r.ok);
  for (const item of r.items) {
    assert.ok(!item.name.includes('辣'), `${item.name} 含辣，不该出现`);
  }
});

test('gacha：必选项超预算时明确报错并标记 mustFix', () => {
  const c = fakeCatalog();
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 1500, itemMaxCents: 3000, mustInclude: ['巨无霸', '麦乐鸡块'], rng: seededRng(1) },
    rng: seededRng(1),
  });
  assert.equal(r.ok, false);
  assert.equal(r.mustFix, true);
  assert.match(r.reason, /超出总预算/);
});

test('gacha：单品上限过低时无解且 reason 可读', () => {
  const c = fakeCatalog();
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 5000, itemMaxCents: 100, rng: seededRng(1) },
    rng: seededRng(1),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /过滤掉|找不到/);
});

test('gacha：相同随机种子产出相同结果（可复现）', () => {
  const c = fakeCatalog();
  const params = { budgetCents: 5000, itemMaxCents: 3000, mustInclude: ['巨无霸'] };
  const a = gacha({ catalog: c, constraints: { ...params, rng: seededRng(42) }, rng: seededRng(42) });
  const b = gacha({ catalog: c, constraints: { ...params, rng: seededRng(42) }, rng: seededRng(42) });
  assert.deepEqual(a.items.map((i) => i.code), b.items.map((i) => i.code));
  assert.equal(a.totalCents, b.totalCents);
});

test('gacha：不同随机种子产出不同结果（有随机性）', () => {
  const c = fakeCatalog();
  const codes = new Set();
  for (let i = 0; i < 20; i++) {
    const r = gacha({
      catalog: c,
      constraints: { budgetCents: 5000, itemMaxCents: 3000, rng: seededRng(i) },
      rng: seededRng(i),
    });
    if (r.ok) codes.add(r.items.map((m) => m.code).join(','));
  }
  assert.ok(codes.size > 1, '20 次不同种子应该产出多种组合');
});

test('gacha：优惠券在门槛内选减免比例最高的那张', () => {
  const c = fakeCatalog();
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 8000, itemMaxCents: 3000, mustInclude: ['巨无霸', '麦乐鸡块'], rng: seededRng(2) },
    rng: seededRng(2),
  });
  assert.ok(r.ok);
  // 必选 41 元，算法会继续把剩余预算填满，总价必然超过 50 元门槛，
  // 因此应该选「满50减15」而不是「满30减8」。
  assert.ok(r.totalCents >= 5000, `总价应达到 50 元门槛以上，实际 ${r.totalCents}`);
  assert.equal(r.coupon.id, 'C2');
  assert.equal(r.afterCouponCents, r.totalCents - 1500);
});

test('gacha：总价不够门槛时不硬塞券', () => {
  const c = fakeCatalog();
  // 巨无霸 22 元，预算 25 元。最便宜的搭配也凑不到 30 元门槛
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 2500, itemMaxCents: 3000, mustInclude: ['巨无霸'], rng: seededRng(2) },
    rng: seededRng(2),
  });
  assert.ok(r.ok, r.reason);
  assert.ok(r.totalCents <= 2500);
  assert.ok(r.totalCents < 3000, `总价应低于 30 元门槛，实际 ${r.totalCents}`);
  assert.equal(r.coupon, null);
  assert.equal(r.afterCouponCents, r.totalCents);
});

test('gacha：低卡目标倾向选出热量更低的组合', () => {
  const c = fakeCatalog();
  let lightKcal = 0;
  let noneKcal = 0;
  let lightCount = 0;
  let noneCount = 0;
  for (let i = 0; i < 30; i++) {
    const r1 = gacha({
      catalog: c,
      constraints: { budgetCents: 3000, itemMaxCents: 3000, dietGoal: 'light', rng: seededRng(i) },
      rng: seededRng(i),
    });
    if (r1.ok && r1.nutrition.kcal != null) { lightKcal += r1.nutrition.kcal; lightCount++; }
    const r2 = gacha({
      catalog: c,
      constraints: { budgetCents: 3000, itemMaxCents: 3000, dietGoal: 'none', rng: seededRng(i) },
      rng: seededRng(i),
    });
    if (r2.ok && r2.nutrition.kcal != null) { noneKcal += r2.nutrition.kcal; noneCount++; }
  }
  if (lightCount && noneCount) {
    assert.ok(lightKcal / lightCount < noneKcal / noneCount, '轻食模式的平均热量应低于无偏好模式');
  }
});

test('gacha：营养缺失时诚实标注覆盖率', () => {
  const c = fakeCatalog();
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 5000, itemMaxCents: 3000, rng: seededRng(11) },
    rng: seededRng(11),
  });
  assert.ok(r.ok);
  assert.equal(r.nutrition.total, r.items.length);
  assert.ok(r.nutrition.covered <= r.nutrition.total);
});

test('gacha：每个饮食目标都能正常返回，不崩', () => {
  const c = fakeCatalog();
  for (const key of Object.keys(DIET_GOALS)) {
    const r = gacha({
      catalog: c,
      constraints: { budgetCents: 6000, itemMaxCents: 3000, dietGoal: key, rng: seededRng(5) },
      rng: seededRng(5),
    });
    assert.ok(r.ok, `${key} 目标下应该能抽出来`);
  }
});

test('gacha：给不存在的必选项时不崩，且明确指出', () => {
  const c = fakeCatalog();
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 5000, itemMaxCents: 3000, mustInclude: ['海底捞'], rng: seededRng(9) },
    rng: seededRng(9),
  });
  assert.ok(r.ok, '其他项仍能抽出来');
  assert.equal(r.unresolvedMust.length, 1);
  assert.equal(r.unresolvedMust[0].keyword, '海底捞');
  assert.ok(r.warnings.some((w) => w.includes('海底捞')));
});

// ---------- 重抽与确认 ----------

test('rerollSlot：只换指定槽位，其他项和总价范围保持', () => {
  const c = fakeCatalog();
  const current = gacha({
    catalog: c,
    constraints: { budgetCents: 5000, itemMaxCents: 3000, mustInclude: ['巨无霸'], rng: seededRng(4) },
    rng: seededRng(4),
  });
  assert.ok(current.ok);

  const res = rerollSlot({ catalog: c, current, slot: 1, rng: seededRng(99) });
  if (res.ok) {
    assert.equal(res.result.items.length, current.items.length);
    assert.ok(res.result.totalCents <= current.budgetCents);
    for (const before of current.items.filter((i) => i.slot !== 1)) {
      const after = res.result.items.find((i) => i.slot === before.slot);
      assert.equal(after.code, before.code, '其他槽位不应被改动');
    }
  }
});

test('rerollSlot：槽位不存在时明确报错', () => {
  const c = fakeCatalog();
  const current = gacha({ catalog: c, constraints: { budgetCents: 5000 }, rng: seededRng(4) });
  const res = rerollSlot({ catalog: c, current, slot: 99 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /不存在/);
});

test('confirmCombination：生成结构完整的订单', () => {
  const c = fakeCatalog();
  const current = gacha({
    catalog: c,
    constraints: { budgetCents: 5000, itemMaxCents: 3000, rng: seededRng(6) },
    rng: seededRng(6),
  });
  const res = confirmCombination({ current, storeId: 'S123', peopleCount: 2 });
  assert.ok(res.ok);
  assert.equal(res.order.storeId, 'S123');
  assert.equal(res.order.peopleCount, 2);
  assert.equal(res.order.items.length, current.items.length);
  assert.equal(res.order.totalCents, current.totalCents);
  assert.ok(res.summary.includes('实付约'));
  for (const item of res.order.items) {
    assert.ok(item.code && item.name && item.qty === 1);
  }
});

test('rerollSlot：重抽一定真的换掉东西，不会原地不动', () => {
  const c = fakeCatalog();
  // 单品类场景：只留饮料，强制走「同品类只有一款」的死路
  const drinksOnly = new Catalog({
    meals: [
      { code: 'D1', name: '可乐', priceCents: 700, category: '饮料', tags: [], desc: '' },
    ],
    coupons: c.coupons,
    nutrition: c.nutrition,
  });
  const current = gacha({
    catalog: drinksOnly,
    constraints: { budgetCents: 5000, itemMaxCents: 3000, mustInclude: ['可乐'], rng: seededRng(4) },
    rng: seededRng(4),
  });
  assert.ok(current.ok);
  const res = rerollSlot({ catalog: drinksOnly, current, slot: 1, rng: seededRng(1) });
  // 只有一款可选，确实换不了，但必须明说而不是假装换了
  assert.equal(res.ok, false);
  assert.match(res.reason, /没有其他可换/);
});

test('rerollSlot：有多个候选时一定换成不同商品', () => {
  const c = fakeCatalog();
  for (let seed = 0; seed < 40; seed++) {
    const current = gacha({
      catalog: c,
      constraints: { budgetCents: 6000, itemMaxCents: 3000, rng: seededRng(seed) },
      rng: seededRng(seed),
    });
    if (!current.ok || current.items.length === 0) continue;
    const target = current.items[0];
    const res = rerollSlot({ catalog: c, current, slot: target.slot, rng: seededRng(seed * 31 + 7) });
    if (!res.ok) continue;
    assert.notEqual(res.replaced.to, res.replaced.from, `种子 ${seed} 未真正更换商品`);
  }
});

test('gacha：同品类不同款不会被重复选中（可乐与中可不同时出现）', () => {
  const c = fakeCatalog();
  for (let seed = 0; seed < 60; seed++) {
    const r = gacha({
      catalog: c,
      constraints: { budgetCents: 5000, itemMaxCents: 3000, rng: seededRng(seed) },
      rng: seededRng(seed),
    });
    if (!r.ok) continue;
    const drinkNames = r.items.filter((i) => i.category === '饮料').map((i) => i.name);
    const unique = new Set(drinkNames);
    assert.equal(unique.size, drinkNames.length, `种子 ${seed} 出现同类重复：${drinkNames.join('+')}`);
  }
});

test('gacha：必选项允许买两份（两人各一个）', () => {
  const c = fakeCatalog();
  const r = gacha({
    catalog: c,
    constraints: { budgetCents: 6000, itemMaxCents: 3000, mustInclude: ['巨无霸'], rng: seededRng(1) },
    rng: seededRng(1),
  });
  assert.ok(r.ok);
  assert.ok(r.items.some((i) => i.name === '巨无霸'), '必选项必须在');
  // 必选项不会被去重掉重复
  const bigMac = r.items.filter((i) => i.name === '巨无霸');
  assert.ok(bigMac.every((i) => i.reason.includes('必选')));
});

// ---------- 趣味组合名（产品红线：不编造功效）----------

test('funName：只描述口味氛围，不含任何健康功效或限量声称', async () => {
  const { funName } = await import('../src/domain/naming.js');

  // 遍历多种搭配组合，确保名字永远不越线
  const samples = [
    [{ code: 'a', name: '巨无霸', category: '汉堡' }, { code: 'b', name: '中辣薯条', category: '小食' }],
    [{ code: 'c', name: '蔬菜沙拉', category: '轻食' }],
    [{ code: 'd', name: '可乐', category: '饮料' }],
    [{ code: 'e', name: '蛋挞', category: '甜品' }],
    [{ code: 'f', name: '麦香鱼', category: '汉堡' }, { code: 'g', name: '麦乐鸡块', category: '小食' }, { code: 'h', name: '中可', category: '饮料' }],
  ];

  // 违禁词：任何形式的功效声称、限量、中奖承诺
  const FORBIDDEN = [
    /低卡/, /减脂/, /燃脂/, /瘦/, /健康/, /营养/, /低脂/, /高蛋白/, /增强免疫/,
    /限量/, /抢购/, /中奖/, /免费/, /新品首发/, /最健康/,
  ];

  for (const items of samples) {
    const name = funName({ items });
    assert.ok(name.endsWith('组合'), `名字应以此结尾：${name}`);
    for (const bad of FORBIDDEN) {
      assert.ok(!bad.test(name), `名字「${name}」含违禁词 ${bad}`);
    }
  }
});

test('funName：同样的搭配每次得到同样的名字', async () => {
  const { funName } = await import('../src/domain/naming.js');
  const items = [
    { code: 'a', name: '巨无霸', category: '汉堡' },
    { code: 'b', name: '薯条', category: '小食' },
  ];
  assert.equal(funName({ items }), funName({ items }));
  // 顺序不同但内容相同，名字也应一致（避免刷新换名）
  assert.equal(funName({ items }), funName({ items: [...items].reverse() }));
});

test('funName：名字与实际内容对得上', async () => {
  const { funName } = await import('../src/domain/naming.js');
  // 只有饮料 → 解渴
  assert.match(funName({ items: [{ code: 'a', name: '可乐', category: '饮料' }] }), /解渴/);
  // 只有甜品 → 甜心
  assert.match(funName({ items: [{ code: 'b', name: '蛋挞', category: '甜品' }] }), /甜心/);
  // 多品类多样 → 丰盛
  assert.match(
    funName({
      items: [
        { code: 'c', name: '巨无霸', category: '汉堡' },
        { code: 'd', name: '薯条', category: '小食' },
        { code: 'e', name: '可乐', category: '饮料' },
      ],
    }),
    /丰盛/
  );
  // 辣味 → 香辣
  assert.match(funName({ items: [{ code: 'f', name: '香辣鸡腿堡', category: '汉堡' }] }), /香辣/);
});

test('scenePrefix：返回中文时段词，未知时段返回空串', async () => {
  const { scenePrefix } = await import('../src/domain/naming.js');
  assert.equal(scenePrefix('午餐档'), '午间');
  assert.equal(scenePrefix('夜宵档'), '夜宵');
  assert.equal(scenePrefix('不存在的时段'), '');
  assert.equal(scenePrefix(undefined), '');
  // 刻意不含 emoji —— Windows 中文环境缺字体会渲染成豆腐块
  for (const label of ['深夜档', '早餐档', '午餐档', '下午茶档', '晚餐档', '夜宵档']) {
    const v = scenePrefix(label);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(v), `「${v}」含 emoji`);
  }
});

test('空搭配不会崩', async () => {
  const { funName } = await import('../src/domain/naming.js');
  assert.equal(funName({ items: [] }), '空组合');
  assert.equal(funName({}), '空组合');
});

// ---------- 下单链路（唯一会动真实数据的路径）----------

function orderMockAdapter(overrides = {}) {
  const catalog = fakeCatalog();
  return {
    calls: [],
    async findNearbyStore() { return { storeId: 'S1', name: '测试门店' }; },
    async listMeals() { return catalog.meals; },
    async listStoreCoupons() { return catalog.coupons; },
    async listNutrition() { return catalog.nutrition; },
    async now() { return { hour: 12, raw: '2026-10-10 12:00' }; },
    async bindAndListCoupons() { this.calls.push('bind'); return catalog.coupons; },
    async createOrder(payload) {
      // 模拟真实适配器的字段映射：服务层传 {code, qty}，
      // 适配器负责转成 MCP 需要的 {mealCode, count}
      this.calls.push('create');
      this.servicePayload = payload;
      this.lastPayload = {
        ...payload,
        items: payload.items.map((i) => ({ mealCode: i.code, count: i.qty ?? 1 })),
      };
      // 按官方 outputSchema 的真实结构返回：没有支付链接，只有 payId 等
      return {
        orderId: 'O123',
        payUrl: null,
        payId: 'P123',
        expirePayTime: '2026-10-10 15:30:00',
        pickupCode: '8842',
        status: '待支付',
        amount: '37.90',
        storeName: '测试门店',
      };
    },
    ...overrides,
  };
}

test('placeOrder：确认后创建订单并返回官方提供的订单信息', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  const adapter = orderMockAdapter();
  const svc = new GachaService(adapter);

  const spun = await svc.spin({ address: '测试', budget: 60, avoid: [], diet: 'none' });
  assert.ok(spun.ok, spun.reason);

  const res = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.ok(res.ok, res.error ?? res.reason);
  assert.equal(res.created.orderId, 'O123');
  // 麦当劳下单接口不返回支付链接，官方结构里只有 payId，所以 payUrl 必须为空
  assert.equal(res.created.payUrl, null, '不应该凭空造出支付链接');
  assert.equal(res.created.expirePayTime, '2026-10-10 15:30:00');
  assert.equal(res.created.pickupCode, '8842');
  // 下单前必须先领券
  assert.ok(adapter.calls.includes('bind'), '下单前应先领券');
  assert.ok(adapter.calls.indexOf('bind') < adapter.calls.indexOf('create'));
  // 传给 MCP 的参数只含下单必需字段，不能把内部展示字段一起塞过去
  assert.equal(adapter.lastPayload.storeId, 'S1');
  assert.equal(adapter.lastPayload.items.length, spun.items.length);
  for (const item of adapter.lastPayload.items) {
    assert.ok(item.mealCode, `缺少 mealCode：${JSON.stringify(item)}`);
    assert.equal(item.count, 1);
    // 内部字段不应泄漏到 MCP payload
    assert.equal(item.priceCents, undefined, 'priceCents 不应传给 MCP');
    assert.equal(item.category, undefined, 'category 不应传给 MCP');
  }
});

test('placeOrder：并发重复提交会被拦截，不会打两次 MCP', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  let createCount = 0;
  const adapter = orderMockAdapter({
    async createOrder(payload) {
      createCount++;
      // 模拟慢响应，让第二次请求撞上锁
      await new Promise((r) => setTimeout(r, 60));
      return { orderId: 'O999', payUrl: 'https://pay.example/O999', status: 'CREATED' };
    },
  });
  const svc = new GachaService(adapter);
  const spun = await svc.spin({ address: '测试', budget: 60, avoid: [], diet: 'none' });
  assert.ok(spun.ok);

  const [a, b] = await Promise.all([
    svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 }),
    svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 }),
  ]);

  assert.equal(createCount, 1, '两次并发请求只应真正下单一次');
  const rejected = [a, b].filter((r) => !r.ok);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 'MCD-3002');
  assert.match(rejected[0].error, /正在创建/);
});

test('placeOrder：下单失败后锁会释放，可以再次尝试', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  let attempts = 0;
  const adapter = orderMockAdapter({
    async createOrder() {
      attempts++;
      if (attempts === 1) throw new Error('模拟网络失败');
      return { orderId: 'O777', payUrl: 'https://pay.example/O777', status: 'CREATED' };
    },
  });
  const svc = new GachaService(adapter);
  const spun = await svc.spin({ address: '测试', budget: 60, avoid: [], diet: 'none' });

  await assert.rejects(() => svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 }));
  // 锁必须已释放，否则第二次永远进不去
  const second = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.ok(second.ok);
  assert.equal(second.created.orderId, 'O777');
});

test('placeOrder：领券失败不阻断下单', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  const adapter = orderMockAdapter({
    async bindAndListCoupons() { throw new Error('限流'); },
  });
  const svc = new GachaService(adapter);
  const spun = await svc.spin({ address: '测试', budget: 60, avoid: [], diet: 'none' });
  const res = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.ok(res.ok, '领券失败也应能下单');
  assert.equal(res.created.orderId, 'O123');
});

test('sceneLabel：时段标签随时间变化', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  const catalog = fakeCatalog();
  const make = (hour) =>
    new GachaService({
      async findNearbyStore() { return { storeId: 'S1', name: 'T' }; },
      async listMeals() { return catalog.meals; },
      async listStoreCoupons() { return catalog.coupons; },
      async listNutrition() { return catalog.nutrition; },
      async now() { return { hour, raw: '' }; },
    });

  for (const [hour, label] of [[3, '深夜档'], [8, '早餐档'], [12, '午餐档'], [15, '下午茶档'], [19, '晚餐档'], [23, '夜宵档']]) {
    const r = await make(hour).spin({ address: 'T', budget: 60, avoid: [], diet: 'none' });
    assert.ok(r.ok, r.reason);
    assert.equal(r.sceneLabel, label, `${hour} 点应为${label}`);
  }
});

test('placeOrder：下单成功后进入冷却，重复提交不会真的再下一单', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  let createCount = 0;
  // 无延迟：模拟「第一单已完成，用户又点了一次」——这正是双击场景
  const adapter = orderMockAdapter({
    async createOrder() {
      createCount++;
      return { orderId: `O${createCount}`, payUrl: 'https://pay.example/x', status: 'CREATED' };
    },
  });
  const svc = new GachaService(adapter);
  const spun = await svc.spin({ address: '测试', budget: 60, avoid: [], diet: 'none' });

  const first = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.ok(first.ok);
  assert.equal(createCount, 1);

  // 紧接着再点一次：必须被冷却锁拦住，不能产生第二单
  const second = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'MCD-3003');
  assert.match(second.error, /已经创建过订单/);
  // 被拦时要把上一单的结果回传给用户，方便其核对
  assert.equal(second.created.orderId, 'O1');
  assert.equal(createCount, 1, '冷却期内绝不能产生第二笔订单');
});

test('placeOrder：冷却期过后允许再次下单', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  let createCount = 0;
  const adapter = orderMockAdapter({
    async createOrder() {
      createCount++;
      return { orderId: `O${createCount}`, payUrl: 'https://pay.example/x', status: 'CREATED' };
    },
  });
  const svc = new GachaService(adapter);
  svc.orderCooldownMs = 20; // 把冷却缩短到 20ms 以便测试
  const spun = await svc.spin({ address: '测试', budget: 60, avoid: [], diet: 'none' });

  await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  const blocked = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.equal(blocked.code, 'MCD-3003');

  await new Promise((r) => setTimeout(r, 40));
  const third = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.ok(third.ok, '冷却期过后应允许再次下单');
  assert.equal(createCount, 2);
});

test('placeOrder：参数校验失败不占冷却锁', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  let createCount = 0;
  const adapter = orderMockAdapter({
    async createOrder() { createCount++; return { orderId: 'O1', payUrl: 'u', status: 'C' }; },
  });
  const svc = new GachaService(adapter);

  // 空搭配过不了校验，不应打 MCP，也不该留下锁
  const bad = await svc.placeOrder({ address: '测试', current: { ok: false, items: [] }, peopleCount: 1 });
  assert.equal(bad.ok, false);
  assert.equal(createCount, 0);

  // 紧接着正常下单应成功，说明锁已被正确释放
  const spun = await svc.spin({ address: '测试', budget: 60, avoid: [], diet: 'none' });
  const good = await svc.placeOrder({ address: '测试', current: spun, peopleCount: 1 });
  assert.ok(good.ok, good.error);
  assert.equal(createCount, 1);
});

test('confirmCombination：空结果不能确认', () => {
  const res = confirmCombination({ current: { ok: false, items: [] }, storeId: 'S1' });
  assert.equal(res.ok, false);
});

// ---------- 参数归一化（防字段名拼错导致忌口静默失效）----------

test('normalizeParams：网页层的 avoid 字段能正确传到 avoidTags', async () => {
  const { normalizeParams } = await import('../src/app/gachaService.js');
  const p = normalizeParams({ address: '上海', avoid: 'spicy,chicken', diet: 'light', must: '巨无霸, 薯条', people: '2' });
  assert.deepEqual(p.avoidTags, ['spicy', 'chicken']);
  assert.equal(p.dietGoal, 'light');
  assert.deepEqual(p.mustInclude, ['巨无霸', '薯条']);
  assert.equal(p.peopleCount, 2);
});

test('normalizeParams：CLI 层的 avoidTags 字段同样有效', async () => {
  const { normalizeParams } = await import('../src/app/gachaService.js');
  const p = normalizeParams({ address: '上海', avoidTags: ['pork'], dietGoal: 'indulge', mustInclude: ['巨无霸'] });
  assert.deepEqual(p.avoidTags, ['pork']);
  assert.equal(p.dietGoal, 'indulge');
  assert.deepEqual(p.mustInclude, ['巨无霸']);
});

test('normalizeParams：金额优先按元解释，分单位键存在时换算正确', async () => {
  const { normalizeParams } = await import('../src/app/gachaService.js');
  assert.equal(normalizeParams({ address: 'a', budget: 60 }).budget, 60);
  assert.equal(normalizeParams({ address: 'a', budgetCents: 6000 }).budget, 60);
  // 缺省值
  assert.equal(normalizeParams({ address: 'a' }).budget, 40);
  assert.equal(normalizeParams({ address: 'a' }).itemMax, 30);
  // 非法值回落到默认，不产生 NaN
  assert.equal(normalizeParams({ address: 'a', budget: 'abc' }).budget, 40);
});

test('GachaService：忌口参数拼错时会报错而不是静默失效', async () => {
  const { GachaService } = await import('../src/app/gachaService.js');
  const catalog = fakeCatalog();
  const svc = new GachaService({
    async findNearbyStore() { return { storeId: 'S1', name: '测试门店' }; },
    async listMeals() { return catalog.meals; },
    async listStoreCoupons() { return catalog.coupons; },
    async listNutrition() { return catalog.nutrition; },
    async now() { return { hour: 12, raw: '2026-10-10 12:00' }; },
  });
  // 模拟网页端传了 avoid
  const r = await svc.spin({ address: '测试', budget: 60, avoid: ['spicy'], diet: 'none' });
  assert.ok(r.ok, r.reason);
  assert.ok(r.catalogStats.afterAvoid < r.catalogStats.total, 'avoid 字段必须真的生效');
  for (const item of r.items) {
    assert.ok(!item.name.includes('辣'), `${item.name} 含辣却出现在结果里`);
  }
});

// ---------- 压力测试 ----------

test('压力测试：2000 次随机组合，金额永远不超、结果永远自洽', () => {
  const c = fakeCatalog();
  const budgets = [2000, 3500, 5000, 8000, 12000];
  const itemMaxes = [1000, 2000, 3000];
  const diets = Object.keys(DIET_GOALS);

  for (let i = 0; i < 2000; i++) {
    const budget = budgets[i % budgets.length];
    const itemMax = itemMaxes[i % itemMaxes.length];
    const diet = diets[i % diets.length];
    const rng = seededRng(i * 7919);

    const r = gacha({ catalog: c, constraints: { budgetCents: budget, itemMaxCents: itemMax, dietGoal: diet, rng }, rng });
    if (!r.ok) continue;

    // 不变量 1：总价不超预算
    assert.ok(r.totalCents <= budget, `超预算 ${r.totalCents}>${budget}`);
    // 不变量 2：剩余预算非负
    assert.ok(r.remainCents >= 0);
    // 不变量 3：槽位连续且唯一
    assert.deepEqual(r.items.map((i2) => i2.slot), r.items.map((_, idx) => idx + 1));
    // 不变量 4：单价不超上限（必选项可能被显式标记，但这里没传必选，所以应严格成立）
    for (const item of r.items) {
      assert.ok(item.priceCents <= itemMax, `${item.name} 超单品上限`);
    }
    // 不变量 5：实付 = 总价 - 券，且不为负
    if (r.coupon) {
      assert.equal(r.afterCouponCents, Math.max(0, r.totalCents - r.coupon.amount));
    }
    // 不变量 6：营养汇总项数不超过总数
    assert.ok(r.nutrition.covered <= r.nutrition.total);
  }
});

// ---------- 定位：经纬度 → 城市名 ----------

test('定位：市中心坐标能推断出正确的城市', () => {
  const cases = [
    ['上海人民广场', 31.2304, 121.4737, '上海'],
    ['深圳福田', 22.5431, 114.0579, '深圳'],
    ['北京天安门', 39.9087, 116.3975, '北京'],
    ['江门蓬江', 22.59, 113.08, '江门'],
    ['广州天河', 23.13, 113.32, '广州'],
    ['成都春熙路', 30.657, 104.081, '成都'],
  ];
  for (const [label, lat, lng, expected] of cases) {
    const r = nearestCity(lat, lng);
    assert.equal(r.ok, true, `${label} 应该定位成功`);
    assert.equal(r.city, expected, `${label} 应该定位到 ${expected}`);
    assert.equal(r.confidence, 'high', `${label} 的置信度应该是 high`);
  }
});

test('定位：距离计算符合常识量级', () => {
  const shToBj = distanceKm(31.2304, 121.4737, 39.9087, 116.3975);
  assert.ok(shToBj > 1000 && shToBj < 1100, `上海到北京约 1067km，实际 ${shToBj}`);

  const gzToSz = distanceKm(23.13, 113.26, 22.5431, 114.0579);
  assert.ok(gzToSz > 100 && gzToSz < 160, `广州到深圳约 120km，实际 ${gzToSz}`);

  // 同一点距离为 0
  assert.ok(distanceKm(31.23, 121.47, 31.23, 121.47) < 0.001);
});

test('定位：无效或越界坐标返回失败而不是瞎猜', () => {
  // 关键：这些值都能被 Number() 转成 0，绝不能被当成「纬度 0 经度 0」
  const badValues = [null, undefined, '', '   ', 'abc', NaN, [], {}, true, false];
  for (const bad of badValues) {
    assert.equal(nearestCity(bad, bad).ok, false, `${JSON.stringify(bad)} 应判为无效`);
    assert.equal(nearestCity(bad, 121.47).ok, false, `纬度为 ${JSON.stringify(bad)} 时应判为无效`);
    assert.equal(nearestCity(31.23, bad).ok, false, `经度为 ${JSON.stringify(bad)} 时应判为无效`);
  }

  assert.equal(nearestCity(91, 121).ok, false, '纬度 91 度不合法');
  assert.equal(nearestCity(-91, 121).ok, false, '纬度 -91 度不合法');
  assert.equal(nearestCity(31, 181).ok, false, '经度 181 度不合法');
  assert.equal(nearestCity(31, -181).ok, false, '经度 -181 度不合法');

  // 字符串形式的数字应该被接受（表单传值常见）
  assert.equal(nearestCity('31.2304', '121.4737').city, '上海');
});

test('定位：离所有城市都很远时明确告知不可靠，而不是装作确定', () => {
  // 太平洋中部
  const r = nearestCity(0, 0);
  assert.equal(r.ok, true, '仍然返回一个结果，供用户参考');
  assert.equal(r.confidence, 'low');
  assert.ok(r.message.includes('建议手动填写'), '必须提示用户手动填写，不能假装很准');
});

// ---------- 下单：唯一有副作用的调用，失败必须响亮地失败 ----------

/** 造一个只返回预设结果的假 MCP 客户端 */
function fakeMcpClient(response) {
  return {
    async callTool() {
      return response;
    },
    async listTools() {
      return [];
    },
  };
}

test('createOrder：服务端返回 success:false 时必须抛错，不能假装下单成功', async () => {
  const { McdAdapter } = await import('../src/infra/mcdAdapter.js');
  const adapter = new McdAdapter(
    fakeMcpClient({ data: { success: false, message: '门店已打烊', data: null } })
  );

  await assert.rejects(
    () => adapter.createOrder({ storeId: 'S1', items: [{ code: 'M1', qty: 1 }] }),
    (err) => {
      assert.equal(err.code, 'MCD-3001');
      assert.ok(err.message.includes('门店已打烊'), '服务端的失败原因要原样带到用户面前');
      assert.ok(err.message.includes('没有产生订单'), '要明确告诉用户没有产生订单');
      return true;
    }
  );
});

test('createOrder：返回里没有订单号时必须抛错，不能当作成功', async () => {
  const { McdAdapter } = await import('../src/infra/mcdAdapter.js');
  const adapter = new McdAdapter(
    fakeMcpClient({ data: { success: true, data: { orderDetail: {} } } })
  );

  await assert.rejects(
    () => adapter.createOrder({ storeId: 'S1', items: [{ code: 'M1', qty: 1 }] }),
    (err) => {
      assert.equal(err.code, 'MCD-3001');
      assert.ok(err.message.includes('无法确认'), '要如实说明无法确认订单状态');
      return true;
    }
  );
});

test('createOrder：成功时解析官方结构，且绝不伪造支付链接', async () => {
  const { McdAdapter } = await import('../src/infra/mcdAdapter.js');
  const adapter = new McdAdapter(
    fakeMcpClient({
      data: {
        success: true,
        data: {
          orderDetail: {
            orderId: 'O999',
            orderStatus: '待支付',
            payId: 'P999',
            expirePayTime: '2026-10-10 15:30:00',
            pickupCode: '8842',
            realTotalAmount: '37.90',
            storeName: '麦当劳测试餐厅',
          },
        },
      },
    })
  );

  const r = await adapter.createOrder({ storeId: 'S1', items: [{ code: 'M1', qty: 2 }] });
  assert.equal(r.orderId, 'O999');
  assert.equal(r.status, '待支付');
  assert.equal(r.payId, 'P999');
  assert.equal(r.expirePayTime, '2026-10-10 15:30:00', '支付截止时间比支付链接更有用');
  assert.equal(r.pickupCode, '8842');
  assert.equal(r.amount, '37.90');
  assert.equal(r.storeName, '麦当劳测试餐厅');
  // 官方不提供支付链接，就绝不能凭空编一个出来
  assert.equal(r.payUrl, null);
});

test('定位：城市坐标表本身是自洽的', () => {
  // 数量与去重：不能有重复城市名，坐标必须在合法范围
  const names = CITY_COORDS.map((c) => c[0]);
  assert.equal(new Set(names).size, names.length, '城市名不能重复');

  for (const [city, lat, lng] of CITY_COORDS) {
    assert.ok(lat > 17 && lat < 55, `${city} 纬度 ${lat} 超出中国大陆范围`);
    assert.ok(lng > 70 && lng < 136, `${city} 经度 ${lng} 超出中国大陆范围`);
  }
});
