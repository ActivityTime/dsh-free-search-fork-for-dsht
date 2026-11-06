/**
 * tool_gate — 让「插件设置 → 工具开关」决定工具**是否注册**（2026-11-07）
 *
 * 为什么需要这一层（先读 search_switch.js 顶部再读这里）：
 *
 *   本插件早先的门禁只做两件事：
 *     ① assembly 层从 `assembly.tools` 移除 → 请求里没有，模型看不到；
 *     ② 执行层 `ctx.tools.guard` 否决 → 绕过去也调不动。
 *   两道闸都作用在"请求/调用"，工具的**注册**从未变化。
 *
 *   但 DSHT「本局设置 → 高级 → 前台工具」这个列表不只看静态目录：
 *   `tavern-plugin/lib/domain/conversation-background-settings.js` 的 toolCatalog()
 *   先取静态 FOREGROUND_TOOL_CATALOG，再追加 `extraTools(sessionId)`；
 *   而 extraTools（tavern-plugin/lib/index.js 的 extraTools / recordTools）在
 *   本局还没有任何请求缓存时，回落到 `ctx.tools.schemas()` —— 宿主**注册表**。
 *   于是：开关关着的工具因为"仍然注册着"，会在新局/重启后重新列进面板。
 *
 *   官方 `register(definition, { when })` 的条件工具也救不了这个列表：
 *   dsh-tools 的 definitions()/schemas() 在**不带 toolSet** 时只读注册定义、
 *   不求值 when（README "Conditional tools"：omitting toolSet inspects registered
 *   definitions without evaluating conditions）。面板调的正是无参 `schemas()`。
 *
 *   所以要让"未开启的工具在面板里也不可见"，唯一站得住的做法是**不注册**：
 *   注册表里没有 → schemas() 里没有 → 面板回落路径也没有。
 *
 * 语义（与 search_switch.js 的两道闸并存，互为纵深）：
 *   - 开关 ON  → 注册（原有行为不变）；
 *   - 开关 OFF → 不注册（面板、宿主工具目录、assembly、执行层同时看不到）；
 *   - 设置页保存后由 syncToolRegistrations() 立即对齐（无需重启）；
 *   - 读取失败一律视为"开启"（fail-open）——与 search_switch 的 disabledTools
 *     读取口径一致：宁可多注册一个工具，也不因插件自身故障把用户的核心搜索功能弄丢。
 *     （web_fetch 的 fail-closed 在 search_switch 里，与本层无关。）
 *
 * ⚠ 只用于本插件自己的工具（OWN_TOOLS）。web_fetch 是官方工具名，仍然常驻注册，
 *   由 search_switch 的 assembly + guard 管；不要把它接进来。
 */

/** 当前被用户停用的工具名集合读取器。默认恒空（= 全部注册）。 */
let readDisabledTools = () => [];

/** 诊断/错误日志出口，由 apply() 注入；默认静默。 */
let logInfo = () => {};
let logWarn = () => {};

/** 已经播报过"因开关关闭而未注册"的工具名，避免每次 sync 重复刷日志。 */
const announcedOff = new Set();

/** 注册槽集合：每个工具一条，保存 sctx / definition / 当前 disposer。 */
const slots = new Set();

/**
 * 注入运行期读取器。**必须传函数**（`() => current().disabledTools`），
 * 传快照会让保存后要重启才生效。
 * @param {{ readDisabledTools?: () => string[], logger?: { info?: Function, warn?: Function } }} options
 */
export function configureToolGate({ readDisabledTools: reader, logger } = {}) {
  if (typeof reader === "function") readDisabledTools = reader;
  if (logger) {
    if (typeof logger.info === "function") logInfo = (message) => logger.info(message);
    if (typeof logger.warn === "function") logWarn = (message) => logger.warn(message);
  }
}

/** 该工具的开关是否开启（未配置/读取异常 → 视为开启）。 */
export function toolSwitchOn(name) {
  try {
    const list = readDisabledTools();
    if (!Array.isArray(list)) return true;
    return !list.includes(name);
  } catch {
    return true;
  }
}

/** 让单个槽对齐当前开关：开则注册，关则注销。异常只记日志、不阻断调用方。 */
function applySlot(slot) {
  const wanted = toolSwitchOn(slot.name);
  if (wanted) {
    if (slot.dispose !== null) return;
    try {
      slot.dispose = slot.sctx.tools.register(slot.definition);
      // 只有"之前因开关关闭而缺席、现在补注册"才播报，冷启动注册保持静默
      if (announcedOff.has(slot.name)) {
        announcedOff.delete(slot.name);
        logInfo(`free-search: tool "${slot.name}" registered (enabled in plugin settings)`);
      }
    } catch (error) {
      slot.dispose = null;
      logWarn(`free-search: tool "${slot.name}" could not be registered (${error instanceof Error ? error.message : String(error)})`);
    }
    return;
  }
  if (slot.dispose === null) {
    if (!announcedOff.has(slot.name)) {
      announcedOff.add(slot.name);
      logInfo(
        `free-search: tool "${slot.name}" is disabled in plugin settings — not registered, so it is absent from the host tool catalog and from the per-chat foreground tool list`
      );
    }
    return;
  }
  const dispose = slot.dispose;
  slot.dispose = null;
  announcedOff.add(slot.name);
  try {
    dispose();
  } catch (error) {
    logWarn(`free-search: tool "${slot.name}" could not be unregistered (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * 按开关注册工具（替代裸 `sctx.tools.register`）。
 *
 * 用法与原来逐行一致，只是把注册交给开关决定：
 *   const dispose = registerGatedTool(sctx, "advanced_search", defineTool({ ... }));
 *   返回的 disposer 关闭本槽（含已注册的工具），语义等同 sctx.tools.register 的返回值。
 *
 * @param {object} sctx 注入 tools 的上下文
 * @param {string} name 工具名（必须与 definition.name 一致）
 * @param {object} definition defineTool 产物
 * @returns {() => void} 注销函数
 */
export function registerGatedTool(sctx, name, definition) {
  const slot = { sctx, name, definition, dispose: null };
  slots.add(slot);
  applySlot(slot);
  return () => {
    slots.delete(slot);
    if (slot.dispose === null) return;
    const dispose = slot.dispose;
    slot.dispose = null;
    try {
      dispose();
    } catch {
      /* 上下文已在销毁流程中，忽略 */
    }
  };
}

/**
 * 把全部已登记槽对齐到最新开关状态。设置页保存（store.set）后调用，
 * 使开关的打开/关闭**立即**反映到注册表，无需重启。
 */
export function syncToolRegistrations() {
  for (const slot of [...slots]) {
    try {
      applySlot(slot);
    } catch (error) {
      logWarn(`free-search: tool "${slot.name}" sync failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

/** 诊断导出（离线核对开关真值用，不参与运行期逻辑）。 */
export const __debug = {
  toolSwitchOn,
  slotNames: () => [...slots].map((slot) => slot.name),
  registeredNames: () => [...slots].filter((slot) => slot.dispose !== null).map((slot) => slot.name),
};
