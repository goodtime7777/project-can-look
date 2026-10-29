// 插件路由自测：假 ctx + 真 http，不用装进 DSH
import { createServer } from 'node:http';
import { apply } from './lib/index.js';
import { TOKEN } from './lib/auth.js';

const routes = [];
const taps = [];
const ctx = {
  webServer: {
    register: (r) => { routes.push(r); return () => {}; },
    tapIndex: (fn) => { taps.push(fn); return () => {}; },
  },
  effect: (fn) => fn(),
};

apply(ctx, { root: 'D:\\herness' });
const route = routes[0];
console.log('route:', route.kind, route.path);

// 索引注入：按钮脚本
const html = '<html><head></head><body><div id="root"></div></body></html>';
const patched = taps.reduce((acc, fn) => fn(acc), html);
console.log('button tag:', patched.includes('/projectmap/button.js') ? 'injected' : 'MISSING');
console.log('tap idempotent:', taps.reduce((acc, fn) => fn(acc), patched) === patched ? 'yes' : 'NO');

const server = createServer((req, res) => route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const auth = { 'x-pm-token': TOKEN };
const results = {};

let r = await fetch(base + '/projectmap', { redirect: 'manual' });
results.redirect = r.status + ' -> ' + r.headers.get('location');

// 页面：必须带令牌 meta，且不需要令牌就能读
r = await fetch(base + '/projectmap/');
const page = await r.text();
results.index = r.status + ' len=' + page.length;
results.tokenInPage = page.includes('name="pm-token"') ? 'yes' : 'MISSING';

r = await fetch(base + '/projectmap/app.js');
results.appjs = r.status + ' len=' + (await r.text()).length;

r = await fetch(base + '/projectmap/button.js');
results.buttonjs = r.status + ' len=' + (await r.text()).length;

// 没有令牌：读也不给
r = await fetch(base + '/projectmap/api/workspaces');
results.noTokenGet = r.status;

// 没有令牌：写更不给
r = await fetch(base + '/projectmap/api/map/projectcanlook', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: JSON.stringify({ nodes: [], edges: [] }),
});
results.noTokenPost = r.status;

// 令牌错了也不行
r = await fetch(base + '/projectmap/api/workspaces', { headers: { 'x-pm-token': 'nope' } });
results.badToken = r.status;

// 带令牌：正常读
r = await fetch(base + '/projectmap/api/workspaces', { headers: auth });
const ws = await r.json();
results.workspaces = r.status + ' ' + (ws.workspaces || []).map((w) => w.ws).join(',');

r = await fetch(base + '/projectmap/api/pending/projectcanlook', { headers: auth });
const pend = await r.json();
results.pending = r.status + ' total=' + pend.total + ' pending=' + pend.pending;

r = await fetch(base + '/projectmap/api/map/projectcanlook', { headers: auth });
const map = await r.json();
results.map = r.status + ' nodes=' + (map.nodes || []).length;

// 带令牌：正常写回（内容不变）
r = await fetch(base + '/projectmap/api/map/projectcanlook', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(map),
});
results.save = r.status + ' ' + JSON.stringify(await r.json());

r = await fetch(base + '/projectmap/api/map/..%5C..%5Cwindows', { headers: auth });
results.badName = r.status;

r = await fetch(base + '/projectmap/%2e%2e%2f%2e%2e%2fserver.mjs');
results.traversal = r.status;

r = await fetch(base + '/projectmap/api/map/nope', { headers: auth });
results.missing = r.status;

console.log(JSON.stringify(results, null, 2));

const checks = [
  ['页面里注入了令牌', results.tokenInPage === 'yes'],
  ['无令牌读 → 403', results.noTokenGet === 403],
  ['无令牌写 → 403', results.noTokenPost === 403],
  ['错令牌 → 403', results.badToken === 403],
  ['带令牌能读', results.workspaces.startsWith('200')],
  ['带令牌能写', results.save.startsWith('200')],
  ['越权工作区名被拒', results.badName === 400],
  ['目录穿越被拒', results.traversal === 404],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) ok = false;
}
server.close();
process.exit(ok ? 0 : 1);
