/**
 * proxy —— 代理配置的唯一解析入口（2026-10-18 新增）
 *
 * 为什么需要它：`index.js` 的 `dispatcherFor(engine)` 只服务 provider 层（引擎源），
 * 而 platform_search / domain_search / research / weather 四条链路的取网方式各不相同：
 *   - platform_search：index.js 顶部的 undici fetch（没传 dispatcher）→ 补 dispatcher 即可；
 *   - weather：weather.js 的全局 fetch（连 undici 都没 import）→ 换 undici fetch + dispatcher；
 *   - domain_search / research：fetch_upstream.js 的 **node:https**，该模块不能 import index.js
 *     （会形成循环依赖），因此代理解析必须放在一个双方都能引入的独立模块里。
 *
 * 注入式而非直接读配置：proxy.js 保持零业务依赖，由 index.js 在 apply 时调
 * `configureProxyResolver(() => current()?.proxyByTool)` 注入活读取函数——
 * 与 disabledTools 同理，读 liveConfig，设置页保存后即时生效、无需重启。
 *
 * 两套代理配置语义不同、UI 分组呈现（不要混列）：
 *   - `proxyByEngine`：引擎源级（provider 层：searxng / ddg / exa / tavily / firecrawl / parallel…），
 *     由 index.js 的 dispatcherFor 消费，作用于 web_search 与多源/高级/测试/视频四个工具；
 *   - `proxyByTool`：工具级（本模块消费），作用于 platform_search / domain_search /
 *     research / weather 四条直连链路。
 */

import http from "node:http";

/** @type {null | (() => (Record<string, string> | null | undefined))} */
let resolver = null;

/**
 * 注入配置读取函数（index.js apply 时调用）。传入的是**函数**而非快照：
 * 用户在设置页保存后立即生效，不需要重启插件。
 * @param {() => (Record<string, string> | null | undefined)} fn
 */
export function configureProxyResolver(fn) {
  resolver = typeof fn === "function" ? fn : null;
}

/**
 * 取某工具的代理地址；未配置/读失败 → 空串（调用方按直连处理）。
 * 读配置抛异常绝不外泄：代理解析失败只应导致"直连"，不应让工具整体不可用。
 *
 * 优先级（2026-08 起）：`proxyByTool[tool]` > **`defaultProxyUrl`（全局默认）**。
 * 后者是给"我不想逐个配"的场景准备的：填一次，全部工具生效；细分配置只作覆盖。
 *
 * @param {string} toolId 工具名（platform_search / domain_search / research / weather）
 * @returns {string} 形如 http://127.0.0.1:10808；未配置返回 ''
 */
export function resolveProxyUrl(toolId) {
  if (!resolver) return "";
  let map;
  try {
    map = resolver();
  } catch {
    return "";
  }
  try {
    if (map && typeof map === "object" && typeof map[toolId] === "string" && map[toolId].trim()) {
      return map[toolId].trim();
    }
    // 回落到全局默认（用户只填了一次就全生效，不必逐个勾选）
    const fallback = map?.defaultProxyUrl;
    return typeof fallback === "string" ? fallback.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 经 HTTP 代理建立到目标的 TCP 隧道（CONNECT），供 node:https 用 createConnection 接管。
 *
 * 仅支持 http:// 代理（V2rayN/Clash 等本地混合端口的常规形态）；https:// 代理直接忽略，
 * 按"无代理"处理而不是抛错——代理写法不当不该让功能整体挂掉。
 *
 * @param {string} proxyUrl
 * @param {string} host 目标主机名
 * @param {number} port 目标端口
 * @param {number} timeoutMs CONNECT 阶段超时
 * @returns {Promise<import("node:net").Socket>}
 */
export function openTunnel(proxyUrl, host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(proxyUrl);
    } catch {
      reject(new Error(`invalid proxy url: ${proxyUrl}`));
      return;
    }
    if (u.protocol !== "http:") {
      reject(new Error(`unsupported proxy protocol: ${u.protocol}`));
      return;
    }
    const headers = { host: `${host}:${port}` };
    // 本地代理一般无认证，但带用户名密码时按 Basic 发 Proxy-Authorization（部分机场/公司网关需要）。
    if (u.username) {
      const raw = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`;
    }
    const req = http.request({
      host: u.hostname,
      port: Number(u.port) || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: timeoutMs,
    });
    req.once("connect", (res, socket) => {
      // 代理用非 200 状态拒绝（407 认证失败、403 策略拒绝等）
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT refused: HTTP ${res.statusCode}`));
        return;
      }
      // 隧道建立后 socket 归调用方所有；ref() 防止被事件循环 GC 掉（Node 18+ 的已知坑）。
      socket.ref?.();
      resolve(socket);
    });
    req.once("timeout", () => {
      req.destroy(new Error(`proxy CONNECT timeout after ${timeoutMs}ms`));
    });
    req.once("error", reject);
    req.end();
  });
}
