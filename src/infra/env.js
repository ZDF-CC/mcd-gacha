/**
 * src/infra/env.js
 * ------------------------------------------------------------------
 * 读取项目根目录的 .env 并注入 process.env。
 *
 * 为什么需要这个文件，而不是只让用户设环境变量：
 *   环境变量是「按进程」的——用户在 A 窗口设了，B 窗口（自动化工具、
 *   IDE 内置终端、CI）都读不到。这在实际协作里非常容易踩坑：
 *   「我明明设了 Token，为什么提示未设置」。
 *   支持 .env 之后 Token 写在项目里，谁启动都能用，且 .env 已被 gitignore。
 *
 * 为什么又额外认 .env.txt / mcp-token.txt：
 *   在 Windows 上用记事本或资源管理器创建「.env」几乎必然失败——
 *   资源管理器会拒绝以点开头的文件名，另存时又会默认加 .txt 后缀。
 *   与其让用户在文件名上反复试错，不如多认几个名字，把文件内容兜住。
 *
 * 刻意不引第三方 dotenv——这个功能只有几十行，自己写更可控，
 * 也保持了「零依赖」这个项目最重要的特性。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

let loaded = false;
/** 记录 Token 实际是从哪个文件读到的，doctor 会展示出来，方便排查。 */
let loadedFrom = null;

/**
 * 按优先级列出所有可能的配置文件位置。
 * 顺序即优先级：越靠前越优先，但「真实环境变量」永远最优先（见 inject）。
 */
export function envFileCandidates() {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(here, '..', '..');
  const home = homedir();

  const names = ['.env', '.env.local', '.env.txt', 'mcp-token.txt', 'token.txt'];
  const dirs = [projectRoot, process.cwd(), home];

  const list = [process.env.MCD_ENV_FILE].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) list.push(resolve(dir, name));
  }
  return list;
}

/**
 * 解析一行配置。返回 null 表示这行不是有效配置。
 *
 * 除了标准 KEY=value，还兼容两种「用户手搓」的情况：
 *   - 文件里只有一行裸 Token（没有 KEY=），当作 MCD_MCP_TOKEN
 *   - 值被引号包住，或行尾有多余空格 / BOM
 */
function parseLine(raw) {
  const line = raw.replace(/^﻿/, '').trim();
  if (!line || line.startsWith('#')) return null;

  const eq = line.indexOf('=');
  if (eq === -1) {
    // 裸 Token：一整行就是 Token 本身
    // 用长度和字符集简单判断，避免把注释或空行误认成 Token
    if (line.length >= 8 && !/\s/.test(line)) return ['MCD_MCP_TOKEN', line];
    return null;
  }

  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!key) return null;
  return [key, value];
}

export function loadEnv() {
  if (loaded) return loadedFrom;
  loaded = true;

  for (const file of envFileCandidates()) {
    if (!existsSync(file)) continue;
    try {
      let found = false;
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const pair = parseLine(line);
        if (!pair) continue;
        const [key, value] = pair;
        // 已有真实环境变量时以环境变量为准，不被文件覆盖
        if (process.env[key] === undefined && value) {
          process.env[key] = value;
          found = true;
        }
      }
      if (found) {
        loadedFrom = file;
        return loadedFrom;
      }
    } catch {
      // 读失败不阻断，继续找下一个候选
    }
  }
  return null;
}

/** 给 doctor 用：Token 是从哪个文件读到的，没读到就是 null。 */
export function envSource() {
  return loadedFrom;
}
