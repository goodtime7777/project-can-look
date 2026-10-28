// 临时测试：不装进 DSH，直接用假 ctx 跑一遍路由
import { createServer } from 'node:http';
import { apply } from './lib/index.js';

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

// 索引注入：模拟服务端渲染 index.html
const html = '<html><body><div id="root"></div></body></html>';
const patched = taps.reduce((acc, fn) => fn(acc), html);
console.log('index tap:', patched.includes('/projectmap/button.js') ? 'injected' : 'MISSING');
console.log('tap idempotent:', taps.reduce((acc, fn) => fn(acc), patched) === patched ? 'yes' : 'NO');

const server = createServer((req, res) => route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const results = {};

let r = await fetch(base + '/projectmap', { redirect: 'manual' });
results.redirect = r.status + ' -> ' + r.headers.get('location');

r = await fetch(base + '/projectmap/');
results.index = r.status + ' ' + r.headers.get('content-type') + ' len=' + (await r.text()).length;

r = await fetch(base + '/projectmap/app.js');
results.appjs = r.status + ' len=' + (await r.text()).length;

r = await fetch(base + '/projectmap/button.js');
results.buttonjs = r.status + ' ' + r.headers.get('content-type') + ' len=' + (await r.text()).length;

r = await fetch(base + '/projectmap/api/workspaces');
const ws = await r.json();
results.workspaces = r.status + ' ' + (ws.workspaces || []).map((w) => w.ws).join(',');

r = await fetch(base + '/projectmap/api/map/projectcanlook');
const map = await r.json();
results.map = r.status + ' nodes=' + (map.nodes || []).length;

r = await fetch(base + '/projectmap/api/map/projectcanlook', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(map),
});
results.save = r.status + ' ' + JSON.stringify(await r.json());

r = await fetch(base + '/projectmap/api/map/..%5C..%5Cwindows');
results.badName = r.status;

r = await fetch(base + '/projectmap/%2e%2e%2f%2e%2e%2fserver.mjs');
results.traversal = r.status;

r = await fetch(base + '/projectmap/api/map/nope');
results.missing = r.status;

console.log(JSON.stringify(results, null, 2));
server.close();
