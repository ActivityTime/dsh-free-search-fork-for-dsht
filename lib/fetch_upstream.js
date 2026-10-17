// fetch_upstream：web_fetch 质量链的云端抓取层（自 research.js 摘取，原生通道版专用）。
// 依赖面：仅 node:https。fetch_provider.js 从这里拿 callExa / callFirecrawl / callCrawl4ai。
// 注意：不用全局 fetch(undici) 访问 api.crawl4ai.com——其 Pingora 网关会空 401 拦截 undici 特征。
//
// ⚠ 本模块的请求**此前完全不受「每源代理」设置影响**（node:https 无代理能力）。
//   2026-10-18 起支持工具级代理 `proxyByTool`：调用方传 `tool`（domain_search / research /
//   web_fetch），本模块据其配置走 HTTP CONNECT 隧道；未配置则**原样直连**（行为不变）。
//   代理解析走 ./proxy.js（注入式，避免与 index.js 循环依赖）。
//
//   仍未覆盖的：node:https → undici 的迁移会连带影响重定向、超时与错误语义，
//   需完整回归，不在本次改动范围内。

import https from "node:https";
import tls from "node:tls";
import { openTunnel, resolveProxyUrl } from "./proxy.js";

// ---------- 受控替身注入点（测试基建；默认全 null = 生产直连真实服务，行为不变） ----------
export const CONTROLLED_STUBS = { exa: null, firecrawl: null, crawl4ai: null };

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// ---------- 云端抓取（node:https，保留头大小写；undici 会被 crawl4ai 网关拦） ----------

/**
 * 走 node:https 的 JSON/文本请求。
 * @param {string} method
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.tool] 工具名（决定用哪条工具级代理：domain_search / research / web_fetch）。
 *   不传或未配置代理 → 直连，行为与加代理之前逐字节一致。
 */
export function httpsJson(method, url, { headers = {}, body, timeoutMs = 30000, signal, tool } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proxyUrl = resolveProxyUrl(tool);
    const send = (createConnection) => {
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method,
          headers,
          timeout: timeoutMs,
          ...(createConnection ? { createConnection } : {}),
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8"), location: res.headers.location || "" }));
        }
      );
      req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      req.on("error", reject);
      if (signal) {
        const onAbort = () => req.destroy(new Error("aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      if (body) req.write(body);
      req.end();
    };

    if (!proxyUrl) {
      send(undefined); // 直连：与引入代理前完全一致
      return;
    }
    // 经代理：先 CONNECT 打通隧道，再在这条已建立的 TCP 连接上完成 TLS 握手。
    //
    // ⚠ 关键点：https.request 的 createConnection 必须返回**已握手的 TLSSocket**。
    //   直接返回明文 socket 的话，请求会以明文写进隧道，而对端在等 TLS → 表现为挂起直到超时
    //   （实测踩过：CONNECT 返回 200 但请求 timeout）。故必须再套一层 tls.connect。
    //   SNI 只在目标是域名时给；目标是 IP 时传 servername 会触发 Node 警告。
    openTunnel(proxyUrl, u.hostname, Number(u.port) || 443, Math.min(timeoutMs, 15000))
      .then((socket) => {
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(":");
        const secure = tls.connect(isIp ? { socket } : { socket, servername: u.hostname });
        socket.on("error", (e) => secure.destroy(e)); // 隧道建立后中途断链，转成请求错误而不是静默挂起
        send(() => secure);
      })
      .catch(reject);
  });
}

/**
 * 抓 HTML 正文，**跟随重定向**，返回宿主 web_fetch 同构的结果：
 *   `{ statusCode, body: { kind: "html", content }, truncated, finalUrl }`
 *
 * 为什么需要它：research 的 T1 层原本走宿主 `ctx.web.fetch`，那是**全局** provider，
 * 无法按调用方携带代理 —— 于是「工具级代理」对 research 的第一档抓取天然失效。
 * 由本函数先按 `tool` 的代理配置直抓一次，失败再落回宿主链（原有的
 * T1→T1.5 无头浏览器→T2 exa→T3 firecrawl→T4 crawl4ai 降级**完整保留**）。
 *
 * 未配置 `tool` 代理时调用方应直接走宿主链，不要用本函数（避免无谓的行为差异）。
 */
export async function fetchHtmlVia(url, { tool, timeoutMs = 20000, headers = {}, signal, maxRedirects = 5 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const r = await httpsJson("GET", current, {
      headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", ...headers },
      timeoutMs,
      signal,
      tool,
    });
    // 3xx 且带 Location → 跟到下一跳；相对地址按当前 URL 解析
    if (r.status >= 300 && r.status < 400 && r.location) {
      current = new URL(r.location, current).toString();
      continue;
    }
    return { statusCode: r.status, body: { kind: "html", content: r.text }, truncated: false, finalUrl: current };
  }
  throw new Error(`too many redirects (>${maxRedirects}) starting from ${url}`);
}

/** firecrawl /v2/scrape：返回 markdown。undici 特征对其无碍，但统一走 httpsJson。 */
export async function fetchViaFirecrawl(url, apiKey, signal, tool) {
  const r = await httpsJson("POST", "https://api.firecrawl.dev/v2/scrape", {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal,
    tool,
  });
  if (r.status !== 200) throw new Error(`firecrawl HTTP ${r.status}`);
  const data = JSON.parse(r.text);
  const md = data?.data?.markdown;
  if (!md) throw new Error("firecrawl: no markdown");
  return md;
}

/** crawl4ai POST /scrape（注意：此部署无 /v1 前缀；认证头 X-API-Key）。 */
export async function fetchViaCrawl4ai(url, apiKey, signal, tool) {
  const r = await httpsJson("POST", "https://api.crawl4ai.com/scrape", {
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json", "User-Agent": "dsh-free-search-fork-for-dsht/0.8" },
    body: JSON.stringify({ url }),
    signal,
    tool,
  });
  if (r.status === 429) throw new Error("crawl4ai rate-limited (community plan)");
  if (r.status !== 200) throw new Error(`crawl4ai HTTP ${r.status}`);
  const data = JSON.parse(r.text);
  const content = data?.markdown || (data?.html ? htmlToText(data.html) : "");
  if (!content) throw new Error("crawl4ai: empty content");
  return content;
}

/** exa POST /contents（$1/1000 页）：{ids:[url], text:true} → results[].text（清洗正文 markdown）。
 * 端点形状（https://exa.ai/docs/reference/get-contents，2026-10-05 核实）：
 *  - 认证 Authorization: Bearer（x-api-key 亦可）；ids 与 urls 二选一等价（ids 向后兼容）。
 *  - text 布尔/对象均可（对象形如 {maxCharacters}；此处取全文不加限）。
 *  - 响应 results[]（含 text）+ statuses[]（每 URL 成败，失败带 error.tag/httpStatusCode）。
 * 与 fetch_provider 质量链共用：T2 层。 */
export async function fetchViaExa(url, apiKey, signal, tool) {
  const r = await httpsJson("POST", "https://api.exa.ai/contents", {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ids: [url], text: true }),
    signal,
    tool,
  });
  if (r.status !== 200) throw new Error(`exa HTTP ${r.status}`);
  const data = JSON.parse(r.text);
  const st = (data?.statuses ?? []).find((s) => s.id === url) ?? data?.statuses?.[0];
  if (st && st.status !== "success") throw new Error(`exa: status ${st.status}${st.error?.httpStatusCode ? ` (HTTP ${st.error.httpStatusCode})` : ""}`);
  const hit = (data?.results ?? []).find((x) => x.id === url || x.url === url) ?? data?.results?.[0];
  const text = hit?.text;
  if (!text) throw new Error("exa: no text");
  return text;
}

export const callFirecrawl = (u, k, s, tool) => (CONTROLLED_STUBS.firecrawl ?? fetchViaFirecrawl)(u, k, s, tool);
export const callCrawl4ai = (u, k, s, tool) => (CONTROLLED_STUBS.crawl4ai ?? fetchViaCrawl4ai)(u, k, s, tool);
export const callExa = (u, k, s, tool) => (CONTROLLED_STUBS.exa ?? fetchViaExa)(u, k, s, tool);
