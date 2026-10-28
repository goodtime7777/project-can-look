// ProjectMap 前端 —— 零依赖，手写 SVG 画布
// 树从左往右长：列 = 层级，行 = 同层的兄弟。

const NS = 'http://www.w3.org/2000/svg';
const NODE_W = 220;
const NODE_H = 96;
const COL_GAP = 78;   // 层与层之间
const ROW_GAP = 22;   // 兄弟之间

const STATUS = {
  idea:    { label: '想法',   color: '#8b93a1' },
  doing:   { label: '进行中', color: '#3b82f6' },
  blocked: { label: '卡住',   color: '#ef4444' },
  done:    { label: '完成',   color: '#22c55e' },
  dropped: { label: '放弃',   color: '#4b5563' },
};

const KIND = {
  idea:    { label: '思路', color: '#a78bfa' },
  frame:   { label: '框架', color: '#38bdf8' },
  content: { label: '内容', color: '#fbbf24' },
  ui:      { label: '界面', color: '#f472b6' },
  fix:     { label: '修复', color: '#2dd4bf' },
  other:   { label: '其他', color: '#94a3b8' },
};

const EDGE = {
  merge: { label: '合成', color: '#c084fc', hint: '取两边的长处拼起来' },
  ref:   { label: '参考', color: '#64748b', hint: '做这个时先看那个' },
  dep:   { label: '依赖', color: '#f59e0b', hint: '那个没完，这个不动' },
  flow:  { label: '次序', color: '#3b82f6', hint: '只是先后的记录' },
};

const POLICY = {
  ask:  '画完先记着，等我问',
  plan: '先出方案，你点头再做',
  auto: '直接开工',
};

const S = {
  index: [],
  map: null,
  ws: null,
  pos: new Map(),
  pinned: new Map(),
  view: { x: 0, y: 0, k: 1 },
  filter: 'all',
  query: '',
  sel: null,
  drag: null,
  link: null,
  moved: false,
  dirty: false,
  saving: false,
  pendingSave: false,
  saveTimer: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const world = $('world');
const svg = $('svg');
const nodesLayer = $('nodes');
const railList = $('railList');
const edgeMenu = $('edgeMenu');

/* ---------------- 小工具 ---------------- */

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function bezierMid(a, b, c, d) {
  const t = 0.5, u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

function nid() {
  return 'n' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
}

const byId = (id) => (S.map?.nodes || []).find((n) => n.id === id);
const kidsOf = (id) => (S.map?.nodes || []).filter((n) => n.parent === id);

function descendantsOf(id) {
  const out = new Set();
  const walk = (pid) => {
    for (const c of kidsOf(pid)) { out.add(c.id); walk(c.id); }
  };
  walk(id);
  return out;
}

function statusOf(n) { return STATUS[n.status] || STATUS.idea; }
function kindOf(n) { return KIND[n.kind] || KIND.other; }

/* ---------------- 布局：从左往右 ---------------- */

function computeLayout(map) {
  const mapById = new Map(map.nodes.map((n) => [n.id, n]));
  const kids = new Map();
  const roots = [];
  for (const n of map.nodes) {
    if (n.parent && mapById.has(n.parent) && n.parent !== n.id) {
      if (!kids.has(n.parent)) kids.set(n.parent, []);
      kids.get(n.parent).push(n);
    } else {
      roots.push(n);
    }
  }

  const height = new Map();

  function measure(n) {
    const c = kids.get(n.id) || [];
    if (!c.length) { height.set(n.id, NODE_H); return NODE_H; }
    let sum = 0;
    c.forEach((k, i) => { sum += measure(k) + (i ? ROW_GAP : 0); });
    const total = Math.max(NODE_H, sum);
    height.set(n.id, total);
    return total;
  }

  const pos = new Map();

  function place(n, depth, y) {
    const h = height.get(n.id);
    const c = kids.get(n.id) || [];
    const x = depth * (NODE_W + COL_GAP);
    if (!c.length) {
      pos.set(n.id, { x, y: y + (h - NODE_H) / 2 });
      return;
    }
    let cy = y;
    const centers = [];
    for (const k of c) {
      const kh = height.get(k.id);
      place(k, depth + 1, cy);
      centers.push(pos.get(k.id).y + NODE_H / 2);
      cy += kh + ROW_GAP;
    }
    const mid = (centers[0] + centers[centers.length - 1]) / 2;
    pos.set(n.id, { x, y: mid - NODE_H / 2 });
  }

  let y = 0;
  for (const r of roots) {
    measure(r);
    place(r, 0, y);
    y += height.get(r.id) + ROW_GAP * 2;
  }

  for (const [id, p] of S.pinned) {
    if (pos.has(id)) pos.set(id, { x: p.x, y: p.y });
  }
  return pos;
}

/* ---------------- 渲染 ---------------- */

function render() {
  const map = S.map;
  if (!map) return;

  S.pos = computeLayout(map);
  const mapById = new Map(map.nodes.map((n) => [n.id, n]));

  let maxX = 0, maxY = 0;
  for (const p of S.pos.values()) {
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + NODE_H);
  }
  svg.setAttribute('width', maxX + 400);
  svg.setAttribute('height', maxY + 400);
  svg.textContent = '';

  const defs = svgEl('defs');
  for (const [type, meta] of Object.entries(EDGE)) {
    const m = svgEl('marker', {
      id: `arrow-${type}`, viewBox: '0 0 8 8', refX: '7', refY: '4',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    });
    m.appendChild(svgEl('path', { d: 'M0,0 L8,4 L0,8 z', fill: meta.color, opacity: '.9' }));
    defs.appendChild(m);
  }
  svg.appendChild(defs);

  // 树干：父 → 子，左出右进
  for (const n of map.nodes) {
    if (!n.parent || !mapById.has(n.parent)) continue;
    const a = S.pos.get(n.parent), b = S.pos.get(n.id);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y + NODE_H / 2;
    const dx = Math.max(30, (x2 - x1) * 0.5);
    svg.appendChild(svgEl('path', {
      class: 'tree-edge',
      d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
    }));
  }

  // 关系线
  for (const e of map.edges || []) {
    const a = S.pos.get(e.from), b = S.pos.get(e.to);
    if (!a || !b) continue;
    const type = EDGE[e.type] ? e.type : 'ref';
    const acx = a.x + NODE_W / 2, acy = a.y + NODE_H / 2;
    const bcx = b.x + NODE_W / 2, bcy = b.y + NODE_H / 2;
    const sameCol = Math.abs(acx - bcx) < NODE_W * 0.55;

    let ax, ay, bx, by, c1x, c1y, c2x, c2y;
    if (sameCol) {
      // 同列兄弟：从右侧绕出去再绕回来，画成一个括号，别贴着挤
      const BULGE = 46;
      ax = a.x + NODE_W; ay = acy;
      bx = b.x + NODE_W; by = bcy;
      const rx = Math.max(ax, bx) + BULGE;
      c1x = rx; c1y = ay;
      c2x = rx; c2y = by;
    } else {
      // 不同列：横着连
      const right = bcx >= acx;
      ax = right ? a.x + NODE_W : a.x;
      bx = right ? b.x : b.x + NODE_W;
      ay = acy; by = bcy;
      const off = Math.max(50, Math.abs(bx - ax) * 0.42);
      c1x = ax + (right ? off : -off); c1y = ay;
      c2x = bx + (right ? -off : off); c2y = by;
    }

    svg.appendChild(svgEl('path', {
      class: `rel-edge ${type}${e.status === 'pending' ? ' pending' : ''}`,
      d: `M${ax},${ay} C${c1x},${c1y} ${c2x},${c2y} ${bx},${by}`,
      'marker-end': `url(#arrow-${type})`,
    }));

    const mid = bezierMid({ x: ax, y: ay }, { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x: bx, y: by });
    const text = e.status === 'pending' ? `${EDGE[type].label} · 待办` : EDGE[type].label;
    const w = text.length * 11 + 16;
    // 同列兄弟的线是往右鼓的括号，标签跟着放在括号外侧，别压住框
    const lx = sameCol ? Math.max(ax, bx) + 46 + 10 + w / 2 : mid.x;
    const ly = sameCol ? (ay + by) / 2 : mid.y;
    const g = svgEl('g', { opacity: '.95' });
    g.appendChild(svgEl('rect', {
      class: `elabel-bg ${type}`, x: lx - w / 2, y: ly - 9, width: w, height: 18, rx: 9,
    }));
    const t = svgEl('text', { class: `elabel-tx ${type}`, x: lx, y: ly + 0.5 });
    t.textContent = text;
    g.appendChild(t);
    svg.appendChild(g);
  }

  // 节点
  nodesLayer.textContent = '';
  for (const n of map.nodes) {
    const p = S.pos.get(n.id);
    if (!p) continue;
    nodesLayer.appendChild(buildNodeEl(n, p));
  }

  applyDim();
  updateMeta();
  applyLod();
}

function buildNodeEl(n, p) {
  const st = statusOf(n);
  const kd = kindOf(n);

  const el = document.createElement('div');
  el.className = `node s-${n.status || 'idea'} k-${n.kind || 'other'}`;
  if (S.sel === n.id) el.classList.add('sel');
  el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  el.dataset.id = n.id;

  const head = document.createElement('div');
  head.className = 'node-head';
  const dot = document.createElement('i');
  dot.className = 'dot';
  const title = document.createElement('div');
  title.className = 'node-title';
  title.textContent = n.title || '(未命名)';
  head.appendChild(dot);
  head.appendChild(title);

  const note = document.createElement('div');
  note.className = 'node-note';
  note.textContent = n.note || '';

  const foot = document.createElement('div');
  foot.className = 'node-foot';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = kd.label;
  const sTxt = document.createElement('span');
  sTxt.className = 'stxt';
  sTxt.textContent = st.label;
  foot.appendChild(kind);
  foot.appendChild(sTxt);
  if (n.refs && n.refs.length) {
    const rc = document.createElement('span');
    rc.className = 'refcount';
    rc.textContent = `↗${n.refs.length}`;
    foot.appendChild(rc);
  }

  const handle = document.createElement('span');
  handle.className = 'handle';
  handle.dataset.handle = '1';
  handle.title = '拖到我身上连线';

  el.appendChild(head);
  el.appendChild(note);
  el.appendChild(foot);
  el.appendChild(handle);
  return el;
}

function patchNode(id) {
  const n = byId(id);
  const el = nodesLayer.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (!n || !el) return;
  const p = S.pos.get(id);
  const fresh = buildNodeEl(n, p || { x: 0, y: 0 });
  fresh.style.transform = el.style.transform;
  el.replaceWith(fresh);
  applyDim();
  updateMeta();
}

function updateMeta() {
  const map = S.map;
  if (!map) return;
  const counts = {};
  for (const n of map.nodes) counts[n.status] = (counts[n.status] || 0) + 1;
  const parts = [`${map.nodes.length} 个框`, `${(map.edges || []).length} 条线`];
  for (const [k, v] of Object.entries(counts)) {
    if (STATUS[k]) parts.push(`${STATUS[k].label} ${v}`);
  }
  $('wsTitle').textContent = map.title || S.ws;
  $('wsMeta').textContent = `${S.ws}  ·  ${parts.join('  ·  ')}`;
}

function applyDim() {
  const q = S.query.trim().toLowerCase();
  for (const el of nodesLayer.children) {
    const n = byId(el.dataset.id);
    if (!n) continue;
    let ok = true;
    if (S.filter !== 'all' && n.status !== S.filter) ok = false;
    if (ok && q) {
      const hay = `${n.title || ''} ${n.note || ''}`.toLowerCase();
      if (!hay.includes(q)) ok = false;
    }
    el.classList.toggle('dim', !ok);
  }
}

function applyLod() {
  const k = S.view.k;
  world.classList.toggle('lod-far', k < 0.42);
  $('zoomtag').textContent = `${Math.round(k * 100)}%`;
}

function applyView() {
  world.style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.k})`;
  applyLod();
}

/* ---------------- 视图 ---------------- */

function bounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of S.pos.values()) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
  }
  return { minX, minY, maxX, maxY };
}

function fitAll() {
  if (!S.map) return;
  S.pos = computeLayout(S.map);
  const { minX, minY, maxX, maxY } = bounds();
  if (!isFinite(minX)) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const w = maxX - minX, h = maxY - minY;
  const k = clamp(Math.min((cw - 90) / w, (ch - 90) / h), 0.16, 1.1);
  S.view.k = k;
  S.view.x = (cw - w * k) / 2 - minX * k;
  S.view.y = Math.max(40, (ch - h * k) / 2 - minY * k);
  applyView();
}

// 默认停在能读字的倍率，从根节点开始往右看；想缩还是能缩
function focusReadable() {
  if (!S.map) return;
  S.pos = computeLayout(S.map);
  const roots = S.map.nodes.filter((n) => !n.parent || !byId(n.parent));
  const root = roots[0];
  const p = root ? S.pos.get(root.id) : { x: 0, y: 0 };
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;

  // 塞在侧边栏里（窄）时，缩到"父框 + 一层子框"刚好放得下，不然只能看到半截
  const k = cw < 640 ? clamp((cw - 34) / (NODE_W * 2 + COL_GAP), 0.45, 0.92) : 0.92;

  S.view.k = k;
  S.view.x = cw < 640 ? 16 : 56;
  S.view.y = ch / 2 - (p.y + NODE_H / 2) * k;
  applyView();
}

function worldPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - S.view.x) / S.view.k,
    y: (clientY - rect.top - S.view.y) / S.view.k,
  };
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const k2 = clamp(S.view.k * Math.exp(-e.deltaY * 0.0014), 0.12, 2.4);
  const wx = (mx - S.view.x) / S.view.k;
  const wy = (my - S.view.y) / S.view.k;
  S.view.x = mx - wx * k2;
  S.view.y = my - wy * k2;
  S.view.k = k2;
  applyView();
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  S.moved = false;

  if (e.target.closest('.handle')) {
    const nodeEl = e.target.closest('.node');
    startLink(nodeEl.dataset.id, e);
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const nodeEl = e.target.closest('.node');
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    const p = S.pos.get(id);
    if (!p) return;
    const wp = worldPoint(e.clientX, e.clientY);
    // 按下先不选中：真拖起来的时候弹面板会挡住视线，等松手没动再开
    S.drag = { kind: 'node', id, dx: wp.x - p.x, dy: wp.y - p.y, moved: false };
    nodeEl.classList.add('dragging');
  } else {
    S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y };
    canvas.classList.add('panning');
  }
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (S.link) {
    const wp = worldPoint(e.clientX, e.clientY);
    S.link.wx = wp.x; S.link.wy = wp.y;
    drawTempLink();
    return;
  }
  if (!S.drag) return;

  if (S.drag.kind === 'pan') {
    const dx = e.clientX - S.drag.sx, dy = e.clientY - S.drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) S.moved = true;
    S.view.x = S.drag.vx + dx;
    S.view.y = S.drag.vy + dy;
    applyView();
    return;
  }

  if (!S.drag.moved) {
    S.drag.moved = true;
    // 一开始拖就把编辑面板收起来，否则窄屏下整块画布都被盖住
    if (!$('detail').hidden) closeDetail();
  }
  S.moved = true;
  const wp = worldPoint(e.clientX, e.clientY);
  S.pinned.set(S.drag.id, { x: wp.x - S.drag.dx, y: wp.y - S.drag.dy });
  render();
  const el = nodesLayer.querySelector(`.node[data-id="${CSS.escape(S.drag.id)}"]`);
  if (el) el.classList.add('dragging');
});

window.addEventListener('pointerup', (e) => {
  if (S.link) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = target && target.closest && target.closest('.node');
    const from = S.link.from;
    endLink();
    if (nodeEl && nodeEl.dataset.id !== from) {
      openEdgeMenu(from, nodeEl.dataset.id, e.clientX, e.clientY);
    }
    return;
  }

  if (!S.drag) return;
  if (S.drag.kind === 'pan') canvas.classList.remove('panning');
  else {
    const el = nodesLayer.querySelector('.node.dragging');
    if (el) el.classList.remove('dragging');
    // 没挪动 = 就是点了一下，这里才打开面板
    if (!S.drag.moved) selectNode(S.drag.id);
  }
  S.drag = null;
});

canvas.addEventListener('click', (e) => {
  if (e.target.closest('.node')) return;
  if (S.moved) { S.moved = false; return; }
  closeDetail();
});

canvas.addEventListener('dblclick', (e) => {
  if (e.target.closest('.node')) return;
  const parent = S.sel;
  const node = createChild(parent);
  if (node) {
    render();
    selectNode(node.id);
    const t = $('dTitle');
    t.focus();
    t.select();
  }
});

/* ---------------- 连线 ---------------- */

function startLink(fromId, e) {
  const p = S.pos.get(fromId);
  if (!p) return;
  const wp = worldPoint(e.clientX, e.clientY);
  S.link = { from: fromId, wx: wp.x, wy: wp.y, x1: p.x + NODE_W, y1: p.y + NODE_H / 2 };
  canvas.classList.add('linking');
  S.linkPath = svgEl('path', { class: 'link-temp' });
  svg.appendChild(S.linkPath);
  drawTempLink();
}

function drawTempLink() {
  if (!S.link || !S.linkPath) return;
  const { x1, y1, wx, wy } = S.link;
  const dx = Math.max(30, Math.abs(wx - x1) * 0.4);
  S.linkPath.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${wx - dx},${wy} ${wx},${wy}`);
}

function endLink() {
  if (S.linkPath) S.linkPath.remove();
  S.linkPath = null;
  S.link = null;
  canvas.classList.remove('linking');
}

function openEdgeMenu(fromId, toId, clientX, clientY) {
  const a = byId(fromId), b = byId(toId);
  if (!a || !b) return;

  edgeMenu.hidden = false;
  $('emTitle').textContent = `「${a.title}」→「${b.title}」`;
  const body = $('emBody');
  body.textContent = '';

  for (const [type, meta] of Object.entries(EDGE)) {
    const btn = document.createElement('button');
    btn.className = 'em-opt';
    btn.innerHTML = `<i class="em-dot" style="background:${meta.color}"></i>
      <span>${meta.label}</span><span class="em-sub">${meta.hint}</span>`;
    btn.addEventListener('click', () => {
      if (type === 'merge') showMergeForm(fromId, toId);
      else {
        addEdge({ from: fromId, to: toId, type, status: 'pending' });
        closeEdgeMenu();
        render();
      }
    });
    body.appendChild(btn);
  }

  const pos = menuPos(clientX, clientY);
  edgeMenu.style.left = pos.x + 'px';
  edgeMenu.style.top = pos.y + 'px';
}

function showMergeForm(fromId, toId) {
  const a = byId(fromId), b = byId(toId);
  $('emTitle').textContent = '合成：各取什么？';
  const body = $('emBody');
  body.textContent = '';

  const form = document.createElement('div');
  form.className = 'em-form';
  form.innerHTML = `
    <div><label>从「${esc(a.title)}」取</label><input id="mfA" placeholder="框架、交互逻辑…"></div>
    <div><label>从「${esc(b.title)}」取</label><input id="mfB" placeholder="视觉风格、配色…"></div>
    <div><label>要做出什么</label><input id="mfP" placeholder="给产物起个名，可以留空"></div>
    <div><label>画完怎么处理</label>
      <select id="mfPol">
        <option value="ask">先记着，等我问</option>
        <option value="plan">先出方案，我点头再做</option>
        <option value="auto">直接开工</option>
      </select>
    </div>
    <div class="em-actions">
      <button class="btn small" id="mfCancel">取消</button>
      <button class="btn small" id="mfOk">建立这条线</button>
    </div>`;
  body.appendChild(form);

  $('mfA').focus();
  $('mfCancel').addEventListener('click', closeEdgeMenu);
  $('mfOk').addEventListener('click', () => {
    const split = (s) => s.split(/[、,，\/]/).map((x) => x.trim()).filter(Boolean);
    const takeA = split($('mfA').value);
    const takeB = split($('mfB').value);
    const take = {};
    if (takeA.length) take[fromId] = takeA;
    if (takeB.length) take[toId] = takeB;
    addEdge({
      from: fromId, to: toId, type: 'merge', status: 'pending',
      policy: $('mfPol').value,
      recipe: { take, product: $('mfP').value.trim() || '', words: '' },
    });
    closeEdgeMenu();
    render();
    selectNode(toId);
  });
}

function menuPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clamp(clientX - rect.left + 8, 8, canvas.clientWidth - 258);
  const y = clamp(clientY - rect.top + 8, 8, canvas.clientHeight - 240);
  return { x, y };
}

function closeEdgeMenu() {
  edgeMenu.hidden = true;
}

document.addEventListener('pointerdown', (e) => {
  if (!edgeMenu.hidden && !e.target.closest('#edgeMenu')) closeEdgeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeEdgeMenu(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    clearTimeout(S.saveTimer);
    saveNow();
  }
});

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 改数据 ---------------- */

function touch() {
  S.dirty = true;
  setSavePill('dirty');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 700);
}

function setSavePill(state) {
  const el = $('savePill');
  const text = { saved: '已保存', dirty: '未保存', saving: '保存中', error: '保存失败' }[state] || '';
  el.dataset.state = state;
  el.textContent = text;
}

async function saveNow() {
  if (!S.map || !S.ws) return;
  if (S.saving) { S.pendingSave = true; return; }
  S.saving = true;
  setSavePill('saving');
  try {
    const r = await fetch('api/map/' + encodeURIComponent(S.ws), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(S.map),
    });
    if (!r.ok) throw new Error(await r.text());
    S.dirty = false;
    setSavePill('saved');
    syncRailCounts();
  } catch (err) {
    console.error(err);
    setSavePill('error');
  } finally {
    S.saving = false;
    if (S.pendingSave) { S.pendingSave = false; saveNow(); }
  }
}

function syncRailCounts() {
  const item = S.index.find((i) => i.ws === S.ws);
  if (!item) return;
  item.nodes = S.map.nodes.length;
  item.edges = (S.map.edges || []).length;
  item.updatedAt = new Date().toISOString();
  const el = [...railList.children].find((c) => c.querySelector('.ws-sub')?.textContent.startsWith(S.ws));
  if (el) el.querySelector('.ws-sub').textContent = `${S.ws} · ${item.nodes} 框 / ${item.edges} 线`;
}

function addEdge(edge) {
  if (!S.map.edges) S.map.edges = [];
  S.map.edges.push({ id: nid(), status: 'pending', ...edge });
  touch();
}

function removeEdge(id) {
  S.map.edges = (S.map.edges || []).filter((e) => e.id !== id);
  touch();
}

function addNode({ parent = null, title = '新框', kind = 'other', status = 'idea' } = {}) {
  const node = {
    id: nid(), parent, title, kind, status, note: '',
    refs: [], createdAt: new Date().toISOString(),
  };
  S.map.nodes.push(node);
  touch();
  return node;
}

function createChild(parentId) {
  return addNode({ parent: parentId || null });
}

function removeNode(id) {
  const node = byId(id);
  if (!node) return;
  for (const c of kidsOf(id)) c.parent = node.parent;
  S.map.nodes = S.map.nodes.filter((n) => n.id !== id);
  S.map.edges = (S.map.edges || []).filter((e) => e.from !== id && e.to !== id);
  S.pinned.delete(id);
  touch();
}

function setParent(id, parentId) {
  const n = byId(id);
  if (!n) return;
  if (parentId && (parentId === id || descendantsOf(id).has(parentId))) return;
  n.parent = parentId || null;
  touch();
}

/* ---------------- 详情面板 ---------------- */

let detailSeq = 0;

function selectNode(id) {
  S.sel = id;
  for (const el of nodesLayer.children) el.classList.toggle('sel', el.dataset.id === id);
  fillDetail(id);
}

function closeDetail() {
  S.sel = null;
  $('detail').hidden = true;
  for (const el of nodesLayer.children) el.classList.remove('sel');
}

function fillDetail(id) {
  const n = byId(id);
  if (!n) { closeDetail(); return; }
  const seq = ++detailSeq;
  $('detail').hidden = false;

  const st = statusOf(n), kd = kindOf(n);
  const dk = $('dKind');
  dk.textContent = kd.label;
  dk.style.setProperty('--accent', kd.color);

  $('dTitle').value = n.title || '';
  $('dNote').value = n.note || '';

  // 状态
  const stBox = $('dStatuses');
  stBox.textContent = '';
  for (const [key, meta] of Object.entries(STATUS)) {
    const b = document.createElement('button');
    b.className = 'st-btn' + (n.status === key ? ' on' : '');
    b.style.setProperty('--c', meta.color);
    b.innerHTML = `<i></i>${meta.label}`;
    b.addEventListener('click', () => {
      n.status = key;
      touch();
      render();
      fillDetail(id);
    });
    stBox.appendChild(b);
  }

  // 类型
  const kdBox = $('dKinds');
  kdBox.textContent = '';
  for (const [key, meta] of Object.entries(KIND)) {
    const b = document.createElement('button');
    b.className = 'kd-btn' + (n.kind === key ? ' on' : '');
    b.style.setProperty('--accent', meta.color);
    b.textContent = meta.label;
    b.addEventListener('click', () => {
      n.kind = key;
      touch();
      render();
      fillDetail(id);
    });
    kdBox.appendChild(b);
  }

  // 父节点
  const sel = $('dParent');
  sel.textContent = '';
  const banned = descendantsOf(id);
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '（顶层，自成一根）';
  sel.appendChild(opt0);
  for (const other of S.map.nodes) {
    if (other.id === id || banned.has(other.id)) continue;
    const o = document.createElement('option');
    o.value = other.id;
    o.textContent = other.title || '(未命名)';
    sel.appendChild(o);
  }
  sel.value = n.parent || '';

  // 关联
  const refsBox = $('dRefs');
  refsBox.textContent = '';
  const refs = n.refs || [];
  if (!refs.length) {
    const e = document.createElement('div');
    e.className = 'd-ref-empty';
    e.textContent = '还没有';
    refsBox.appendChild(e);
  }
  refs.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'd-ref';
    const tag = document.createElement('span');
    tag.className = 'rtype';
    tag.textContent = r.type === 'url' ? '链接' : r.type === 'session' ? '会话' : '文件';
    row.appendChild(tag);
    row.appendChild(document.createTextNode(r.label || r.value || ''));
    const x = document.createElement('button');
    x.className = 'rx';
    x.textContent = '×';
    x.addEventListener('click', () => {
      refs.splice(i, 1);
      touch();
      render();
      fillDetail(id);
    });
    row.appendChild(x);
    refsBox.appendChild(row);
  });

  // 下一层
  const kids = kidsOf(id);
  $('dChildSec').hidden = kids.length === 0;
  const childBox = $('dChild');
  childBox.textContent = '';
  for (const c of kids) {
    const row = document.createElement('div');
    row.className = 'd-ref';
    const cs = statusOf(c);
    const tag = document.createElement('span');
    tag.className = 'rtype';
    tag.style.color = cs.color;
    tag.textContent = '●';
    row.appendChild(tag);
    row.appendChild(document.createTextNode(c.title || '(未命名)'));
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => selectNode(c.id));
    childBox.appendChild(row);
  }

  // 线
  const ins = (S.map.edges || []).filter((e) => e.to === id);
  const outs = (S.map.edges || []).filter((e) => e.from === id);
  $('dEdgesSec').hidden = ins.length + outs.length === 0;
  const edgeBox = $('dEdges');
  edgeBox.textContent = '';
  const mkRow = (e, dir) => {
    const other = byId(dir === 'in' ? e.from : e.to);
    const type = EDGE[e.type] ? e.type : 'ref';
    const row = document.createElement('div');
    row.className = 'erow';
    row.innerHTML = `<span class="etag ${type}">${EDGE[type].label}</span>
      <span class="ewho">${dir === 'in' ? '← ' : '→ '}${esc(other ? other.title : '?')}${e.status === 'pending' ? ' · 待办' : ''}</span>`;
    const x = document.createElement('button');
    x.className = 'rx';
    x.textContent = '×';
    x.addEventListener('click', () => {
      removeEdge(e.id);
      render();
      fillDetail(id);
    });
    row.appendChild(x);
    edgeBox.appendChild(row);
  };
  for (const e of outs) mkRow(e, 'out');
  for (const e of ins) mkRow(e, 'in');

  $('dId').textContent = id;
  // 防止异步回填时已经切到别的框
  if (seq !== detailSeq) return;
}

$('dTitle').addEventListener('input', (e) => {
  const n = byId(S.sel);
  if (!n) return;
  n.title = e.target.value;
  patchNode(n.id);
  touch();
});

$('dNote').addEventListener('input', (e) => {
  const n = byId(S.sel);
  if (!n) return;
  n.note = e.target.value;
  patchNode(n.id);
  touch();
});

$('dParent').addEventListener('change', (e) => {
  const n = byId(S.sel);
  if (!n) return;
  setParent(n.id, e.target.value || null);
  render();
  fillDetail(n.id);
});

$('dAddChild').addEventListener('click', () => {
  const n = byId(S.sel);
  if (!n) return;
  const child = addNode({ parent: n.id, title: '新框' });
  render();
  selectNode(child.id);
  $('dTitle').focus();
  $('dTitle').select();
});

$('dDelete').addEventListener('click', () => {
  const n = byId(S.sel);
  if (!n) return;
  const kids = kidsOf(n.id).length;
  const msg = kids
    ? `删掉「${n.title}」？它下面 ${kids} 个框会挂到上一层。`
    : `删掉「${n.title}」？`;
  if (!confirm(msg)) return;
  removeNode(n.id);
  closeDetail();
  render();
});

$('dRefInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = byId(S.sel);
  const v = e.target.value.trim();
  if (!n || !v) return;
  const type = /^https?:\/\//i.test(v) ? 'url' : 'file';
  n.refs = n.refs || [];
  n.refs.push({ type, value: v, label: v.split(/[\\/]/).pop() || v });
  e.target.value = '';
  touch();
  render();
  fillDetail(n.id);
});

$('detailClose').addEventListener('click', closeDetail);

/* ---------------- 工作区 ---------------- */

function renderRail() {
  railList.textContent = '';
  $('railSub').textContent = `${S.index.length} 个工作区`;

  // 窄屏（塞进侧边栏）时左栏被隐藏，改用顶栏下拉
  const sel = $('wsSelect');
  sel.textContent = '';
  for (const w of S.index) {
    const o = document.createElement('option');
    o.value = w.ws;
    o.textContent = w.title === w.ws ? w.ws : w.title;
    sel.appendChild(o);
  }
  sel.value = S.ws || '';

  for (const w of S.index) {
    const b = document.createElement('button');
    b.className = 'ws' + (w.ws === S.ws ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'ws-name';
    name.appendChild(document.createTextNode(w.title === w.ws ? w.ws : w.title));
    if (w.draft) {
      const t = document.createElement('span');
      t.className = 'draft';
      t.textContent = '草稿';
      name.appendChild(t);
    }
    const sub = document.createElement('div');
    sub.className = 'ws-sub';
    sub.textContent = `${w.ws} · ${w.nodes} 框 / ${w.edges} 线`;
    b.appendChild(name);
    b.appendChild(sub);
    b.addEventListener('click', () => loadWorkspace(w.ws));
    railList.appendChild(b);
  }
}

async function loadWorkspace(ws) {
  if (S.dirty) await saveNow();
  try {
    const map = await fetch('api/map/' + encodeURIComponent(ws)).then((r) => r.json());
    S.ws = ws;
    S.map = map;
    if (!S.map.edges) S.map.edges = [];
    S.pinned.clear();
    S.sel = null;
    S.dirty = false;
    closeDetail();
    closeEdgeMenu();
    setSavePill('saved');
    $('empty').hidden = true;
    renderRail();
    render();
    focusReadable();
  } catch (err) {
    console.error(err);
  }
}

async function boot() {
  try {
    const data = await fetch('api/workspaces').then((r) => r.json());
    S.index = data.workspaces || [];
    renderRail();
    if (S.index.length) await loadWorkspace(S.index[0].ws);
    else $('empty').hidden = false;
  } catch (err) {
    $('wsTitle').textContent = '连不上服务';
    $('wsMeta').textContent = '确认 node server.mjs 在跑';
    console.error(err);
  }
}

/* ---------------- 控件 ---------------- */

$('chips').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  S.filter = btn.dataset.filter;
  for (const c of $('chips').children) c.classList.toggle('active', c === btn);
  applyDim();
});

$('search').addEventListener('input', (e) => {
  S.query = e.target.value;
  applyDim();
});

$('fit').addEventListener('click', fitAll);

$('relayout').addEventListener('click', () => {
  S.pinned.clear();
  render();
  fitAll();
});

$('wsSelect').addEventListener('change', (e) => {
  if (e.target.value && e.target.value !== S.ws) loadWorkspace(e.target.value);
});

window.addEventListener('resize', () => { if (S.map) { render(); } });

window.addEventListener('beforeunload', (e) => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
});

boot();
