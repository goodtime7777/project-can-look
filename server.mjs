// ProjectMap · 零依赖本地服务
// 扫一个目录下的 <工作区>/.projectmap/map.json，汇总成索引给前端用。
// 用法：node server.mjs  →  http://127.0.0.1:8377
// 根目录：PROJECTMAP_ROOT 环境变量，不设就用本程序所在目录的上一层。

import { createServer } from 'node:http';
import { readFile, readdir, stat, writeFile, rename, copyFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, sep, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pendingStats } from './lib/store.js';

// 用脚本自己的位置定位 web/ 和默认根目录，不依赖启动时的工作目录
// （从 WMI / 计划任务 / 启动项拉起时 cwd 不是项目目录）
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, 'web');
const ROOT = process.env.PROJECTMAP_ROOT
  ? resolve(process.env.PROJECTMAP_ROOT)
  : resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8377);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 工作区名只允许普通目录名，挡掉路径穿越
const WS_RE = /^[^\\/:*?"<>|]+$/;

async function readMap(ws) {
  const file = join(ROOT, ws, '.projectmap', 'map.json');
  try {
    const raw = await readFile(file, 'utf8');
    const map = JSON.parse(raw);
    const st = await stat(file);
    return { ok: true, map, mtime: st.mtimeMs };
  } catch {
    return { ok: false };
  }
}

async function listWorkspaces() {
  const out = [];
  let dirs = [];
  try {
    dirs = await readdir(ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const r = await readMap(d.name);
    if (!r.ok) continue;
    out.push({
      ws: d.name,
      title: r.map.title || d.name,
      nodes: Array.isArray(r.map.nodes) ? r.map.nodes.length : 0,
      edges: Array.isArray(r.map.edges) ? r.map.edges.length : 0,
      updatedAt: new Date(r.mtime).toISOString(),
      draft: !!r.map.draft,
    });
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

// 允许被 iframe 里加载（DSH 右侧边栏的浏览器标签是 sandbox iframe，
// 它的 origin 是 "null"，没有这个头 fetch 会被 CORS 拦掉）。
// 只监听 127.0.0.1，不做凭证，用 * 是安全的。
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
  });
  res.end(text);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        rejectBody(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

function validMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 'not an object';
  if (!Array.isArray(map.nodes)) return 'nodes must be an array';
  if (map.edges !== undefined && !Array.isArray(map.edges)) return 'edges must be an array';
  const ids = new Set();
  for (const n of map.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) return 'every node needs a string id';
    if (ids.has(n.id)) return `duplicate node id: ${n.id}`;
    ids.add(n.id);
  }
  for (const n of map.nodes) {
    if (n.parent && !ids.has(n.parent)) return `node ${n.id} points at missing parent ${n.parent}`;
  }
  return null;
}

async function writeMap(ws, map) {
  const dir = join(ROOT, ws, '.projectmap');
  const file = join(dir, 'map.json');
  await mkdir(dir, { recursive: true });
  try {
    await copyFile(file, join(dir, 'map.json.bak'));
  } catch {
    /* 第一次写，没有旧文件 */
  }
  const tmp = join(dir, 'map.json.tmp');
  await writeFile(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = resolve(WEB, normalize(rel));
  if (file !== WEB && !file.startsWith(WEB + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...CORS,
    });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (p === '/api/workspaces') {
      return json(res, 200, { workspaces: await listWorkspaces() });
    }

    // 落后多少条：流水里还没被节点 from 认领的条数
    if (p.startsWith('/api/pending/')) {
      const ws = decodeURIComponent(p.slice('/api/pending/'.length));
      if (!WS_RE.test(ws)) return json(res, 400, { error: 'bad workspace name' });
      return json(res, 200, await pendingStats(join(ROOT, ws)));
    }

    if (p.startsWith('/api/map/')) {
      const ws = decodeURIComponent(p.slice('/api/map/'.length));
      if (!WS_RE.test(ws)) return json(res, 400, { error: 'bad workspace name' });

      if (req.method === 'POST') {
        let map;
        try {
          map = JSON.parse(await readBody(req));
        } catch (err) {
          return json(res, 400, { error: 'bad json: ' + String(err.message || err) });
        }
        const problem = validMap(map);
        if (problem) return json(res, 400, { error: problem });
        await writeMap(ws, map);
        return json(res, 200, { ok: true });
      }

      const r = await readMap(ws);
      if (!r.ok) return json(res, 404, { error: 'no map' });
      return json(res, 200, r.map);
    }

    if (p === '/api/ping') return json(res, 200, { ok: true, root: ROOT });

    return await serveStatic(res, p);
  } catch (err) {
    json(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ProjectMap  →  http://127.0.0.1:${PORT}`);
  console.log(`扫描根目录  →  ${ROOT}`);
});
