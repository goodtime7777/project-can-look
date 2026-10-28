---
name: projectmap
description: >
  工作区的项目地图（<项目根目录>/<工作区>/.projectmap/map.json）。
  开工前读图看这个项目长到哪了、有没有待办连线；收尾时把做过的事补成节点、改状态。
  只在两种情况下用：当前工作区根目录存在 .projectmap/map.json，或者用户明确提到
  项目地图/地图/画布/节点/连线/合成线。
  不要在其他时候读它，会白烧 token。
metadata:
  version: "1.0.0"
  created: "2026-10-28"
  viewer: "start.bat 或 node server.mjs → http://127.0.0.1:8377"
---

# projectmap · 项目地图的读写规则

地图是给用户看的"发育史"，也是用户给 agent 下指令的地方。
**用户画线 = 提需求**，不是装饰。

## 先看有没有

```
<当前工作区>\.projectmap\map.json
```

- 有 → 开工前读一次（不用整份念给用户，只提取：项目长到哪、有没有 `status: "pending"` 的线）
- 没有 → 别自己造。除非用户说"给这个项目建张地图"

## 数据结构（够用就行）

```json
{
  "schema": 1, "workspace": "xxx", "title": "项目名",
  "settings": { "mergePolicy": "ask" },
  "nodes": [
    { "id": "n1", "parent": null, "title": "一句话", "kind": "idea",
      "status": "doing", "note": "做完什么/卡在哪", "refs": [] }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "type": "merge", "status": "pending",
      "policy": "ask",
      "recipe": { "take": { "n1": ["框架"], "n2": ["配色"] },
                  "product": "合体", "words": "用户原话" } }
  ]
}
```

- `parent` 决定树（一个框只能有一个爹），`edges` 只放横向关系
- `kind`：idea 思路 / frame 框架 / content 内容 / ui 界面 / fix 修复 / other
- `status`：idea / doing / blocked / done / dropped —— 只有状态，**没有进度百分比**
- 线的 `type`：`merge` 合成 / `ref` 参考 / `dep` 依赖 / `flow` 次序

## 什么时候写图

写之前先确认工作区里真的有 map.json。

| 时机 | 动作 |
|---|---|
| 开工，这个项目还没有根节点 | 加一个根节点：本轮的目的一句话，`status: doing` |
| 开始做新的一块（新的分叉） | 加节点，`parent` 指向它从哪长出来的 |
| 一块做完了 | 把那个节点的 `status` 改成 `done`，`note` 补一句做成了什么 |
| 卡住了 | `status: blocked`，`note` 写清卡在哪（等谁/等什么） |
| 改了方向、放弃了 | `status: dropped`，别删节点，删了就看不出走过弯路 |
| 收尾 | 检查这轮有没有留下没改状态的节点 |

**别做**：别改别人写的标题、别删节点、别重排结构。用户可能手动调过。

## 待办的连线怎么处理

`edges` 里 `status: "pending"` 的，是用户画的、还没落实的意图。按 `policy`（没有就看 `settings.mergePolicy`）分三档：

- `ask` —— 先记着。开工时提一句"图上有 N 条待办线，要先做哪条"，等用户说
- `plan` —— 主动出方案（要做什么、动哪些文件、风险），等用户点头再动手
- `auto` —— 直接做

做完把那条线 `status` 改成 `done`，并在旁边加一个产物节点，把结果记进去。

`merge` 线的 `recipe.take` 是配方：从哪个节点取什么。**按它取，不要自己发挥**。

## 一句话

读图是为了接上上下文，写图是为了让用户下回一眼看出这个项目长到哪了。
写不准就别写——空白比假话好。
