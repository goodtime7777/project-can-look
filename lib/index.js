// dsh-projectmap —— 把项目地图挂到 DSH 自己的 web 服务上
//
// 和独立的 server.mjs 是同一套逻辑，区别是：
//   - 路由注册在 ctx.webServer 上（同源），不占端口、不起进程
//   - 页面在 /projectmap/ 下，前端用的是相对路径 api/...，所以不用改代码
//
// 依赖注入只有 webServer 一个服务。

import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile, rename, copyFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-projectmap';
export const inject = ['webServer'];

const HERE = dirname(fileURLToPath(import.meta.url));
const MOUNT = '/projectmap';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 页面资源在包根的 web/（本包自己带着，装到别处也一样）
function resolveWeb() {
  const candidates = [
    resolve(HERE, '..', 'web'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}

const WS_RE = /^[^\\/:*?"<>|]+$/;

// 页面右侧那颗浮动按钮。它只做一件事：调客户端模块暴露的 open()，
// 让 DSH 用一个侧边栏浏览器标签打开地图 —— 等价于用户点了聊天里的链接。
const BUTTON_JS = `(function () {
  if (window.__dshProjectMapButton) return;
  window.__dshProjectMapButton = true;

  function targetUrl() {
    var host = location.hostname;
    // sidebar browser 拒绝嵌入和应用同 origin 的地址，换个主机名写法绕开
    var alt = host === '127.0.0.1' ? 'localhost'
            : host === 'localhost' ? '127.0.0.1'
            : host;
    return location.protocol + '//' + alt + (location.port ? ':' + location.port : '') + '/projectmap/';
  }

  function mount() {
    if (document.getElementById('dsh-projectmap-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'dsh-projectmap-btn';
    btn.type = 'button';
    btn.title = '项目地图';
    btn.setAttribute('aria-label', '项目地图');
    btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">'
      + '<rect x="9" y="2" width="6" height="6" rx="2"/>'
      + '<rect x="2" y="16" width="6" height="6" rx="2"/>'
      + '<rect x="16" y="16" width="6" height="6" rx="2"/>'
      + '<path d="M12 8v4M12 12H5v4M12 12h7v4"/></svg>';

    btn.style.cssText = [
      'position:fixed', 'right:12px', 'top:50%', 'transform:translateY(-50%)',
      'width:34px', 'height:34px', 'padding:0',
      'display:flex', 'align-items:center', 'justify-content:center',
      'border-radius:10px', 'cursor:pointer', 'z-index:2147483000',
      'background:rgba(20,26,34,.92)', 'border:1px solid #2a3543',
      'color:#c9d5e3', 'box-shadow:0 6px 18px rgba(0,0,0,.35)',
      'transition:background .15s,border-color .15s,color .15s'
    ].join(';');

    btn.addEventListener('mouseenter', function () {
      btn.style.background = 'rgba(30,40,52,.97)';
      btn.style.borderColor = '#3d4d61';
      btn.style.color = '#e6ecf4';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = 'rgba(20,26,34,.92)';
      btn.style.borderColor = '#2a3543';
      btn.style.color = '#c9d5e3';
    });

    btn.addEventListener('click', function () {
      var url = targetUrl();
      if (window.__dshProjectMap) window.__dshProjectMap.open(url);
      else window.open(url, '_blank', 'noopener');
    });

    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
`;

export function apply(ctx, config = {}) {
  const WEB = resolveWeb();
  const ROOT = resolve(config.root || process.env.PROJECTMAP_ROOT || process.cwd());

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

  function sendJSON(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req, limit = 4 * 1024 * 1024) {
    return new Promise((ok, fail) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { fail(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
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
    try { await copyFile(file, join(dir, 'map.json.bak')); } catch { /* 第一次写 */ }
    const tmp = join(dir, 'map.json.tmp');
    await writeFile(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  }

  async function serveStatic(res, rel) {
    const file = resolve(WEB, rel);
    if (file !== WEB && !file.startsWith(WEB + sep)) { res.writeHead(403).end('forbidden'); return; }
    try {
      const buf = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  async function handler(req, res) {
    try {
      const pathname = new URL(req.url || '/', 'http://local').pathname;

      // 只会被匹配到 /projectmap 前缀，但别假设
      if (!pathname.startsWith(MOUNT)) {
        res.writeHead(404).end('not found');
        return;
      }

      // /projectmap → /projectmap/（不然页面里的相对路径会算到根上）
      if (pathname === MOUNT) {
        res.writeHead(302, { location: MOUNT + '/' });
        res.end();
        return;
      }

      const sub = pathname.slice(MOUNT.length) || '/';

      if (sub === '/' || sub === '/index.html') {
        return await serveStatic(res, 'index.html');
      }

      // 注入到 DSH 页面里的那颗浮动按钮
      if (sub === '/button.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(BUTTON_JS);
        return;
      }

      if (sub.startsWith('/api/workspaces')) {
        return sendJSON(res, 200, { workspaces: await listWorkspaces() });
      }

      if (sub.startsWith('/api/map/')) {
        const ws = decodeURIComponent(sub.slice('/api/map/'.length));
        if (!WS_RE.test(ws)) return sendJSON(res, 400, { error: 'bad workspace name' });

        if (req.method === 'POST') {
          let map;
          try {
            map = JSON.parse(await readBody(req));
          } catch (err) {
            return sendJSON(res, 400, { error: 'bad json: ' + String(err.message || err) });
          }
          const problem = validMap(map);
          if (problem) return sendJSON(res, 400, { error: problem });
          await writeMap(ws, map);
          return sendJSON(res, 200, { ok: true });
        }

        const r = await readMap(ws);
        if (!r.ok) return sendJSON(res, 404, { error: 'no map' });
        return sendJSON(res, 200, r.map);
      }

      // 其余当静态文件
      return await serveStatic(res, sub.replace(/^\/+/, ''));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('projectmap error: ' + String((err && err.message) || err));
    }
  }

  const disposers = [];
  disposers.push(ctx.webServer.register({ kind: 'prefix', path: MOUNT, handler }));

  // 往 DSH 页面注入浮动按钮（config.button === false 可关掉）
  if (config.button !== false && typeof ctx.webServer.tapIndex === 'function') {
    disposers.push(ctx.webServer.tapIndex((html) => {
      try {
        if (html.indexOf('/projectmap/button.js') !== -1) return html;
        const tag = '<script defer src="/projectmap/button.js"></script>';
        return html.indexOf('</body>') !== -1
          ? html.replace('</body>', tag + '</body>')
          : html + tag;
      } catch {
        return html;
      }
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d(); } catch { /* 已经关掉了 */ }
    }
  });
}
