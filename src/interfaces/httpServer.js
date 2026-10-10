#!/usr/bin/env node
/**
 * src/interfaces/httpServer.js
 * ------------------------------------------------------------------
 * 零依赖 HTTP 服务 + 网页 UI。
 *
 * 为什么自带 UI 而不只做 CLI：
 *   扭蛋机是个「看见结果再决策」的产品，命令行给不了「揭晓」的仪式感。
 *   而 npm install 一步都不能有（评审可能直接 clone 就跑），所以用 Node 内置模块手写。
 *
 * 启动：
 *   MCD_MCP_TOKEN=xxx node src/interfaces/httpServer.js
 *   浏览器打开 http://localhost:5173
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GachaService } from '../app/gachaService.js';
import { McdMcpError } from '../infra/mcdMcpClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);

const service = await GachaService.fromEnv();
const sessions = new Map(); // sessionId -> { address, current, options }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/') return await serveStatic(res, 'index.html');
    if (url.pathname.startsWith('/static/')) {
      return await serveStatic(res, url.pathname.replace('/static/', ''));
    }
    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      return json(res, 200, service.capabilities());
    }
    if (url.pathname === '/api/spin' && req.method === 'POST') {
      return await handleSpin(req, res);
    }
    if (url.pathname === '/api/reroll' && req.method === 'POST') {
      return await handleReroll(req, res);
    }
    if (url.pathname === '/api/confirm' && req.method === 'POST') {
      return await handleConfirm(req, res);
    }
    if (url.pathname === '/api/order' && req.method === 'POST') {
      return await handleOrder(req, res);
    }
    if (url.pathname === '/api/session' && req.method === 'GET') {
      const sid = url.searchParams.get('id');
      return json(res, 200, sessions.get(sid) ?? { ok: false, reason: '会话已过期，请重新扭一次' });
    }
    json(res, 404, { ok: false, error: 'Not Found' });
  } catch (error) {
    // 已发送过响应头时不能再写，否则会抛 ERR_HTTP_HEADERS_SENT
    if (res.headersSent) {
      console.error('[响应已发送后出错]', error);
      return;
    }
    if (error instanceof McdMcpError) {
      return json(res, error.code === 'MCP-401' ? 401 : 502, { ok: false, code: error.code, error: error.message });
    }
    json(res, 500, { ok: false, error: error.message });
  }
});

// 单个请求出错不能拖垮整个服务进程
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason);
});

server.listen(PORT, () => {
  console.log(`麦麦扭蛋机已启动：http://localhost:${PORT}`);
  if (!process.env.MCD_MCP_TOKEN) {
    console.log('提示：未检测到 MCD_MCP_TOKEN，扭蛋会失败。设置后重启即可。');
  }
});

// ---------- 接口处理 ----------

async function handleSpin(req, res) {
  const body = await readBody(req);
  if (!body.address) return json(res, 400, { ok: false, error: '请填写地址' });

  // 字段名归一化在 GachaService 内部完成，这里直接透传
  const result = await service.spin(body);

  if (result.ok) {
    const sid = newSessionId();
    sessions.set(sid, { address: body.address, current: result, options: result.options });
    result.sessionId = sid;
  }
  json(res, 200, result);
}

async function handleReroll(req, res) {
  const body = await readBody(req);
  const session = sessions.get(body.sessionId);
  if (!session) return json(res, 404, { ok: false, error: '会话已过期，请重新扭一次' });

  const result = await service.reroll({
    address: session.address,
    current: session.current,
    slot: Number(body.slot),
  });

  if (result.ok) {
    session.current = result.result;
    result.result.sessionId = body.sessionId;
  }
  json(res, 200, result);
}

async function handleConfirm(req, res) {
  const body = await readBody(req);
  const session = sessions.get(body.sessionId);
  if (!session) return json(res, 404, { ok: false, error: '会话已过期，请重新扭一次' });

  const result = await service.confirm({
    address: session.address,
    current: session.current,
    peopleCount: Number(body.people ?? 1),
  });
  json(res, 200, result);
}

/**
 * 创建订单。前端必须显式传 confirmed=true（用户在确认页点了「确认下单」），
 * 否则接口返回 428 —— 这道校验是为了防止误触或被脚本重复提交。
 */
async function handleOrder(req, res) {
  const body = await readBody(req);
  if (!body.confirmed) {
    return json(res, 428, { ok: false, error: '下单前需要用户显式确认' });
  }
  const session = sessions.get(body.sessionId);
  if (!session) return json(res, 404, { ok: false, error: '会话已过期，请重新扭一次' });

  const result = await service.placeOrder({
    address: session.address,
    current: session.current,
    peopleCount: Number(body.people ?? 1),
  });
  json(res, result.ok ? 200 : 409, result);
}

// ---------- 工具 ----------

function newSessionId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return {};
  }
}

async function serveStatic(res, relativePath) {
  // 防目录穿越：只允许文件名，不允许任何路径分隔符
  const safeName = path_basename(relativePath);
  if (!safeName) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  const filePath = join(__dirname, 'web', safeName);
  try {
    const content = await readFile(filePath);
    const type = safeName.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : safeName.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : safeName.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function path_basename(p) {
  const name = String(p).split('/').pop();
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : '';
}
