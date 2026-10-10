/**
 * scripts/inspect-tools.mjs
 * 联调诊断脚本：拉取 MCP 工具的真实 schema 与原始返回，不打印任何凭证。
 * 用法：node scripts/inspect-tools.mjs [toolName] [jsonArgs]
 */
import { McdMcpClient } from '../src/infra/mcdMcpClient.js';

const toolName = process.argv[2];
const rawArgs = process.argv[3];

const client = new McdMcpClient();

if (!toolName) {
  const tools = await client.listTools();
  console.log(`共 ${tools.length} 个 Tool：\n`);
  for (const t of tools) {
    console.log(`· ${t.name}`);
    if (t.description) console.log(`  ${String(t.description).slice(0, 100)}`);
  }
  console.log('\n查看某个工具的参数定义：');
  console.log('  node scripts/inspect-tools.mjs query-nearby-stores');
} else {
  const tools = await client.listTools();
  const t = tools.find((x) => x.name === toolName);
  if (!t) {
    console.error(`没有叫 ${toolName} 的工具。可用：\n${tools.map((x) => x.name).join(', ')}`);
    process.exit(1);
  }
  console.log('=== 参数定义 (inputSchema) ===');
  console.log(JSON.stringify(t.inputSchema, null, 2));
  if (t.description) console.log(`\n=== 官方描述 ===\n${t.description}`);

  if (rawArgs) {
    const args = JSON.parse(rawArgs);
    console.log(`\n=== 真实调用 ${toolName}，参数：${rawArgs} ===`);
    const res = await client.callTool(toolName, args);
    console.log('\n=== 原始返回 ===');
    console.log(JSON.stringify(res, null, 2).slice(0, 4000));
  }
}
