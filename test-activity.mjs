// activity 流水的自测：不需要 DSH，用假 ctx 喂事件
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachActivity } from './lib/activity.js';

const root = await mkdtemp(join(tmpdir(), 'pm-activity-'));
const ws = (name) => join(root, name);

async function makeWs(name, map) {
  const dir = ws(name);
  await mkdir(join(dir, '.projectmap'), { recursive: true });
  if (map) await writeFile(join(dir, '.projectmap', 'map.json'), JSON.stringify(map, null, 2), 'utf8');
  return dir;
}

const A = await makeWs('with-map', { schema: 1, title: 'A', nodes: [], edges: [] });
const B = await makeWs('no-map', null);
const C = await makeWs('disabled', { schema: 1, title: 'C', nodes: [], edges: [], settings: { enabled: false } });
const D = await makeWs('silent-turn', { schema: 1, title: 'D', nodes: [], edges: [] });

let handler = null;
const ctx = {
  on(_name, fn) { handler = fn; return () => { handler = null; }; },
  effect(fn) { fn(); },
};

const detach = attachActivity(ctx);
const emit = (sid, cwd, type, data) => handler({ id: sid, cwd }, { type, data });
const tick = () => new Promise((r) => setTimeout(r, 120));

// 有地图：一整轮（问 + 改文件 + 跑命令 + 结束）
emit('sA', A, 'user/message', { content: [{ type: 'text', text: '把拖拽那块的判定改一下' }] });
emit('sA', A, 'tool/call', { turn: 7, name: 'write', arguments: JSON.stringify({ path: 'D:/x/web/app.js', content: '' }) });
emit('sA', A, 'tool/call', { turn: 7, name: 'edit', arguments: JSON.stringify({ file_path: 'D:/x/web/app.css' }) });
emit('sA', A, 'tool/call', { turn: 7, name: 'pwsh', arguments: JSON.stringify({ command: 'git commit -m "fix: drag" --quiet' }) });
emit('sA', A, 'turn/end', { turn: 7, reason: 'complete' });
await tick();

// 没有地图：同一个回合
emit('sB', B, 'user/message', { content: '随便问问' });
emit('sB', B, 'tool/call', { turn: 1, name: 'write', arguments: JSON.stringify({ path: 'D:/y/a.js' }) });
emit('sB', B, 'turn/end', { turn: 1, reason: 'complete' });
await tick();

// 地图关掉：同一个回合
emit('sC', C, 'user/message', { content: '随便改改' });
emit('sC', C, 'tool/call', { turn: 1, name: 'write', arguments: JSON.stringify({ path: 'D:/z/a.js' }) });
emit('sC', C, 'turn/end', { turn: 1, reason: 'complete' });
await tick();

// 空回合：只有 turn/end，不该写
emit('sD', D, 'turn/end', { turn: 3, reason: 'complete' });
await tick();

// 坏 JSON 的 arguments 不该炸，也不该写空行
emit('sA', A, 'tool/call', { turn: 8, name: 'write', arguments: '{不是 json' });
emit('sA', A, 'turn/end', { turn: 8, reason: 'interrupted' });
await tick();

// 坏参数之后再跑一轮正常的：状态没被搞坏
emit('sA', A, 'tool/call', { turn: 9, name: 'read', arguments: JSON.stringify({ path: 'D:/x/README.md' }) });
emit('sA', A, 'tool/call', { turn: 9, name: 'write', arguments: JSON.stringify({ path: 'D:/x/web/app.js' }) });
emit('sA', A, 'turn/end', { turn: 9, reason: 'complete' });
await tick();

const out = {};
for (const [label, dir] of [['A', A], ['B', B], ['C', C], ['D', D]]) {
  try {
    out[label] = (await readFile(join(dir, '.projectmap', 'activity.ndjson'), 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    out[label] = [];
  }
}

detach();
await rm(root, { recursive: true, force: true });

const a = out.A.map((l) => JSON.parse(l));
const c = out.C.length;
const b = out.B.length;
const d = out.D.length;
const bad = out.A.length === 2 ? JSON.parse(out.A[1]) : null;

const checks = [
  ['A 记了两行（正常轮 + 坏参数之后那轮）', a.length === 2],
  ['A 第一轮有问句', (a[0]?.ask || '').includes('拖拽')],
  ['A 第一轮记了两个文件', (a[0]?.files || []).length === 2],
  ['A 第一轮记了命令', (a[0]?.cmds || [])[0]?.includes('git commit')],
  ['A 第一轮有 turn 号', a[0]?.turn === 7],
  ['A 坏参数那轮没写空行（只有 turn 9）', a[1]?.turn === 9],
  ['A 坏参数之后状态没坏（turn 9 正常落盘）', (a[1]?.files || [])[0]?.includes('app.js')],
  ['A 只读工具不进 files', !(a[1]?.files || []).some((f) => f.includes('README'))],
  ['B 没有地图 → 零写入', b === 0],
  ['C enabled=false → 零写入', c === 0],
  ['D 空回合 → 零写入', d === 0],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) ok = false;
}
console.log('\n样本:', JSON.stringify(a[0], null, 2));
process.exit(ok ? 0 : 1);
