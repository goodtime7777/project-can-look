// 写权限的守门人：进程级令牌
//
// 为什么需要这个：服务只监听 127.0.0.1 挡不住"你浏览器里的恶意页面"。
// 之前为了沙箱 iframe 开了 Access-Control-Allow-Origin: *，等于把写接口
// 对整个本机网段敞开（实测另起一个 8899 的页面就能 POST 清空地图）。
//
// 做法：进程启动生成一个随机令牌，注入到它自己发出的 index.html 里；
// 所有 /api/* 请求必须带 x-pm-token。
// 跨源页面拿不到这份 HTML（没有 ACAO），也就拿不到令牌。

import { randomUUID } from 'node:crypto';

export const TOKEN = randomUUID();

const META = `<meta name="pm-token" content="${TOKEN}">`;

/** 把令牌注进页面（幂等） */
export function injectToken(html) {
  if (typeof html !== 'string') return html;
  if (html.includes('name="pm-token"')) return html;
  if (html.includes('</head>')) return html.replace('</head>', `${META}</head>`);
  return META + html;
}

/** 这个请求有没有带对令牌 */
export function authorized(req) {
  const got = req?.headers?.['x-pm-token'];
  if (typeof got !== 'string' || got.length === 0) return false;
  // 长度不同直接判负，避免逐字符比较泄露
  if (got.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}
