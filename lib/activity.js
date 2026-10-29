// activity 流水：把每个回合的事实记成一行，给地图当原料
//
// 触发点：session/event 里的 turn/end。一个回合 = 一行。
// 只写事实（问了你什么、动了哪些文件、跑了什么命令），不做任何判断。
//
// 三条硬规则：
//   1. 工作区没有 .projectmap/map.json 就完全不写（轻量项目零开销）
//   2. map.json 里 settings.enabled === false 也不写
//   3. 任何异常都吞掉，绝不能影响 agent 跑活

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'activity.ndjson';
const MAX_BYTES = 1024 * 1024; // 超过 1MB 就轮转
const MAX_FILES_PER_TURN = 40;
const MAX_ASK = 200;
const MAX_CMD = 120;

/** 会改文件的工具 → 从参数里取路径 */
const FILE_TOOLS = new Set(['write', 'edit', 'str_replace', 'multi_edit', 'apply_patch', 'create_file', 'notebook_edit']);
/** 可能间接改文件的工具 → 记命令 */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'powershell']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
    .join(' ')
    .trim();
}

/**
 * 用户消息里常常拼着 harness 注入的东西：运行时上下文、system-reminder 块…
 * 那些不是他真正说的话，记进流水会把"他当时想干什么"整个冲掉。
 * 先剥掉尖括号块，再按段落切、丢掉已知开头段；剥完只剩空白就留空，别写脏数据。
 */
const PREAMBLE = /^(Time sampled|Current runtime context|Current DSH|Current DeepSeek Harness|Current working directory|Browser time zone|Approval prompts are disabled|The approval policy changed)/i;

function cleanAsk(text) {
  const raw = String(text || '');
  if (!raw) return '';

  const stripped = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<[a-z]+-[a-z]+>[\s\S]*?<\/[a-z]+-[a-z]+>/gi, ' ');

  // 按段落切，丢掉注入段
  const paras = stripped.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const kept = paras.filter((p) => !PREAMBLE.test(p));
  let out = (kept.length ? kept.join(' ') : stripped).replace(/\s+/g, ' ').trim();

  // 常见情况：注入块和用户的话挤在同一段里，段落级过滤救不了。
  // 这时退一步取最后一行——harness 的上下文永远是前置的，用户的话在后面。
  if (PREAMBLE.test(out)) {
    const lines = stripped.split('\n').map((l) => l.trim()).filter(Boolean);
    const tail = [...lines].reverse().find((l) => !PREAMBLE.test(l)) || '';
    out = tail.replace(/\s+/g, ' ').trim();
  }

  return out.length > 3 ? out : '';
}

function pickPath(args) {
  if (!args || typeof args !== 'object') return null;
  const v = args.path ?? args.file_path ?? args.filePath ?? args.target_file;
  return typeof v === 'string' && v ? v : null;
}

function sessionCwd(session) {
  const v = session?.cwd ?? session?.header?.cwd ?? session?.workingDirectory;
  return typeof v === 'string' && v ? v : null;
}

function sessionIdOf(session) {
  const v = session?.id ?? session?.header?.id;
  return typeof v === 'string' && v ? v : null;
}

/** 这个工作区要不要记流水 */
async function workspaceDir(cwd) {
  const dir = join(cwd, '.projectmap');
  const mapFile = join(dir, 'map.json');
  if (!existsSync(mapFile)) return null;
  try {
    const map = JSON.parse(await readFile(mapFile, 'utf8'));
    if (map?.settings && map.settings.enabled === false) return null;
  } catch {
    return null; // map.json 坏了也别写
  }
  return dir;
}

async function rotate(file) {
  try {
    const st = await stat(file);
    if (st.size < MAX_BYTES) return;
    await rename(file, file.replace(/\.ndjson$/, `.1.ndjson`));
  } catch {
    /* 文件不存在就跳过 */
  }
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 挂上流水记录。返回一个 detach 函数。
 * @param ctx cordis 上下文（只用 ctx.on）
 */
export function attachActivity(ctx) {
  if (typeof ctx?.on !== 'function') return () => {};

  /** sessionId -> { turn, ask, files:Set, cmds:[], tools:Set, cwd } */
  const pending = new Map();

  const bucket = (sid, cwd) => {
    let b = pending.get(sid);
    if (!b) {
      b = { turn: 0, ask: '', files: new Set(), cmds: [], tools: new Set(), cwd };
      pending.set(sid, b);
    }
    if (cwd) b.cwd = cwd;
    return b;
  };

  async function flush(sid) {
    const b = pending.get(sid);
    if (!b) return;
    pending.delete(sid);

    const { cwd } = b;
    if (!cwd) return;
    if (!b.files.size && !b.cmds.length && !b.ask) return;

    const dir = await workspaceDir(cwd);
    if (!dir) return;

    const at = new Date();
    const rec = {
      id: `act_${at.getTime().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      v: 1,
      at: at.toISOString(),
      sid,
      turn: b.turn,
      ask: b.ask ? clip(b.ask, MAX_ASK) : undefined,
      files: b.files.size ? [...b.files].slice(0, MAX_FILES_PER_TURN) : undefined,
      cmds: b.cmds.length ? b.cmds.slice(0, 3) : undefined,
      tools: b.tools.size ? [...b.tools] : undefined,
    };

    await mkdir(dir, { recursive: true });
    const file = join(dir, FILE);
    await rotate(file);
    await appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  }

  const off = ctx.on('session/event', (session, event) => {
    // 这条链路上任何异常都不许冒出去
    try {
      const sid = sessionIdOf(session);
      if (!sid) return;
      const type = event?.type;
      const data = event?.data ?? {};

      if (type === 'user/message') {
        const b = bucket(sid, sessionCwd(session));
        const text = cleanAsk(textOf(data.content ?? data.message?.content));
        if (text) b.ask = text;
        return;
      }

      if (type === 'tool/call') {
        const b = bucket(sid, sessionCwd(session));
        const name = typeof data.name === 'string' ? data.name : '';
        if (name) b.tools.add(name);
        let args = {};
        try {
          args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments ?? {};
        } catch {
          args = {};
        }
        if (FILE_TOOLS.has(name)) {
          const p = pickPath(args);
          if (p) b.files.add(p);
        } else if (SHELL_TOOLS.has(name)) {
          const cmd = args.command ?? args.cmd ?? args.script;
          if (typeof cmd === 'string' && cmd) b.cmds.push(clip(cmd, MAX_CMD));
        }
        return;
      }

      if (type === 'turn/end') {
        const b = pending.get(sid);
        if (b) b.turn = typeof data.turn === 'number' ? data.turn : b.turn;
        flush(sid).catch(() => {});
        return;
      }

      if (type === 'session/disposed') {
        flush(sid).catch(() => {});
        return;
      }
    } catch {
      /* 吞掉，绝不影响主流程 */
    }
  });

  return () => {
    try {
      off?.();
    } catch {
      /* ignore */
    }
    pending.clear();
  };
}
