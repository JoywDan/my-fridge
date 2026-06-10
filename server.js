#!/usr/bin/env node
/*
 * 囡囡的冰箱 · Claude Code 后端
 *
 * 把 `claude -p`（Claude Code 无头模式）包成 HTTP 接口，
 * 给 index.html 提供 AI 聊天 / 菜谱生成 / 小票识别能力。
 *
 * 用法（在装好并登录了 Claude Code 的机器上）：
 *   FRIDGE_TOKEN=随便一串长口令 node server.js
 *
 * 环境变量：
 *   FRIDGE_TOKEN      访问口令（强烈建议设置，前端填同一个）
 *   PORT              监听端口，默认 7777
 *   CLAUDE_BIN        claude 可执行文件路径，默认 "claude"
 *   CLAUDE_MODEL      聊天/菜谱用的模型，默认 sonnet
 *   CLAUDE_SCAN_MODEL 识别小票用的模型，默认同 CLAUDE_MODEL
 *   CLAUDE_TIMEOUT_MS 单次调用超时，默认 180000
 *
 * 零依赖，Node 18+ 即可。同时也会把本目录的 index.html 等静态文件
 * 服务出来，所以直接访问 http://服务器:7777 就能用整个应用。
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '7777', 10);
const TOKEN = process.env.FRIDGE_TOKEN || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const SCAN_MODEL = process.env.CLAUDE_SCAN_MODEL || MODEL;
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '180000', 10);
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, '.uploads');

if (!TOKEN) {
  console.warn('[警告] 没有设置 FRIDGE_TOKEN，任何知道地址的人都能调用你的 Claude！');
  console.warn('       建议：FRIDGE_TOKEN=一串长口令 node server.js');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// ---------- claude -p ----------

function runClaude(prompt, opts, cb) {
  const args = ['-p', '--output-format', 'json', '--model', opts.model || MODEL];
  if (opts.system) args.push('--append-system-prompt', opts.system);
  if (opts.allowedTools) args.push('--allowedTools', opts.allowedTools);

  const child = spawn(CLAUDE_BIN, args, { cwd: ROOT, env: process.env });
  let out = '', err = '', done = false;

  const timer = setTimeout(function () {
    if (done) return;
    done = true;
    child.kill('SIGKILL');
    cb(new Error('Claude 响应超时（' + TIMEOUT_MS / 1000 + 's）'));
  }, TIMEOUT_MS);

  child.stdout.on('data', function (d) { out += d; });
  child.stderr.on('data', function (d) { err += d; });
  child.on('error', function (e) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(new Error('启动 claude 失败：' + e.message + '（检查 CLAUDE_BIN / PATH）'));
  });
  child.on('close', function (code) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (code !== 0) {
      return cb(new Error('claude 退出码 ' + code + '：' + (err || out).slice(0, 500)));
    }
    try {
      const j = JSON.parse(out);
      cb(null, typeof j.result === 'string' ? j.result : JSON.stringify(j.result));
    } catch (e) {
      cb(new Error('解析 claude 输出失败：' + out.slice(0, 300)));
    }
  });

  child.stdin.end(prompt);
}

function extractJsonArray(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

// ---------- 接口实现 ----------

// POST /api/chat  { system?, messages:[{role:'user'|'assistant', content}] } -> { reply }
function handleChat(body, res) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (!msgs.length) return sendJson(res, 400, { error: 'messages 不能为空' });

  let prompt;
  if (msgs.length === 1) {
    prompt = String(msgs[0].content || '');
  } else {
    prompt = '以下是你和用户的聊天记录，最后一条是用户刚发来的消息：\n\n';
    msgs.forEach(function (m) {
      prompt += (m.role === 'assistant' ? '你：' : '用户：') + String(m.content || '') + '\n';
    });
    prompt += '\n请直接输出你的回复正文，不要带"你："前缀，不要任何解释。';
  }

  runClaude(prompt, { system: body.system ? String(body.system) : '', model: MODEL }, function (err, reply) {
    if (err) return sendJson(res, 502, { error: err.message });
    sendJson(res, 200, { reply: reply });
  });
}

// POST /api/scan  { image: "data:image/jpeg;base64,..." } -> { items:[{name,cat,qty}] }
function handleScan(body, res) {
  const dataUrl = String(body.image || '');
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) return sendJson(res, 400, { error: 'image 需要是 base64 data URL（png/jpeg/webp）' });

  const ext = m[1] === 'png' ? '.png' : m[1] === 'webp' ? '.webp' : '.jpg';
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const file = path.join(UPLOAD_DIR, 'receipt-' + crypto.randomBytes(6).toString('hex') + ext);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));

  const prompt =
    '用 Read 工具读取这张图片：' + file + '\n\n' +
    '这是一张超市购物小票，或者网购订单/购物车的截图。请提取其中所有"食材 / 食品 / 饮品"类商品，' +
    '忽略纸巾、清洁剂、日用品等非食品，也忽略价格、税费、合计等信息。' +
    '商品名翻译成简体中文常用叫法（比如 CHKN BRST → 鸡胸肉，缩写要还原）。\n\n' +
    '严格按下面的 JSON 数组格式输出，不要 markdown 代码块，不要任何解释文字：\n' +
    '[{"name":"鸡胸肉","cat":"肉类","qty":"2磅"}]\n\n' +
    'cat 必须是：肉类、蔬菜、海鲜、蛋奶、主食、调料、其他 之一。\n' +
    'qty 尽量从图中读出数量或重量，读不出就写"1份"。\n' +
    '如果图里完全没有食品，输出 []';

  runClaude(prompt, { allowedTools: 'Read', model: SCAN_MODEL }, function (err, reply) {
    fs.unlink(file, function () {});
    if (err) return sendJson(res, 502, { error: err.message });
    const arr = extractJsonArray(reply);
    if (!arr) return sendJson(res, 502, { error: 'Claude 返回的不是有效 JSON：' + String(reply).slice(0, 200) });
    const items = arr
      .filter(function (it) { return it && it.name; })
      .map(function (it) {
        return {
          name: String(it.name).slice(0, 40),
          cat: String(it.cat || '其他').slice(0, 10),
          qty: String(it.qty || '1份').slice(0, 20)
        };
      });
    sendJson(res, 200, { items: items });
  });
}

// ---------- HTTP 基建 ----------

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req, maxBytes, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', function (c) {
    size += c.length;
    if (size > maxBytes) {
      cb(new Error('请求体太大'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', function () {
    if (size > maxBytes) return;
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (e) {
      cb(new Error('JSON 解析失败'));
    }
  });
  req.on('error', function (e) { cb(e); });
}

function authorized(req) {
  if (!TOKEN) return true;
  const h = String(req.headers.authorization || '');
  const got = h.replace(/^Bearer\s+/i, '');
  if (got.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  const base = path.basename(file);
  if (!file.startsWith(ROOT + path.sep) || base.startsWith('.') || base === 'server.js') {
    res.writeHead(404); res.end('not found'); return;
  }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const route = req.url.split('?')[0];
  if (route === '/api/chat' || route === '/api/scan') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
    if (!authorized(req)) return sendJson(res, 401, { error: '口令不对哦' });
    return readBody(req, 25 * 1024 * 1024, function (err, body) {
      if (err) return sendJson(res, 400, { error: err.message });
      if (route === '/api/chat') return handleChat(body, res);
      return handleScan(body, res);
    });
  }
  if (route === '/api/health') return sendJson(res, 200, { ok: true, model: MODEL });

  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, function () {
  console.log('🧊 囡囡的冰箱后端已启动: http://0.0.0.0:' + PORT);
  console.log('   模型: ' + MODEL + '（识别小票: ' + SCAN_MODEL + '）');
  console.log('   口令: ' + (TOKEN ? '已设置 ✓' : '未设置 ⚠️'));
});
