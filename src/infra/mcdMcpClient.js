/**
 * src/infra/mcdMcpClient.js
 * ------------------------------------------------------------------
 * 麦当劳 MCP Server 的零依赖客户端。
 *
 * 为什么手写而不用 @modelcontextprotocol/sdk：
 *   1. 麦当劳 MCP 用的是 Streamable HTTP 传输，协议本身极简——
 *      就是「POST 一个 JSON-RPC 请求体到 https://mcp.mcd.cn」，
 *      sdk 带来的那一堆能力（sampling / roots / 传输协商）我们一个都用不上。
 *   2. 零依赖意味着 `git clone` 完直接 `node src/interfaces/cli.js` 就能跑，
 *      评审不需要先 npm install，克隆体验和失败率都最优。
 *   3. 出错信息靠自己写反而更清楚，不用翻 sdk 的内部异常栈。
 *
 * 协议要点（依据官方 README + MCP 规范）：
 *   - 传输：Streamable HTTP，单个端点 https://mcp.mcd.cn
 *   - 鉴权：请求头 Authorization: Bearer <MCP_TOKEN>
 *   - 会话：MCP 规范要求客户端先发 initialize 拿 sessionId，
 *           后续请求带 MCP-Session-Id 头。麦当劳实现对此是宽容的，
 *           我们仍然按规范做，带上更稳。
 *   - 通知：MCP 的 notification 是「收到 202 Accepted + 空 body」，
 *           不返回 JSON，这点和普通请求不同，代码里单独处理。
 *   - 限流：单 Token 每分钟 600 次，超了返回 429，客户端做退避重试。
 */

import { loadEnv } from './env.js';

const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn';

/** 从环境变量或项目 .env 读 Token；刻意不接受命令行传参，避免 Token 落进 shell history。 */
function readToken() {
  // 先尝试加载项目根目录的 .env，再读环境变量
  loadEnv();

  const token = process.env.MCD_MCP_TOKEN?.trim();
  if (!token) {
    throw new McdMcpError(
      'MCP-4001',
      '未找到 MCP Token。请用以下任一方式配置后重试。\n\n' +
        '方式一（推荐，一条命令写好，.env 已被 gitignore）：\n' +
        '  node src/interfaces/cli.js set-token 你的Token\n\n' +
        '方式二（手动建文件）：\n' +
        '  在项目根目录建 .env，内容为一行：MCD_MCP_TOKEN=你的Token\n\n' +
        '方式三（仅当前终端有效，换窗口就失效）：\n' +
        '  PowerShell: $env:MCD_MCP_TOKEN="你的Token"\n' +
        '  bash:       export MCD_MCP_TOKEN="你的Token"\n\n' +
        'Token 申请地址：https://open.mcd.cn/mcp'
    );
  }
  return token;
}

export class McdMcpError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'McdMcpError';
    this.code = code;
  }
}

export class McdMcpClient {
  #endpoint;
  #token;
  #sessionId = null;
  #nextId = 1;
  #initialized = false;
  #callTimes = [];

  constructor(options = {}) {
    // 无论是否显式传 token，都先加载 .env，让 MCD_MCP_ENDPOINT 等配置也能生效
    loadEnv();
    this.#endpoint = options.endpoint ?? process.env.MCD_MCP_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.#token = options.token ?? readToken();
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** MCP 规范的 initialize 握手，拿到会话 id。 */
  async connect() {
    if (this.#initialized) return this;
    await this.#rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mcd-gacha', version: '1.0.0' },
    });
    this.#initialized = true;
    // initialized 是通知，服务端回 202 且无 body，不能再走 JSON-RPC 解析
    await this.#notify('notifications/initialized');
    return this;
  }

  /**
   * 调用一个 MCP Tool。
   * @param {string} name Tool 名，见 README「工具列表」
   * @param {object} args 参数对象
   * @returns {Promise<any>} 解析后的 content / structuredContent
   */
  async callTool(name, args = {}) {
    await this.connect();
    const result = await this.#rpc('tools/call', { name, arguments: args });
    return normalizeToolResult(result);
  }

  /** 列出服务端当前可用的 Tool，用于 doctor 自检。 */
  async listTools() {
    await this.connect();
    const result = await this.#rpc('tools/list', {});
    return result?.tools ?? [];
  }

  // ---------- 内部：JSON-RPC 传输层 ----------

  async #rpc(method, params) {
    const id = this.#nextId++;
    const body = { jsonrpc: '2.0', id, method, params };
    const response = await this.#send(body, method);
    if (response?.error) {
      throw new McdMcpError(
        'MCP-5002',
        `调用 ${method} 失败：${response.error.message ?? '未知错误'}（code ${response.error.code ?? '-'}）`
      );
    }
    return response?.result;
  }

  async #notify(method, params = {}) {
    await this.#send({ jsonrpc: '2.0', method, params }, method, { expectEmpty: true });
  }

  async #send(body, label, { expectEmpty = false } = {}) {
    // 客户端侧限流：官方配额是 600 次/分钟，这里主动压到 500 次/分钟留余量
    this.#throttle();

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.#sendOnce(body, expectEmpty);
      } catch (error) {
        lastError = error;
        // 429 与 5xx 值得重试，4xx（Token 无效）是配置问题，重试没有意义
        const code = error?.code ?? '';
        const retryable = code === 'MCP-429' || code === 'MCP-5xx';
        if (!retryable || attempt === this.maxRetries) break;
        await sleep(600 * 2 ** attempt);
      }
    }
    throw new McdMcpError(
      lastError?.code ?? 'MCP-5000',
      `请求 ${label} 失败：${lastError?.message ?? '网络异常'}`,
      lastError
    );
  }

  async #sendOnce(body, expectEmpty) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.#token}`,
    };
    if (this.#sessionId) headers['MCP-Session-Id'] = this.#sessionId;

    let response;
    try {
      response = await fetch(this.#endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new McdMcpError('MCP-5000', `网络请求异常：${error.message}`, error);
    }

    // 会话 id 可能出现在首次 initialize 的响应头
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.#sessionId = sessionId;

    if (response.status === 202) return null; // 通知：符合预期
    if (response.status === 401) {
      throw new McdMcpError('MCP-401', 'MCP Token 无效或已过期，请到 https://open.mcd.cn/mcp 重新申请');
    }
    if (response.status === 429) {
      throw new McdMcpError('MCP-429', '触发麦当劳 MCP 限流（600 次/分钟），请降低调用频率');
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new McdMcpError('MCP-5xx', `服务端返回 ${response.status}：${detail.slice(0, 200)}`);
    }

    if (expectEmpty) return null;
    return parseRpcPayload(await response.text());
  }

  /** 滑动窗口限流，避免打到官方配额 */
  #throttle() {
    const now = Date.now();
    this.#callTimes = this.#callTimes.filter((t) => now - t < 60000);
    if (this.#callTimes.length >= 500) {
      // 理论上不会走到，因为我们是单进程串行调用；留着作为兜底
      const wait = 60000 - (now - this.#callTimes[0]);
      throw new McdMcpError('MCP-429', `本地限流触发，需等待 ${Math.ceil(wait / 1000)}s`);
    }
    this.#callTimes.push(now);
  }
}

/**
 * MCP 走 Streamable HTTP 时可能返回纯 JSON，也可能返回 SSE 帧（text/event-stream）。
 * 两种都要能解析，否则换个网关就连不上。
 */
function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return JSON.parse(trimmed);
  }

  // SSE：取最后一条 data: 帧，它对应本次请求的响应
  const frames = trimmed
    .split(/\n\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
    )
    .filter(Boolean);

  if (frames.length === 0) return null;
  return JSON.parse(frames.at(-1));
}

/**
 * Tool 返回值的归一化。
 * MCP 规范里 content 是内容块数组（text/image），业务数据可能在 structuredContent，
 * 也可能只是纯 text 的 JSON 字符串。统一拆成「业务数据 + 人类可读文本」两份。
 */
function normalizeToolResult(result) {
  if (!result) return { data: null, text: '' };

  if (result.structuredContent) {
    return { data: result.structuredContent, text: collectText(result) };
  }

  const text = collectText(result);
  const maybeJson = tryParseJson(text);
  if (maybeJson !== undefined) return { data: maybeJson, text };
  return { data: null, text };
}

function collectText(result) {
  if (!Array.isArray(result?.content)) return '';
  return result.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function tryParseJson(text) {
  if (!text) return undefined;
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '<无法读取响应体>';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
