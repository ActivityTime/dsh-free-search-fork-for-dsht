/**
 * search_switch — 让本插件的 web 搜索工具遵守 DSHT「联网搜索」开关（v2，2026-10-18 重写）
 *
 * ⚠ v1（llm/stream 里搭 web_search 便车删工具）已废弃，原因：
 *   - web_search 在不在请求里不能当真开关的代理信号——它可能因平台未注册/预设差异/
 *     版本变化而缺席，届时开关开着也会误删工具，**静默挂掉恰恰最需要免搜索的用户的
 *     核心功能**。代理信号 = 脆弱间接，否决。
 *   - llm/stream 属于请求出口 scrubbing，不是平台门控工具的那一层。
 *
 * v2 设计（直接读开关 + 官方同层 + 官方执行层三道）：
 *   ① 直接读每局 chat 状态拿真值：`webSearchEnabled`（+ `mode`）。不搭任何便车。
 *      存储读取移植自 NA `official-worldbook.js` 已验证的两种格式：
 *      block-DAG（head.json + blocks/，record-pack-v1/block-pack-v1 解包、branches/bucket 字段树）
 *      与 journal（snapshots/ 基线 + journals/*.jsonl 帧重放）。dataRoot 由 DSH_HOME
 *      （官方语义=harness 根）+ profile-data/tavern/data 拼出。
 *
 *   ⚠ block-DAG 实测分两代、且 format:2 有两种变体（2026-10-18 真实事故）：
 *     - format:1 —— head.json 无 format 或 =1，headId 即 head block（带 stateId）；
 *     - format:2 —— headId 指向 block-pack-v1 **页索引块**，head 记录的键 hash 恰等于
 *       headId；state 要么 A) 就躺在这个页索引里（kind:'state'），要么 B) 是盘上独立
 *       块（由 head.stateId 指向）。两种变体的**解包层级不同**（A 已解包出 value，
 *       B 未解包），旧实现只认 A → 本机 13 局里 8 局读不出 → 被 fail-closed 误门禁。
 *       现由 findRecordByHash + headerRefOfState 双路径 + 双层解包兼容，13/13 全通。
 *       （同一 bug 也存在于 NA official-worldbook.js，已同步修复。）
 *   ② assembly 层门禁（`system-prompt/assemble` pre 阶段）：开关关 → 从 assembly.tools
 *      移除本插件受控工具。这与官方 gate 自家 web_search 是**同一层**（tavern 的
 *      controlledToolNames 过滤就在这个钩子的 post 阶段）；本插件的钩子后注册=内层，
 *      pre 阶段原地修改会经 next()/return 链向外传播，官方过滤只减不增，移除必然生效。
 *   ③ 执行层门禁（官方 `ctx.tools.guard`，dsh-tools ToolLayer.guardReason 机制）：
 *      开关关 → 受控工具调用被否决并返回可操作的原因。覆盖任何绕过 assembly 的路径。
 *
 * 语义对齐（与官方逐条一致，依据 turn-orchestration.js visibleTools）：
 *   - `visibleTools(sessionId)`：`chat = await store.stateForSession(sessionId)`；
 *     **`chat === undefined` → return []（受控工具全灭，含 web_search）**——即官方
 *     解析不到 chat 时是 fail-closed。本模块同样 fail-closed：拿不到 chat 状态
 *     （无映射且反查未命中）= 门禁。fail-open 会与官方分叉（我放行、官方过滤），
 *     正是缓存前缀翻转的根源。
 *   - `mode === 'card'` 分支恒含 web_search（官方不 gate card）→ 本模块同样放行；
 *   - story/script：`webSearchEnabled === true` 才放行；
 *   - 官方 `stateForSession`（conversation-registry resolveUsing）解析链 =
 *     readLinks 命中 → 用；未命中 → 遍历 index 读各 chat 的 sessionId 反查 →
 *     命中则回写 links。本模块复刻同一覆盖面（反查只读 sessionId 一个标量字段，
 *     比官方 readChat 读全量轻），因此"能解析到"的集合与官方一致。
 *   - latch 只保鲜"曾经成功读到、本次读取异常"的判定；确定结论（含 fail-closed）
 *     立即生效——判定变化与官方同构、同时刻，不是本模块自身的不稳定。
 *
 * 缓存稳定性（工具列表是请求缓存前缀的一部分，2026-10-18 专项加固）：
 *   - 开关 ON（fork 用户的常态）：本插件对 assembly.tools **零触碰**——不赋值、不重建
 *     数组、不改顺序，请求体与没有本插件时逐字节一致 → 前缀缓存完全不受影响；
 *   - 开关 OFF：每请求 filter 出的新数组内容与顺序恒定（filter 保序）→ 序列化后
 *     字节一致 → 前缀稳定（工具就是"不存在"，与官方关掉 web_search 同形态）；
 *   - 用户停用工具时，开关 ON 也会重建 assembly.tools（filter 保序、内容恒定）→
 *     序列化字节依旧一致；**只有停用集合本身变化**才会改变请求体，而那是用户
 *     在设置页点保存的离散动作，不是每请求抖动；
 *   - 判定不抖动：latch 保证"曾经成功读到"后，单次读取异常不会翻转判定——DSHT 写
 *     chat 块/日志造成的间歇读取失败不会让工具反复出现/消失（那会反复打穿缓存）；
 *   - 真实的状态变化（用户拨开关、新会话映射就绪）→ 判定随官方 visibleTools 同时刻
 *     翻转，与官方 web_search 完全同构，属平台行为而非本模块的不稳定；
 *   - 新会话首轮：sessions.json 映射未就绪时走反查（与官方 stateForSession 同一
 *     覆盖面）；确实无绑定 chat 时 fail-closed——官方该轮 web_search 同样缺席，
 *     两边一致消失/恢复，不存在"我放行、官方过滤"的分叉轮。
 *
 * v2.1（2026-10-24）：对齐官方「本局设置 → 高级 → 前台工具」逐工具开关。
 *   官方这版给 chat header 加了 disabledForegroundTools（foreground-tools.js 的
 *   FOREGROUND_TOOL_CATALOG / normalizeDisabledForegroundTools，写入走
 *   conversation-background.js 的 setConversationBackgroundConfig），
 *   visibleTools（turn-orchestration.js:887-906）按它过滤 web_search；插件工具
 *   官方明确不过这道闸（assembleSystemPrompt 对非受控工具只看 tavern.toolModes），
 *   对齐责任在插件自己。本模块因此：
 *   - SWITCH_FIELDS 增加 disabledForegroundTools，journal / block-DAG 两格式同读
 *     （数组字段：journal 帧原样重放；block-DAG 走字段树，pickScalar 兼容数组单元格）；
 *   - 门禁判定从布尔升级为 {allowed, disabled}（gateStateFor）：
 *     · allowed=false（主开关关/无 chat fail-closed）或 disabled 含 'web_search'
 *       → 全体 GATED_TOOLS + web_fetch 一起移除——官方 web_search 不可见的每一局，
 *       本插件搜索工具全体同刻不可见，延续「同一把开关」语义；
 *     · 否则按 disabled 逐工具移除（面板里「插件/扩展 · advanced_search」等条目
 *       生效，web_fetch 自己的条目同样生效）；
 *   - card 模式与官方一致：不吃 allowed 也不吃 disabled（官方 card 分支直接返回
 *     完整名单、不按 disabledForegroundTools 过滤）。
 *
 * 两套相互正交的门控（语义不同，别混为一谈）：
 *   A. 官方「联网搜索」开关 —— 作用于 **OWN_TOOLS 全部 9 个**（= GATED_TOOLS，
 *      2026-10-18 起与工具性质无关）：与官方 web_search 同一把开关、同一判定，
 *      保证「工具开关开启」时前台可见性与 web_search **完全一致**。
 *      后台不参与：后台里这些工具本就不在官方 restrict 白名单中（见顶部四场景）。
 *   B. 用户逐工具停用（设置页 → 工具开关，配置键 disabledTools）—— 同样作用于
 *      OWN_TOOLS 全部 9 个。用户主动停用谁就停谁，与官方开关无关：开关开着也照停，
 *      开关关着也各自成立。只认 OWN_TOOLS 里的名字，配置里出现陌生名字一律忽略
 *      （绝不误伤他插件）。
 *
 * 四类会话场景与归属（2026-10-18 定稿，依据官方源码实测）：
 *   ① 前台（mode = story/script）——由本模块按该 chat 的 webSearchEnabled 门禁。
 *   ② DSHT 官方后台 Agent —— 官方自己按开关管：`background-agent-task.js:203`
 *      `if (task !== 'image' && input.webSearchEnabled === true) return assembly`，否则
 *      过滤掉 web_search；且 `tools.restrict({allow:['skill','tavern_read_skill_reference',
 *      'web_search']})`（:192）**不含任何插件工具** → 本插件工具在官方后台本就不可见。
 *      本模块对后台的判断走父会话（见下），故与官方同开关。
 *   ③ 卡牌工作台（mode = 'card'）—— 恒放行，保持行为（官方 card 分支也恒含 web_search）。
 *   ④ 插件独立后台（NA 结算子 Agent 等）—— 归属该插件自管，本模块**不做特殊适配**：
 *      它们普遍自行 `tools.restrict`（如 NA official-v2.js:506 只留自己的工具），
 *      本插件工具在其白名单外、本就不可见；若它们不 restrict，则按其父会话开关走，
 *      与前后台同一开关，不会出现"前后台关着、独立后台却开着"的分叉。
 *
 *   子 Agent 识别（用于取父会话）：官方 background-agent-sessions.js:233 与 NA
 *   official-v2.js:564 都用 `meta = { parentSession, origin:'subagent', delegationDepth }`，
 *   且官方 background-session-retirement.js:66 用 `record.header.origin === 'subagent'`
 *   判子会话 → 本模块据此读 `session.header/meta.parentSession`。解析不到父会话的
 *   子 Agent → 不干预（放行），绝不因无法归属而误伤第三方后台。
 *
 * ⚠ 跨文件同步：OWN_TOOLS 必须与 client.js 的 TOOLS / TOOL_I18N（zh+en）逐项一致，
 *   由 `npm run check`（scripts/check-consistency.mjs）断言钉住，改名不同步会直接失败。
 */

import fs from "node:fs";
import path from "node:path";

/** 本插件注册的全部工具。用户逐工具开关只允许作用于这些名字——
 *  防止配置里出现陌生名字时误伤其它插件的同名/异名工具。 */
export const OWN_TOOLS = [
  "advanced_search",
  "multi_search",
  "platform_search",
  "domain_search",
  "video_search",
  "research",
  "free_search_test",
  "weather",
  "cache_search",
];

/** 受本局「联网搜索」开关约束的工具名。
 *
 * ⚠ 2026-10-18 统一：这里就是 OWN_TOOLS 全集，早先"只含执行 web 搜索的 7 个、
 *   weather（天气 API）与 cache_search（本地缓存检索）除外"的划分已废除——
 *   用户要求「工具开关开启时，所有工具与官方 web_search 的前台可见性保持一致」。
 *   可见性只有一条判据（该 chat 的 webSearchEnabled，card 恒放行），不再按工具性质分叉；
 *   工具性质只影响**描述文案**与代理分组，不影响门禁。
 *
 *   两者的差别仅在语义说明：weather 确实联网（Open-Meteo），cache_search 不联网
 *   （本地 SQLite 全文检索）。统一门禁后，关掉联网搜索时它们同样不出现——
 *   这正是与 web_search 对齐所要的确定性，避免"关了搜索却还有个能联网的天气工具"。
 */
const GATED_TOOLS = [...OWN_TOOLS];

/** 开关关闭时工具被否决的原因（模型可见，须可操作）。 */
const DENY_REASON =
  "联网搜索已在本局设置中关闭（顶栏 → 本局设置 → 联网搜索），开启后才能使用搜索工具。";

/** 用户在设置页单独禁用了该工具时的否决原因（模型可见，须可操作）。 */
const USER_DENY_REASON =
  "该搜索工具已被用户在插件设置中停用（搜索设置 → 工具开关），如需使用请到设置页重新启用。";

/** 本局「前台工具」逐工具开关关闭时的否决原因（模型可见，须可操作）。 */
const PER_CHAT_DENY_REASON =
  "该工具已在本局设置中关闭（顶栏 → 本局设置 → 高级 → 前台工具），开启后才能使用。";

/** 官方 web_fetch 的模型可见名（tool-web "owns the stable model-facing names"）。 */
const WEB_FETCH_TOOL = "web_fetch";

/** web_fetch 开关关闭时的否决原因。 */
const WEB_FETCH_DENY_REASON =
  "网页抓取工具（web_fetch）已被用户在插件设置中关闭（搜索设置顶部的「网页抓取工具」），如需抓取指定网页请开启后重试。";

/** journal 重放只关心这三个顶层字段。disabledForegroundTools：官方「本局设置 →
 *  前台工具」逐工具开关（chat header 上的数组，存被关闭的工具名）——官方 web_search
 *  由 visibleTools 按它过滤（turn-orchestration.js visibleTools），本插件受控工具
 *  与它对齐（见文件头 v2.1）。 */
const SWITCH_FIELDS = ["webSearchEnabled", "mode", "disabledForegroundTools"];

/** 官方 normalizeDisabledForegroundTools（foreground-tools.js）的本地同款副本：
 *  只收工具名字符串（同款白名单正则），上限 200，绝不让坏数据撑爆门禁判定。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
function normalizeDisabledForegroundTools(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((n) => typeof n === "string" && TOOL_NAME_RE.test(n)))].slice(0, 200);
}
// chat 状态缓存：1s。工具列表属于请求缓存前缀，TTL 只影响"顶栏切换后多久生效"，
// 不影响稳定性（稳定性由 latch 保证）；1s 对人类"切换→发消息"的操作尺度足够。
const STATE_TTL_MS = 1000;
const SESSION_TTL_MS = 10000; // sessionId→chatId 映射缓存（命中后）

// ─────────────────────────── 存储读取（两种格式）───────────────────────────

function tryReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/** 读单个 block：chats/<chatId>/blocks/<hash 前 2 位>/<hash>.json。
 *  实测三种封装统一解包：standalone（内容即值）/ record-pack-v1 / block-pack-v1。 */
function tryReadBlock(dataRoot, chatId, hash, depth = 0) {
  if (!hash || typeof hash !== "string" || depth > 6) return null;
  try {
    const p = path.join(dataRoot, "chats", chatId, "blocks", hash.slice(0, 2), hash + ".json");
    if (!fs.existsSync(p)) return null;
    const value = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!value || typeof value !== "object") return value;
    if (value.kind === "record-pack-v1" && Array.isArray(value.records)) {
      for (const entry of value.records) if (Array.isArray(entry) && entry[0] === hash) return entry[1];
      return null;
    }
    if (value.kind === "block-pack-v1" && Array.isArray(value.records)) {
      for (const entry of value.records) if (Array.isArray(entry) && entry[0] === hash) return entry[1]?.value;
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * 从 state 块取 chatHeaderRef——**两种解包层级都要吃**：
 *   - format:1 / 独立块文件：tryReadBlock 返回 `{kind:"state", value:{chatHeaderRef}}`（未解包）；
 *   - format:2 / state 记录就躺在页索引 pack 里：block-pack-v1 解包返回 `entry[1].value`，
 *     即**已经是** `{chatHeaderRef,...}` 本身（已解包）。
 * 实测 2026-10-18：只认前者会让 pack 内含 state 的 chat 全部读不出。
 */
function headerRefOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.chatHeaderRef === "string") return raw.chatHeaderRef; // 已解包
  if (raw.value && typeof raw.value.chatHeaderRef === "string") return raw.value.chatHeaderRef; // 未解包
  return null;
}

/** block-pack-v1 页索引块内按 kind 找 record。 */
function findRecordByKind(dataRoot, chatId, packHash, kind) {
  try {
    const p = path.join(dataRoot, "chats", chatId, "blocks", packHash.slice(0, 2), packHash + ".json");
    if (!fs.existsSync(p)) return null;
    const pack = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!pack || !Array.isArray(pack.records)) return null;
    for (const entry of pack.records) if (Array.isArray(entry) && entry[1]?.kind === kind) return entry[1];
    return null;
  } catch {
    return null;
  }
}

/**
 * block-pack-v1 页索引块内按 hash 找 record（format:2 的 head 定位）。
 *
 * ⚠ 2026-10-18 实测修正：format:2 的 head.json 形如 `{format:2, headId}`，headId 指向的
 * 是**页索引块**（block-pack-v1，内含若干 `kind:"entries"` 页 + 一条 `kind:"head"`），
 * 且**该 head record 的键 hash 就等于 headId 本身**。它带 stateId，但没有 `value` 字段
 * → `tryReadBlock` 的 block-pack-v1 解包（`entry[1]?.value`）会返回 undefined，
 * 旧实现因此回落到 `findRecordByKind(..., "state")`，而这个 pack 里**根本没有
 * kind:"state"** 的记录 → headerRef=null → 整局读不出开关状态。
 * 实测本机 13 个 chat 中 8 个是 format:2，全部被此 bug 误判为"读不出 → fail-closed"，
 * 表现为"开关明明开着，搜索工具却被门禁"。此处改为按 hash 取（并保留 kind:"head" 兜底）。
 */
function findRecordByHash(dataRoot, chatId, packHash, hash) {
  try {
    const p = path.join(dataRoot, "chats", chatId, "blocks", packHash.slice(0, 2), packHash + ".json");
    if (!fs.existsSync(p)) return null;
    const pack = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!pack || !Array.isArray(pack.records)) return null;
    for (const entry of pack.records) if (Array.isArray(entry) && entry[0] === hash) return entry[1];
    return null;
  } catch {
    return null;
  }
}

/** 字段树里找顶层字段的单元格（branches 递归 / bucket 线性）。 */
function readTopField(dataRoot, chatId, entriesRef, field, depth = 0) {
  if (!entriesRef || depth > 14) return undefined;
  const node = tryReadBlock(dataRoot, chatId, entriesRef);
  if (!node || typeof node !== "object") return undefined;
  if (node.type === "branches" && node.children && typeof node.children === "object") {
    let found;
    for (const key of Object.keys(node.children).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      return Number.isSafeInteger(na) && Number.isSafeInteger(nb) ? na - nb : String(a).localeCompare(b);
    })) {
      const hit = readTopField(dataRoot, chatId, node.children[key], field, depth + 1);
      if (hit !== undefined) found = hit;
    }
    return found;
  }
  if (node.type === "bucket" && Array.isArray(node.items)) {
    for (const item of node.items) if (Array.isArray(item) && item[0] === field) return item[1];
    return undefined;
  }
  return undefined;
}

/** 取标量字段值：{value:x} 内联 → x；{ref} → 下钻一层；裸值 → 本身。
 *  数组字段（disabledForegroundTools）同理：{value:[...]} 内联 / {ref} 解包，
 *  以及单元格本身就是裸数组（未包 cell）的形态都直接透传。 */
function pickScalar(dataRoot, chatId, entriesRef, field) {
  const cell = readTopField(dataRoot, chatId, entriesRef, field);
  if (cell === undefined || cell === null) return undefined;
  if (Array.isArray(cell)) return cell;
  if (typeof cell === "object") {
    if ("value" in cell) return cell.value;
    if (typeof cell.ref === "string") {
      const target = tryReadBlock(dataRoot, chatId, cell.ref);
      if (target && typeof target === "object" && "value" in target) return target.value;
    }
    return undefined;
  }
  return cell;
}

/** block-DAG 格式：head → state → chatHeaderRef → 字段树，取 webSearchEnabled / mode / sessionId。
 *  sessionId 供反查用（sessions.json 未命中时定位 chat，见 reverseLookupChatId）。 */
function readBlockDagState(dataRoot, chatId) {
  const head = tryReadJson(path.join(dataRoot, "chats", chatId, "head.json"));
  const headId = head?.headId;
  if (!headId) return null;
  let headerRef = null;
  const headBlock = tryReadBlock(dataRoot, chatId, headId);
  if (headBlock?.kind === "head" && headBlock.stateId) {
    // format:1 —— headId 即 head block，带 stateId
    headerRef = headerRefOf(tryReadBlock(dataRoot, chatId, headBlock.stateId));
  } else {
    // format:2 —— headId 是页索引块；head record 的键 hash 就等于 headId（见 findRecordByHash 注释）
    const head2 =
      findRecordByHash(dataRoot, chatId, headId, headId) ||
      findRecordByKind(dataRoot, chatId, headId, "head");
    if (head2?.stateId) headerRef = headerRefOf(tryReadBlock(dataRoot, chatId, head2.stateId));
    // 兜底：页索引里直挂 state 记录（head 指向的 state 块不在盘上时仍可解）
    if (!headerRef) {
      const st = findRecordByKind(dataRoot, chatId, headId, "state");
      headerRef = headerRefOf(st) || headerRefOf(st?.value);
    }
  }
  if (!headerRef) return null;
  const header = tryReadBlock(dataRoot, chatId, headerRef);
  if (!header || header.type !== "object" || !header.entries) return null;
  return {
    webSearchEnabled: pickScalar(dataRoot, chatId, header.entries, "webSearchEnabled"),
    mode: pickScalar(dataRoot, chatId, header.entries, "mode"),
    sessionId: pickScalar(dataRoot, chatId, header.entries, "sessionId"),
    disabledForegroundTools: pickScalar(dataRoot, chatId, header.entries, "disabledForegroundTools"),
  };
}

/** journal 格式：snapshots/ 最新快照作基线 + journals/*.jsonl 帧重放（只关心两个字段）。 */
function readJournalState(dataRoot, chatId) {
  const root = path.join(dataRoot, "chats", chatId);
  const snapDir = path.join(root, "snapshots");
  let baseline = null;
  let baseRevision = 0;
  if (fs.existsSync(snapDir)) {
    const files = fs
      .readdirSync(snapDir)
      .filter((f) => /\.json$/i.test(f))
      .sort()
      .reverse();
    for (const file of files) {
      const snap = tryReadJson(path.join(snapDir, file));
      if (snap?.id) {
        baseline = snap;
        const rev = Number(snap._storageRevision);
        if (Number.isSafeInteger(rev)) baseRevision = rev;
        break;
      }
    }
  }
  const state = {
    webSearchEnabled: baseline ? baseline.webSearchEnabled : undefined,
    mode: baseline ? baseline.mode : undefined,
    disabledForegroundTools: normalizeDisabledForegroundTools(baseline?.disabledForegroundTools),
  };
  const journalsDir = path.join(root, "journals");
  if (fs.existsSync(journalsDir)) {
    const rows = fs
      .readdirSync(journalsDir)
      .map((name) => {
        const m = /^(\d{12})-(?:open|(\d{12}))\.jsonl$/i.exec(name);
        return m ? { start: Number(m[1]), path: path.join(journalsDir, name) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
    for (const row of rows) {
      let text;
      try {
        text = fs.readFileSync(row.path, "utf-8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (line === "") continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          break;
        }
        const revision = Number(frame?.revision);
        if (!Number.isSafeInteger(revision) || revision <= baseRevision) continue;
        if (!Array.isArray(frame.changes)) break;
        for (const change of frame.changes) {
          const parts = Array.isArray(change?.path) ? change.path : [];
          if (parts.length !== 1 || !SWITCH_FIELDS.includes(parts[0])) continue;
          state[parts[0]] = change.op === "set" ? change.value ?? null : null;
        }
      }
    }
  }
  return state;
}

// ─────────────────────────── 开关判定（带缓存）───────────────────────────

let dataRootCache; // undefined=未解析；string=已解析；null=解析失败
function tavernDataRoot() {
  if (dataRootCache !== undefined) return dataRootCache;
  let root = null;
  // DSH_HOME 官方语义 = harness 根 → 用户数据根 = <DSH_HOME>/profile-data/tavern/data
  const home = process.env.DSH_HOME;
  if (home) {
    const candidate = path.join(home, "profile-data", "tavern", "data");
    if (fs.existsSync(path.join(candidate, "sessions.json"))) root = candidate;
  }
  dataRootCache = root;
  return root;
}

/** journal 格式：只从最新快照基线读 sessionId（创建时常量，不随帧变化；反查专用）。 */
function readJournalSessionId(dataRoot, chatId) {
  const snapDir = path.join(dataRoot, "chats", chatId, "snapshots");
  if (!fs.existsSync(snapDir)) return null;
  try {
    const files = fs.readdirSync(snapDir).filter((f) => /\.json$/i.test(f)).sort().reverse();
    for (const file of files) {
      const snap = tryReadJson(path.join(snapDir, file));
      if (snap?.id) return typeof snap.sessionId === "string" ? snap.sessionId : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 单个 chat 的 sessionId（两种格式各取轻路径，只读一个标量）。 */
function sessionIdOfChat(dataRoot, chatId) {
  const chatDir = path.join(dataRoot, "chats", chatId);
  if (fs.existsSync(path.join(chatDir, "blocks"))) {
    const st = readBlockDagState(dataRoot, chatId);
    return st && typeof st.sessionId === "string" ? st.sessionId : null;
  }
  if (fs.existsSync(path.join(chatDir, "snapshots"))) return readJournalSessionId(dataRoot, chatId);
  return null;
}

/**
 * sessions.json 未命中时的反查——复刻官方 resolveUsing（conversation-registry.js:83-118）
 * 的兜底覆盖面：枚举 chats/ 目录，读各 chat 的 sessionId 匹配。
 *   - 覆盖 publish 内 writeChat 与 updateLinks 之间的窗口、以及映射尚未建立的新会话首轮；
 *   - 只读一个标量字段（block：字段树下钻；journal：最新快照），比官方 readChat 读全量轻；
 *   - index.json 幽灵条目（目录不存在）天然跳过——枚举的是目录不是索引。
 */
function reverseLookupChatId(dataRoot, sessionId) {
  let names;
  try {
    names = fs.readdirSync(path.join(dataRoot, "chats"));
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith("chat-")) continue;
    if (sessionIdOfChat(dataRoot, name) === sessionId) return name;
  }
  return null;
}

const sessionChatCache = new Map(); // sessionId -> { chatId, at }
function chatIdForSession(sessionId) {
  const now = Date.now();
  const hit = sessionChatCache.get(sessionId);
  // 命中映射缓存 10s；未命中（新会话/竞态）只缓存 500ms，尽快重试
  const ttl = hit && hit.chatId ? SESSION_TTL_MS : 500;
  if (hit && now - hit.at < ttl) return hit.chatId;
  let chatId = null;
  const root = tavernDataRoot();
  if (root) {
    const map = tryReadJson(path.join(root, "sessions.json"));
    chatId = (map && typeof map === "object" && map[sessionId]) || null;
    if (!chatId) chatId = reverseLookupChatId(root, sessionId);
  }
  sessionChatCache.set(sessionId, { chatId, at: now });
  return chatId;
}

/**
 * 取子 Agent 的父会话 id（官方与 NA 都在 meta/header 上写 parentSession）。
 * 读不到返回 ''（不是子 Agent，或平台形态变化 → 退回会话自身 id）。
 */
function parentSessionOf(session) {
  try {
    if (!session || typeof session !== "object") return "";
    const meta = session.meta && typeof session.meta === "object" ? session.meta : {};
    const header = session.header && typeof session.header === "object" ? session.header : {};
    const value = meta.parentSession ?? header.parentSession ?? session.parentSession;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** 是否子 Agent（后台/独立后台）会话：origin==='subagent' 或有父会话或 id 含 background。 */
function isSubagentSession(session, sessionId) {
  try {
    const meta = session?.meta;
    const header = session?.header;
    if (meta?.origin === "subagent" || header?.origin === "subagent") return true;
  } catch {
    /* ignore */
  }
  if (parentSessionOf(session)) return true;
  return /background/i.test(String(sessionId || ""));
}

const switchCache = new Map(); // governingSessionId -> { allowed, disabled, at }
/**
 * 本会话的完整门禁状态：{ allowed, disabled }。
 *   - allowed：主开关（webSearchEnabled / card 恒放行 / fail 语义），语义同 v2；
 *   - disabled：本局「前台工具」被关闭的工具名集合（disabledForegroundTools 归一后）。
 * @param {string} sessionId 当前执行会话 id（前台即 chat 的 session；后台为 traceSession）
 * @param {object} [session] 会话对象（用于读 parentSession/origin，判定子 Agent 归属）
 *
 * 归属解析：子 Agent → 用**父会话**的开关（前后台/独立后台同一开关，不会分叉）；
 * 普通会话 → 用自身。
 *
 * 四层语义（与官方 visibleTools / assembleSystemPrompt 逐条对齐）：
 *   ① 环境异常（数据根解析不了/IO 异常）→ 沿用上次成功判定（latch，保缓存前缀
 *      稳定）；从没成功读到过 → 放行 + 无逐工具关闭。这是平台级故障，不是"无
 *      chat"语义——不因插件自身读取基础设施故障挂掉核心功能；
 *   ② 语义确定（有数据根，但查无绑定 chat / 状态读出为关）→ **立即 fail-closed**。
 *      官方 `visibleTools`：`chat === undefined → return []`（受控工具全灭，
 *      含 web_search）——本模块与官方同时刻、同形态地门禁，不存在分叉轮；
 *   ③ card 模式 → allowed=true 且 disabled 清空（官方 card 分支直接返回完整名单，
 *      既不受主开关也不受逐工具开关约束）；
 *   ④ 主开关开着时，disabled 交给上层逐工具消费；disabled 含 'web_search' 时
 *      上层按「主开关关」同形态处理（官方 web_search 该局不可见 = 本插件搜索
 *      工具全体不可见，见文件头 v2.1）。
 *
 * ⚠ latch 是缓存稳定性的关键：工具列表属于请求缓存前缀，"曾经成功读到"后
 * 单次读取异常若翻转判定，会让工具反复出现/消失、反复打穿前缀缓存。
 */
function gateStateFor(sessionId, session) {
  if (!sessionId) return { allowed: false, disabled: [] }; // 无 session → 官方 stateForSession('') → undefined → []
  // 子 Agent（官方后台 / 插件独立后台）按**父会话**的开关走：前后台与独立后台同一把开关，
  // 不会出现"前台关着、独立后台开着"的分叉；也顺带让官方后台跟随本局设置。
  const parent = parentSessionOf(session);
  const governingId = parent || sessionId;
  const now = Date.now();
  const hit = switchCache.get(governingId);
  if (hit && now - hit.at < STATE_TTL_MS) return { allowed: hit.allowed, disabled: hit.disabled };
  let result;
  const root = tavernDataRoot();
  if (!root) {
    // latch：沿用上次成功判定；从没成功读到过 → 放行 + 无逐工具关闭
    result = hit ? { allowed: hit.allowed, disabled: hit.disabled } : { allowed: true, disabled: [] };
    switchCache.set(governingId, { ...result, at: now });
    return result;
  }
  try {
    const chatId = chatIdForSession(governingId);
    if (!chatId) {
      // 无绑定 chat：子 Agent → 无法归属到任何本局 → 不干预（不误伤第三方独立后台）；
      // 普通会话 → 与官方 fail-closed 对齐（官方 visibleTools: chat undefined → []）。
      result = isSubagentSession(session, sessionId)
        ? { allowed: true, disabled: [] }
        : { allowed: false, disabled: [] };
    } else {
      const chatDir = path.join(root, "chats", chatId);
      const state = fs.existsSync(path.join(chatDir, "blocks"))
        ? readBlockDagState(root, chatId)
        : fs.existsSync(path.join(chatDir, "snapshots"))
          ? readJournalState(root, chatId)
          : null;
      if (state && typeof state === "object") {
        if (state.mode === "card") {
          result = { allowed: true, disabled: [] }; // 官方 card 分支不按 disabledForegroundTools 过滤
        } else {
          result = {
            allowed: state.webSearchEnabled === true,
            disabled: normalizeDisabledForegroundTools(state.disabledForegroundTools),
          };
        }
      } else {
        result = { allowed: false, disabled: [] }; // chat 在但读不出状态（存储损坏/格式缺失）→ 与官方对齐：关
      }
    }
  } catch {
    result = null; // 读取异常 → latch
  }
  if (result === null) {
    result = hit ? { allowed: hit.allowed, disabled: hit.disabled } : { allowed: true, disabled: [] };
  }
  switchCache.set(governingId, { ...result, at: now });
  return result;
}

/**
 * v2 兼容包装：本会话是否允许 web 搜索（主开关语义，不含逐工具维度）。
 * 诊断与旧调用方使用；运行期门禁一律走 gateStateFor。
 */
function searchAllowed(sessionId, session) {
  const gate = gateStateFor(sessionId, session);
  return gate.allowed;
}

/**
 * 诊断导出：供离线脚本核对开关真值（不参与运行期门禁逻辑）。
 * 用法：DSH_HOME=<harness 根> node -e "import('./search_switch.js').then(m=>...)"
 */
export const __debug = { tavernDataRoot, readBlockDagState, readJournalState, chatIdForSession, searchAllowed, gateStateFor, parentSessionOf, isSubagentSession };

// ─────────────────────────── 安装 ───────────────────────────

/**
 * 安装开关门禁（assembly 层 + 执行层）。任何异常都放行，绝不阻断请求链。
 * @param {{ on: Function, inject: Function, logger?: { info?: Function } }} ctx Cordis ctx（apply 的 ctx）
 * @param {object} [opts]
 * @param {{ info?: Function }} [opts.logger]
 * @param {string[]|(() => string[])} [opts.disabledTools] 用户在设置页停用的工具名。
 *   必须传**读取函数**（`() => current().disabledTools`）而非快照，否则保存后要重启才生效。
 * @param {boolean|(() => boolean)} [opts.webFetchEnabled] 是否对模型开放官方 web_fetch
 *   （默认关闭）。同样应传读取函数。读不到 → 视为关闭（fail-closed，见 guard 内注释）。
 */
export function installSearchSwitchGuard(ctx, { logger, disabledTools, webFetchEnabled } = {}) {
  if (!ctx || typeof ctx.on !== "function") return;

  /** 用户在设置页停用的工具集合。
   *  - 读的是 liveConfig（每次判定重新求值），故设置页保存后**立即生效**，无需重启；
   *  - 白名单过滤：只认 OWN_TOOLS 里的名字，配置出现陌生名字一律忽略，绝不误伤他插件；
   *  - 读取异常 → 视为"没有停用"，绝不因插件自身故障禁掉工具。 */
  const userDisabledSet = () => {
    try {
      const list = typeof disabledTools === "function" ? disabledTools() : disabledTools;
      if (!Array.isArray(list)) return new Set();
      return new Set(list.filter((n) => typeof n === "string" && OWN_TOOLS.includes(n)));
    } catch {
      return new Set();
    }
  };

  // ③ 官方 web_fetch 的独立开关（webFetchEnabled，默认关闭）。
  //    与前两套都不同：web_fetch 是**官方工具**，不属于 OWN_TOOLS（那是"本插件注册的工具"
  //    白名单），由设置页顶部的独立开关决定是否对模型开放；再叠加统一门禁（受本局
  //    webSearchEnabled 约束），与那 9 个工具同一把开关。
  //
  //    ⚠ fail-closed（读不到配置 → 视为关闭），与本模块其余路径的 fail-open 相反：
  //      前者管的是"别把用户已有的核心搜索功能弄丢"，放行最坏只是工具多几个；
  //      这里管的是"要不要给模型开一个无限制外网读取口"，配置读取故障若放行等于
  //      在用户不知情的情况下把口子敞开，安全方向上必须默认关闭。
  //      这条不对称是刻意的，别当成 bug"修"回 fail-open。
  const webFetchOpen = () => {
    try {
      if (typeof webFetchEnabled === "function") return webFetchEnabled() === true;
      return webFetchEnabled === true;
    } catch {
      return false;
    }
  };

  // ① assembly 层：本插件钩子后注册（内层）→ pre 阶段原地修改，经瀑布链向外传播，
  //    tavern 的 post 阶段过滤只减不增，移除生效。tools 不进请求，模型根本看不到。
  //    缓存稳定性：用户未停用任何工具 且 官方开关开 且 本局前台工具无关闭 → remove
  //    为空 → **零触碰** assembly.tools，请求体与没有本插件时逐字节一致（沿用既有不变量）。
  ctx.on("system-prompt/assemble", async function (assembly, context, next) {
    try {
      const tools = assembly && Array.isArray(assembly.tools) ? assembly.tools : null;
      if (tools) {
        const remove = new Set(userDisabledSet()); // ① 用户逐工具停用（与官方开关无关）
        const session = context && context.agent && context.agent.session;
        const sessionId = session && session.id;
        // 只有 web_fetch **真的在场**时才动它：不在场就不必重建数组，保住"零触碰"不变量
        //（DSHT 默认 tool-web fetch:false 时它压根不在工具列表里）。
        const webFetchPresent = tools.some((t) => t && t.name === WEB_FETCH_TOOL);
        if (webFetchPresent && !webFetchOpen()) remove.add(WEB_FETCH_TOOL); // ③ 网页抓取开关关
        if (sessionId) {
          const gate = gateStateFor(sessionId, session);
          // ② 官方「联网搜索」关 或 本局前台工具关掉了 web_search → 官方 web_search
          //    该局不可见，全体 GATED_TOOLS + web_fetch 同刻移除（v2.1 对齐语义）。
          const gateAll = !gate.allowed || gate.disabled.includes("web_search");
          if (gateAll) {
            for (const name of GATED_TOOLS) remove.add(name);
            // 统一门禁不留例外：联网关时 web_fetch 一并从列表移除
            if (webFetchPresent) remove.add(WEB_FETCH_TOOL);
          } else {
            // ④ 本局前台工具逐工具开关：只移除被点名关闭的工具（面板「插件/扩展」条目生效）
            for (const name of GATED_TOOLS) {
              if (gate.disabled.includes(name)) remove.add(name);
            }
            if (webFetchPresent && gate.disabled.includes(WEB_FETCH_TOOL)) remove.add(WEB_FETCH_TOOL);
          }
        }
        if (remove.size > 0) assembly.tools = tools.filter((t) => !(t && remove.has(t.name)));
      }
    } catch {
      /* 守卫失败 → 原样放行 */
    }
    return next(assembly);
  });

  // ② 执行层：官方 tools.guard——否决调用并告知原因（assembly 被绕过时的兜底）。
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      if (typeof sctx.tools?.guard !== "function") return () => {};
      const dispose = sctx.tools.guard((exec) => {
        try {
          const name = exec && exec.name;
          if (typeof name !== "string") return undefined;
          if (name === WEB_FETCH_TOOL) {
            if (!webFetchOpen()) {
              logger?.info?.("web_fetch denied (tool switch off)");
              return WEB_FETCH_DENY_REASON;
            }
            // 开关开着也要服从本局联网搜索开关与前台工具逐工具开关（统一门禁不留例外）
            const wfSession = exec.agent && exec.agent.session;
            const wfSid = wfSession && wfSession.id;
            if (wfSid) {
              const gate = gateStateFor(wfSid, wfSession);
              if (!gate.allowed || gate.disabled.includes("web_search")) {
                logger?.info?.("web_fetch denied (webSearchEnabled off / web_search disabled this chat)");
                return DENY_REASON;
              }
              if (gate.disabled.includes(WEB_FETCH_TOOL)) {
                logger?.info?.("web_fetch denied (disabled in this chat's foreground tools)");
                return PER_CHAT_DENY_REASON;
              }
            }
            return undefined;
          }
          // 用户停用优先判定（与官方开关正交：即使开关开着，停用也照停）
          if (userDisabledSet().has(name)) {
            logger?.info?.("tool switch: denied " + name + " (disabled in plugin settings)");
            return USER_DENY_REASON;
          }
          if (!GATED_TOOLS.includes(name)) return undefined;
          const session = exec.agent && exec.agent.session;
          const sessionId = session && session.id;
          if (!sessionId) return undefined; // 无 session 的执行路径（非 DSHT 回合）不干预
          const gate = gateStateFor(sessionId, session);
          if (!gate.allowed || gate.disabled.includes("web_search")) {
            // 主开关关 或 本局前台工具关了 web_search → 与官方 web_search 同刻不可见
            logger?.info?.("search switch: denied " + name + " (webSearchEnabled off / web_search disabled this chat)");
            return DENY_REASON;
          }
          if (gate.disabled.includes(name)) {
            logger?.info?.("search switch: denied " + name + " (disabled in this chat's foreground tools)");
            return PER_CHAT_DENY_REASON;
          }
          return undefined;
        } catch {
          return undefined;
        }
      });
      return () => {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      };
    }, "free-search: web search switch guard");
  });
}
