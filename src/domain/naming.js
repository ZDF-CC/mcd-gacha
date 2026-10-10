/**
 * src/domain/naming.js
 * ------------------------------------------------------------------
 * 趣味组合名的生成。
 *
 * 产品红线：名字只描述**口味与氛围**，绝不编造营养功效、限量信息或中奖可能。
 *   ✅「香辣快乐组合」—— 描述口味和心情
 *   ❌「低卡燃脂活力餐」—— 暗示健康功效，是虚假声称
 *   ❌「限量发售」   —— 编造事实
 *
 * 放在 domain 层而不是前端，是因为 CLI 和网页都要用同一套命名，
 * 且这部分逻辑需要能被单元测试覆盖。
 */

/**
 * 时段前缀。
 *
 * 刻意不用 emoji：Windows 中文环境普遍缺少 emoji 字体，会渲染成豆腐块「□」，
 * 比纯文字更难看。用中文时段词，跨平台渲染一致。
 */
const SCENE_PREFIX = {
  深夜档: '深夜',
  早餐档: '清晨',
  午餐档: '午间',
  下午茶档: '午后',
  晚餐档: '傍晚',
  夜宵档: '夜宵',
};

export function scenePrefix(label) {
  return SCENE_PREFIX[label] ?? '';
}

/** 风味关键词 → 形容词。全部是口味描述，不涉及健康声称。 */
const FLAVOR_WORDS = [
  { test: /巨无霸/, word: '厚实' },
  { test: /辣/, word: '香辣' },
  { test: /鱼|虾|蟹|鱿鱼/, word: '海鲜' },
  { test: /牛/, word: '牛肉' },
  { test: /鸡/, word: '鸡香' },
  { test: /猪|培根|火腿/, word: '咸香' },
  { test: /沙拉|蔬菜|轻食/, word: '清爽' },
  { test: /可乐|雪碧|汽水|雪泡/, word: '气泡' },
  { test: /奶|乳/, word: '奶香' },
  { test: /薯|块|翅|脆/, word: '酥脆' },
  { test: /蛋/, word: '蛋香' },
  { test: /麦|面包|派/, word: '麦香' },
];

/** 心情词，纯主观感受，不承诺任何结果 */
const MOOD_WORDS = ['快乐', '满足', '治愈', '放松', '惬意', '尽兴', '惊喜', '轻松'];

/**
 * 生成组合名。
 * @param {{items: Array<{code:string,name:string,category:string}>}} result
 * @returns {string} 形如「香辣快乐组合」
 */
export function funName(result) {
  const items = result?.items ?? [];
  if (items.length === 0) return '空组合';

  const names = items.map((i) => i.name).join(' ');
  const cats = new Set(items.map((i) => i.category));
  const flavor = FLAVOR_WORDS.find((f) => f.test.test(names))?.word;

  // 按品类结构决定氛围词，让名字和实际内容对得上
  let mood;
  if (items.length >= 3 && cats.size >= 2) mood = '丰盛';
  else if (cats.has('轻食')) mood = MOOD_WORDS[hashOf(items) % 3];
  else if (cats.size === 1 && cats.has('饮料')) mood = '解渴';
  else if (cats.size === 1 && cats.has('甜品')) mood = '甜心';
  else mood = MOOD_WORDS[hashOf(items) % MOOD_WORDS.length];

  return `${flavor ?? ''}${mood}组合`;
}

/**
 * 稳定哈希：同样的搭配每次都得到同样的名字。
 * 不用 Math.random()，否则刷新页面就换名，用户会以为结果变了。
 */
function hashOf(items) {
  const key = items.map((i) => i.code).sort().join('|');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}