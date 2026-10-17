/**
 * dsh-free-search-fork-for-dsht 路径解析 —— 全插件唯一真相源
 *
 * 立身之本（三不原则，与 narrative-anchor/lib/paths.js 同源）：
 *  1. 不写盘符：源码内不出现任何以盘符开头的路径字面量；
 *  2. 不写用户主目录：不臆造 ~/.dsh、「大概在这个位置」的猜测路径。
 *     历史教训（本 fork 亲历）：曾用 os.homedir() 兜底 ~/.dsh，而本机
 *     ~/.dsh 下并没有 profile-data —— 该兜底恒失效，配置被写去了错误位置；
 *  3. 不猜层级：不写 dirname(dirname(dirname(x))) 这种"上溯 N 级"的脆弱推导。
 *
 * 取而代之的是**结构发现**：路径全由运行时上下文推导，拼接一律走 node:path，
 * 因此 Windows / macOS / Linux 行为一致，开发目录与正式安装位置行为也一致。
 *
 * DSHT 目录结构（相对 DataDirectory）：
 *   <InstallRoot>/launcher-settings.xml            ← 真相源，含 <DataDirectory>
 *   <DataDir>/harness/settings.yaml                ← harness 根（遗留配置段所在）
 *   <DataDir>/harness/profile-data/tavern/data     ← 用户数据根
 *
 * ⚠️ 关键：DSH_HOME 的官方语义是 **harness 根**，不是数据根 —— 必须再拼
 *    profile-data/tavern/data 才是用户数据根（见官方 tavern-plugin 的
 *    resolveTavernDataRoot）。本 fork 早期版本直接把 DSH_HOME 当数据根用，
 *    导致 config.json 落到 <harness>/plugin-data/ 而非
 *    <dataRoot>/plugin-data/，配置不随 profile-data 备份迁移。已修正。
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "dsh-free-search-fork-for-dsht";

// ── 结构常量：只描述"形状"，不含任何具体位置 ──
const INSTALL_SETTINGS_FILE = "launcher-settings.xml";
const SETTINGS_DATA_DIR_KEY = "DataDirectory";
// 用户数据根的尾部结构：<X>/profile-data/tavern/data
const TAVERN_TAIL_SEGMENTS = ["profile-data", "tavern", "data"];
// 相对 DataDirectory 时，前面还要加 harness
const DATA_ROOT_SEGMENTS = ["harness", ...TAVERN_TAIL_SEGMENTS];
const DATA_ROOT_MARKER = ["resources", "cards"];
const PLUGIN_DATA_SEGMENTS = ["plugin-data", PLUGIN_NAME];
const MAX_UPWARD_DEPTH = 12;
const MAX_SIBLING_SCAN = 64;

let pluginRootCache = "";
let dataRootOverride = "";
let dataRootCache = "";
let dataRootResolved = false;
let dataDirCache = "";
let pluginDataDirCache = "";

function tryReadFile(path) {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function tryReadJson(path) {
  const raw = tryReadFile(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isDir(path) {
  if (!path) return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 插件根：含本插件 package.json 的目录（import.meta.url 上溯，跨平台）。 */
export function pluginRoot() {
  if (pluginRootCache) return pluginRootCache;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = tryReadJson(join(dir, "package.json"));
    if (pkg && pkg.name === PLUGIN_NAME) {
      pluginRootCache = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 回退：本文件位于 <插件根>/lib/ 之下，上一级即插件根
  pluginRootCache = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return pluginRootCache;
}

/** 运行时注入用户数据根。空值不覆盖已有解析。 */
export function setTavernDataRoot(path) {
  const value = String(path || "");
  if (!value) return;
  dataRootOverride = value;
  if (dataRootCache !== value) {
    dataRootCache = value;
    dataRootResolved = true;
  }
}

/** 数据根合法性校验：必须是 DSHT 用户数据根（含 resources/cards）。 */
function isRealDataRoot(candidate) {
  return !!candidate && isDir(join(candidate, ...DATA_ROOT_MARKER));
}

/** 读 DSHT 安装根的 launcher-settings.xml，取它自己声明的 DataDirectory。 */
function readDataDirectory(installRoot) {
  const raw = tryReadFile(join(installRoot, INSTALL_SETTINGS_FILE));
  if (!raw) return "";
  const match = new RegExp("<" + SETTINGS_DATA_DIR_KEY + ">([^<]+)</" + SETTINGS_DATA_DIR_KEY + ">", "i").exec(raw);
  if (!match) return "";
  const value = match[1].trim();
  if (!value) return "";
  // 相对路径按安装根解析（DSHT 写的是绝对路径，但不假设它一定如此）
  return isAbsolute(value) ? value : resolve(installRoot, value);
}

/** 在某一层目录上，按结构直接拼出候选数据根。 */
function dataRootAt(dir) {
  const candidates = [
    join(dir, ...DATA_ROOT_SEGMENTS), // dir 是 <DataDir>
    join(dir, "profile-data", "tavern", "data"), // dir 是 harness 根
    join(dir, "tavern", "data"), // dir 是 profile-data
    join(dir, "data"), // dir 是 tavern
  ];
  for (const candidate of candidates) {
    if (isRealDataRoot(candidate)) {
      // 反推 <DataDir>：从数据根向上退 DATA_ROOT_SEGMENTS 的层数
      let dd = candidate;
      for (let i = 0; i < DATA_ROOT_SEGMENTS.length; i++) dd = dirname(dd);
      return { dataRoot: candidate, dataDir: dd };
    }
  }
  return null;
}

/** 在某一层目录及其直接子目录中，发现 DSHT 安装根并取得数据根。 */
function discoverAt(dir) {
  const settings = join(dir, INSTALL_SETTINGS_FILE);
  if (existsSync(settings)) {
    const dataDir = readDataDirectory(dir);
    if (dataDir) {
      const candidate = join(dataDir, ...DATA_ROOT_SEGMENTS);
      if (isRealDataRoot(candidate)) return { dataRoot: candidate, dataDir };
    }
  }
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (++scanned > MAX_SIBLING_SCAN) break;
    const sub = join(dir, entry.name);
    const dataDir = readDataDirectory(sub);
    if (!dataDir) continue;
    const candidate = join(dataDir, ...DATA_ROOT_SEGMENTS);
    if (isRealDataRoot(candidate)) return { dataRoot: candidate, dataDir };
  }
  return null;
}

/** 从一个起点向上遍历，逐级尝试发现数据根。 */
function searchUpward(start) {
  if (!start) return null;
  let dir = start;
  for (let i = 0; i < MAX_UPWARD_DEPTH; i++) {
    const found = discoverAt(dir) || dataRootAt(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 结构发现用的起点：插件根 → 进程 cwd。 */
function startPoints() {
  const ordered = [pluginRoot()];
  try {
    if (process.cwd()) ordered.push(process.cwd());
  } catch {
    /* 无 cwd 时不加 */
  }
  return ordered;
}

/** 环境变量里的 DSH home。DSHT 进程内 launcher/updater 会注入 DSH_HOME。 */
function envHomes() {
  const env = (typeof process !== "undefined" && process.env) || {};
  return [env.DSH_TAVERN_DATA_DIR, env.DSH_HOME]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
}

/** DSH home → 候选数据根。
 *  官方语义：DSH_HOME = **harness 根** → join(home,'profile-data','tavern','data')。
 *  也可能是 DataDirectory → join(home,'harness','profile-data','tavern','data')。两种都试。 */
function candidatesFromHome(home) {
  return [
    { dataRoot: join(home, ...TAVERN_TAIL_SEGMENTS), dataDir: dirname(home) },
    { dataRoot: join(home, ...DATA_ROOT_SEGMENTS), dataDir: home },
  ];
}

/** 解析 DSHT 用户数据根（…/harness/profile-data/tavern/data）。解析不到返回 null。
 *
 * 优先级：① 显式配置 tavernDataRoot → ② DSH_HOME（官方机制，harness 根）
 *          → ③ 结构发现（launcher-settings.xml / 目录结构探测）
 *
 * 失败时**不**标记为已解析，允许后续调用重试 —— 否则首次失败会把空结果固化。
 */
export function resolveTavernDataRoot() {
  if (dataRootResolved) return dataRootCache || null;

  // ① 显式配置
  if (dataRootOverride && isRealDataRoot(dataRootOverride)) {
    dataRootCache = dataRootOverride;
    dataRootResolved = true;
    return dataRootCache;
  }

  // ② 官方机制：DSH_HOME
  for (const home of envHomes()) {
    for (const candidate of candidatesFromHome(home)) {
      if (isRealDataRoot(candidate.dataRoot)) {
        dataRootCache = candidate.dataRoot;
        dataDirCache = candidate.dataDir;
        dataRootResolved = true;
        return dataRootCache;
      }
    }
  }

  // ③ 结构发现
  for (const start of startPoints()) {
    const found = searchUpward(start);
    if (found) {
      dataRootCache = found.dataRoot;
      dataDirCache = found.dataDir;
      dataRootResolved = true;
      return dataRootCache;
    }
  }

  // 显式配置即便校验未过也照用（尊重用户），但不标记已解析，下次仍可重试
  if (dataRootOverride) {
    dataRootCache = dataRootOverride;
    return dataRootCache;
  }
  return null;
}

/** 用户数据根（与 resolveTavernDataRoot 同义，语义更直白）。 */
export function tavernDataRoot() {
  return resolveTavernDataRoot();
}

/** DSHT 数据目录（launcher-settings.xml 里的 DataDirectory）。拿不到时由数据根反推。 */
export function installDataDir() {
  const root = resolveTavernDataRoot();
  if (!root) return "";
  if (dataDirCache) return dataDirCache;
  let dd = root;
  for (let i = 0; i < DATA_ROOT_SEGMENTS.length; i++) dd = dirname(dd);
  dataDirCache = dd;
  return dd;
}

/** harness 根（<DataDir>/harness）—— 遗留 settings.yaml 所在处。
 *  注意：它**不是**数据根，别拿它当数据根用（那正是本 fork 曾经踩的坑）。 */
export function harnessRoot() {
  const envHome = String((process.env && process.env.DSH_HOME) || "").trim();
  if (envHome && isDir(envHome)) return envHome;
  const dataDir = installDataDir();
  return dataDir ? join(dataDir, "harness") : "";
}

/** 插件自持数据目录。用户数据区优先，解析不到时回退插件根下 data/。
 *
 * **只在解析成功时缓存** —— 否则模块顶层首次调用若赶上解析失败（如 DSH_HOME
 * 未就绪），会把回退位置固化，之后再纠正不回用户数据区。 */
export function pluginDataDir() {
  if (pluginDataDirCache) return pluginDataDirCache;
  const root = resolveTavernDataRoot();
  if (root) {
    const target = join(root, ...PLUGIN_DATA_SEGMENTS);
    if (ensurePluginDataDir(target)) {
      pluginDataDirCache = target;
      return target;
    }
  }
  const fallback = join(pluginRoot(), "data");
  try {
    mkdirSync(fallback, { recursive: true });
  } catch {
    /* 只读安装位置：忽略 */
  }
  return fallback;
}

function ensurePluginDataDir(target) {
  try {
    if (isDir(target)) return true;
    mkdirSync(target, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** 测试/热重载用：清空路径缓存，下次调用重新解析。 */
export function resetPathCache() {
  pluginRootCache = "";
  dataRootCache = "";
  dataRootResolved = false;
  dataDirCache = "";
  pluginDataDirCache = "";
}
