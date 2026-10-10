#!/usr/bin/env node
/**
 * src/interfaces/cli.js
 * ------------------------------------------------------------------
 * 命令行入口。
 *
 * 用法：
 *   node src/interfaces/cli.js doctor                      自检：检查 Token 与网络
 *   node src/interfaces/cli.js caps                        列出可设条件
 *   node src/interfaces/cli.js spin --address="上海虹桥站" --budget=40
 *   node src/interfaces/cli.js spin --address="深圳南山" --budget=80 \
 *        --avoid=spicy,pork --diet=light --must="巨无霸"
 *   node src/interfaces/cli.js reroll --address="..." --slot=2 --from=result.json
 *   node src/interfaces/cli.js confirm --address="..." --from=result.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GachaService } from '../app/gachaService.js';
import { McdMcpError } from '../infra/mcdMcpClient.js';
import { loadEnv, envSource, envFileCandidates } from '../infra/env.js';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';

try {
  switch (command) {
    case 'set-token':
      await setToken();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'caps':
    case 'capabilities':
      printCapabilities();
      break;
    case 'spin':
      await spin();
      break;
    case 'reroll':
      await reroll();
      break;
    case 'confirm':
      await confirm();
      break;
    case 'order':
      await order();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`未知命令：${command}`);
      printHelp();
      process.exit(1);
  }
} catch (error) {
  if (error instanceof McdMcpError) {
    console.error(`\n[${error.code}] ${error.message}\n`);
  } else {
    console.error(`\n执行失败：${error.message}\n`);
  }
  process.exit(1);
}

// ---------- 动作 ----------

async function order() {
  const address = requireArg(args.address, 'address', '门店地址');
  const from = requireArg(args.from, 'from', 'spin --save 保存的结果文件');
  const current = JSON.parse(await readFile(from, 'utf-8'));
  const service = await GachaService.fromEnv();

  // 下单是不可逆操作，必须让用户在终端再确认一次
  if (!args.yes) {
    console.log('⚠️  即将创建真实订单：\n');
    current.items?.forEach((i) => console.log(`  · ${i.name} ¥${(i.priceCents / 100).toFixed(2)}`));
    console.log(`\n合计 ¥${((current.totalCents ?? 0) / 100).toFixed(2)}`);
    console.log('\n确认下单请加 --yes 参数重新执行：');
    console.log(`  node src/interfaces/cli.js order --address="${address}" --from=${from} --yes`);
    process.exit(3);
  }

  console.log('正在创建订单…\n');
  const res = await service.placeOrder({
    address,
    current,
    peopleCount: current.options?.peopleCount ?? 1,
  });

  if (!res.ok) {
    console.error(`下单失败：${res.error ?? res.reason}`);
    process.exit(1);
  }

  console.log(res.summary);
  console.log(`\n订单号：${res.created.orderId}`);
  console.log(`状态：${res.created.status}`);
  if (res.created.storeName) console.log(`门店：${res.created.storeName}`);
  if (res.created.amount != null) console.log(`实付：${res.created.amount} 元`);
  if (res.created.pickupCode) console.log(`取餐码：${res.created.pickupCode}`);

  // 麦当劳 MCP 的下单接口不返回支付链接（官方 outputSchema 里就没有），
  // 支付在官方渠道完成。与其丢一句「未取到支付链接」让用户以为出错了，
  // 不如把真正有用的信息给全：截止时间比什么都重要。
  console.log('\n支付：请打开麦当劳官方 App / 小程序，在「我的订单」里完成支付。');
  if (res.created.expirePayTime) {
    console.log(`请在此时间前完成支付，超时订单会自动取消：${res.created.expirePayTime}`);
  }
}

/**
 * 把 Token 写进项目根目录的 .env。
 *
 * 存在的意义：在 Windows 上手动创建「.env」很容易失败——资源管理器
 * 不允许以点开头的文件名，记事本另存时又会自动补 .txt。与其教用户
 * 怎么绕过这些限制，不如给一条命令直接写好。
 */
async function setToken() {
  const token = args._[1]?.trim();
  if (!token) {
    console.error('用法：node src/interfaces/cli.js set-token <你的Token>');
    console.error('\nToken 申请地址：https://open.mcd.cn/mcp');
    console.error('（手机号登录 → 右上角「控制台」→ 激活 → 复制 Token）');
    process.exit(1);
  }

  const target = resolve(process.cwd(), '.env');
  const lines = ['# 麦麦扭蛋机 · MCP 凭证（本文件已被 gitignore，请勿提交）', `MCD_MCP_TOKEN=${token}`, ''];
  await writeFile(target, lines.join('\n'), 'utf-8');

  console.log(`Token 已写入：${target}`);
  console.log(`长度 ${token.length} 位，前缀 ${token.slice(0, 6)}…${token.slice(-4)}`);
  console.log('\n现在跑一次自检：');
  console.log('  node src/interfaces/cli.js doctor');
}

async function doctor() {
  console.log('麦麦扭蛋机 · 环境自检\n');

  // 必须先加载 .env 再读，否则即使文件存在也会误报「未设置」
  loadEnv();
  const source = envSource();
  const token = process.env.MCD_MCP_TOKEN?.trim();

  console.log(`MCD_MCP_TOKEN：${token ? `已设置（${token.slice(0, 6)}…${token.slice(-4)}）` : '未设置'}`);
  if (token && source) console.log(`读取来源：${source}`);
  console.log(`Node 版本：${process.version}`);

  if (!token) {
    console.log('\n还没有配置 Token。两种方式，任选其一：\n');
    console.log('方式一（推荐，一条命令搞定）：');
    console.log('  node src/interfaces/cli.js set-token 你的Token\n');
    console.log('方式二（手动创建文件）：');
    console.log(`  把 Token 写进 ${resolve(process.cwd(), '.env')}`);
    console.log('  内容为一行：MCD_MCP_TOKEN=你的Token\n');
    console.log('Token 申请地址：https://open.mcd.cn/mcp');
    console.log('（手机号登录 → 右上角「控制台」→ 激活 → 同意协议 → 复制 Token）\n');
    console.log('已自动查找过这些位置，都没找到：');
    envFileCandidates().slice(0, 5).forEach((p) => console.log(`  · ${p}`));
    process.exit(1);
  }

  const service = await GachaService.fromEnv();
  const health = (await service.adapterHealthCheck?.()) ?? { ok: true, toolCount: '未知' };
  console.log(`MCP 连接：正常，可用 Tool ${health.toolCount} 个`);
  console.log('\n一切就绪，可以扭了：');
  console.log('  node src/interfaces/cli.js spin --address="上海虹桥站" --budget=40');
}

function printCapabilities() {
  const service = new GachaService(null);
  const caps = service.capabilities();
  console.log('可以设置的忌口（--avoid，逗号分隔）：');
  console.log(caps.avoidTags.map((t) => `  ${t.key.padEnd(12)} ${t.label}`).join('\n'));
  console.log('\n可以设置的饮食目标（--diet）：');
  console.log(caps.dietGoals.map((t) => `  ${t.key.padEnd(12)} ${t.label}`).join('\n'));
  console.log('\n默认参数：');
  console.log(`  预算 ${caps.defaultConstraints.budget} 元，单品上限 ${caps.defaultConstraints.itemMax} 元`);
}

async function spin() {
  const address = requireArg(args.address, 'address', '门店地址或地标，如「上海虹桥站」');
  const service = await GachaService.fromEnv();

  console.log(`正在按「${address}」附近的在售菜单扭蛋…\n`);
  const result = await service.spin({
    address,
    budget: Number(args.budget ?? 40),
    itemMax: Number(args.itemMax ?? 30),
    mustInclude: splitList(args.must),
    avoidTags: splitList(args.avoid),
    dietGoal: args.diet ?? 'none',
    peopleCount: Number(args.people ?? 1),
  });

  if (!result.ok) {
    console.log(`这次没扭出来 😓\n${result.reason}\n`);
    if (result.suggestAdjustments?.length) {
      console.log('可以这样调：');
      result.suggestAdjustments.forEach((t) => console.log(`  · ${t}`));
    }
    process.exit(2);
  }

  renderResult(result);
  if (args.save) {
    await writeFile(args.save, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`\n结果已保存到 ${args.save}（可用于 reroll / confirm）`);
  }
}

async function reroll() {
  const address = requireArg(args.address, 'address', '门店地址');
  const from = requireArg(args.from, 'from', 'spin --save 保存的结果文件');
  const slot = Number(requireArg(args.slot, 'slot', '要重抽的槽位号'));
  const current = JSON.parse(await readFile(from, 'utf-8'));
  const service = await GachaService.fromEnv();
  const res = await service.reroll({ address, current, slot });
  if (!res.ok) {
    console.log(`重抽失败：${res.reason}`);
    process.exit(2);
  }
  console.log(`槽位 ${slot}：${res.replaced.from} → ${res.replaced.to}\n`);
  renderResult(res.result);
  if (args.save) await writeFile(args.save, JSON.stringify(res.result, null, 2), 'utf-8');
}

async function confirm() {
  const address = requireArg(args.address, 'address', '门店地址');
  const from = requireArg(args.from, 'from', 'spin --save 保存的结果文件');
  const current = JSON.parse(await readFile(from, 'utf-8'));
  const service = await GachaService.fromEnv();
  const res = await service.confirm({ address, current, peopleCount: current.options?.peopleCount ?? 1 });
  if (!res.ok) {
    console.log(`确认失败：${res.reason}`);
    process.exit(2);
  }
  console.log('搭配已确认：\n');
  console.log(res.summary);
  console.log('\n订单结构：');
  console.log(JSON.stringify(res.order, null, 2));
}

// ---------- 输出渲染 ----------

function renderResult(result) {
  const yuan = (c) => (c / 100).toFixed(2);
  console.log(`门店：${result.store.name}${result.store.distance ? `（${result.store.distance}m）` : ''}` +
    `${result.sceneLabel ? ` · ${result.sceneLabel}` : ''}`);
  console.log(`菜单：${result.catalogStats.total} 样在售，忌口过滤后 ${result.catalogStats.afterAvoid} 样\n`);

  console.log(`${result.scenePrefix ? result.scenePrefix + '｜' : ''}今天我抽到了「${result.funName}」——`);
  for (const item of result.items) {
    console.log(`  ${item.slot}. ${item.name.padEnd(16, ' ')} ${yuan(item.priceCents).padStart(6)} 元  [${item.reason}]`);
  }

  console.log(`\n合计 ${yuan(result.totalCents)} 元 / 预算 ${yuan(result.budgetCents)} 元（用了 ${Math.round(result.usedRatio * 100)}%）`);
  if (result.coupon) {
    console.log(`优惠券「${result.coupon.name}」立减 ${yuan(result.coupon.amount)} 元 → 实付约 ${yuan(result.afterCouponCents)} 元`);
  }
  if (result.nutrition.kcal != null) {
    console.log(`营养合计：约 ${result.nutrition.kcal} kcal，蛋白 ${result.nutrition.protein ?? '—'}g（${result.nutrition.covered}/${result.nutrition.total} 项有数据）`);
  }
  console.log(`品类多样性：${result.diversity}`);

  if (result.warnings?.length) {
    console.log('\n提醒：');
    result.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }
  if (result.catalogStats.filteredOut?.length) {
    console.log(`\n因忌口被排除 ${result.catalogStats.filteredOut.length} 样，例如：`);
    result.catalogStats.filteredOut.slice(0, 3).forEach((m) => console.log(`  · ${m.name}（${m.blockedBy}）`));
  }
  console.log('\n下一步：reroll --slot=N 换掉某一样，或 confirm 生成订单。');
}

function printHelp() {
  console.log(`麦麦扭蛋机 mcd-gacha —— 基于麦当劳 MCP 的随机搭配助手

用法：
  node src/interfaces/cli.js <命令> [参数]

命令：
  set-token <Token>         把 MCP Token 写进项目根目录的 .env
  doctor                    检查 MCP Token 与网络连接
  caps                      列出可设的忌口与饮食目标
  spin                      扭一次，生成搭配
  reroll                    重抽指定槽位
  confirm                   确认搭配并生成订单结构
  order                     创建真实订单（需加 --yes 二次确认）

参数（spin）：
  --address=<地址>          必填。门店地址或地标，如 "上海虹桥站"
  --budget=<元>             总预算，默认 40
  --itemMax=<元>            单品价格上限，默认 30
  --must=<关键词,关键词>   必选项，逗号分隔
  --avoid=<键,键>          忌口，键见 caps 命令
  --diet=<键>               饮食目标，键见 caps 命令
  --people=<人数>           用餐人数，默认 1
  --save=<路径>             把结果存成 JSON，供 reroll / confirm 使用

示例：
  node src/interfaces/cli.js spin --address="深圳南山科技园" --budget=60 --diet=light --avoid=spicy
  node src/interfaces/cli.js spin --address="上海虹桥站" --must="巨无霸,薯条" --save=r.json
  node src/interfaces/cli.js reroll --address="上海虹桥站" --slot=2 --from=r.json
`);
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      out[key] = rest.join('=');
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireArg(value, name, hint) {
  if (!value) {
    console.error(`缺少参数 --${name}：${hint}`);
    process.exit(1);
  }
  return value;
}
