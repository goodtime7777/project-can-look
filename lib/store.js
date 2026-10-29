// 工作区的两份数据：map.json（结构）和 activity.ndjson（事实流水）
// 只读，给"落后多少条"这类读数用。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAP = ['map', 'json'].join('.');
const ACT = ['activity', 'ndjson'].join('.');

/** 读流水（坏行跳过，不让一行坏数据拖垮整个读数） */
export async function readActivity(cwd) {
  try {
    const text = await readFile(join(cwd, '.projectmap', ACT), 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function readMapFile(cwd) {
  try {
    return JSON.parse(await readFile(join(cwd, '.projectmap', MAP), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 落图进度：流水里有多少条，已经被节点 `from` 认领了多少条。
 * 没有 id 的老记录（0.3 之前）不算没入图，否则它们永远不会消失。
 */
export async function pendingStats(cwd) {
  const [acts, map] = await Promise.all([readActivity(cwd), readMapFile(cwd)]);
  const claimed = new Set();
  for (const n of map?.nodes ?? []) {
    for (const a of n.from ?? []) claimed.add(a);
  }
  let pending = 0;
  for (const a of acts) {
    if (a?.id && !claimed.has(a.id)) pending += 1;
  }
  const last = acts[acts.length - 1];
  return {
    total: acts.length,
    pending,
    lastActivityAt: typeof last?.at === 'string' ? last.at : null,
    nodes: Array.isArray(map?.nodes) ? map.nodes.length : 0,
    mainline: Array.isArray(map?.mainline) ? map.mainline.length : 0,
  };
}
