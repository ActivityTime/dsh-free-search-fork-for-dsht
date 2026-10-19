# 更新日志

本文件随每次发布追加一条，记录该次推送的变更项。

> **关于版本号**：本仓库为 `dsh-free-search` 的 **DSHT（DeepSeek Harness Tavern）适配 fork**，
> 不再追踪上游 DDDMUC/dsh-free-search，故版本号独立演进，与上游无对应关系。

## 2026-10-19（web_fetch 兜底工具注册）

### 修复

- **DSHT 下 `web_fetch` 工具不存在**：DSH 0.2 的 `web_fetch` 由核心按 preset 的
  `tool-web: { fetch }` 决定是否注册（`dsh-tool-web/lib/index.js`：`if (resolved.fetch) applyWebFetchTool(...)`），
  而 DSHT 两个 preset（`preset-tavern` / `preset-tavern-background`）均为 `fetch: false`，
  且 0.2.0-rc.2 起 tool-web 行从 host 平面挪进 preset 声明（host 平面恢复会同 preset 行冲突，
  旧版靠 profile patch `- id: tool-web {fetch:true}` 打开的路已不成立）→ 核心的 web_fetch
  在 DSHT 里根本不注册。本插件提示词一直在教模型调用 web_fetch、fetchProvider 接管
  （`fs-quality-fetch`）也已就位，唯独缺工具壳。
  - 核心未注册时，插件**按名注册同名兜底工具**（`lib/index.js`，multi_search 注册块后）：
    `ctx.inject(["tools","web"])` + `sctx.tools.get("web_fetch")` 检测，`fetch:true` 环境
    （标准 DSH）跳过，不双注册；
  - schema / execute 与核心 `applyWebFetchTool`（dsh-tool-web:730-818）**逐行同构**：
    execute 只调 `ctx.web.fetch` 官方 seam，抓取逻辑零重写，实际执行者为当前 fetchProvider
    （默认 `fs-quality-fetch` 质量链 direct → 无头浏览器 → exa → firecrawl → crawl4ai）；
  - render 走本插件既有 `<untrusted-web-content>` 安全边界（防提示注入）；
  - `timeoutMs: 120000`（核心 30s；本插件质量链内部预算 60s/120s，工具预算须不小于链预算）；
  - **同名使现有门禁自动接管**：`search_switch.js` 的 `WEB_FETCH_TOOL` 在设置页「网页抓取工具」
    开关关闭时 assembly 层按名移除 + 执行层按名否决，无需第二套逻辑；
  - 上游 dsh-free-search 0.9.5 亦不自注册 web_fetch（假设标准 DSH `fetch:true`）——此为
    fork 相对上游的差异，README §2 已记。

### 变更

- 版本号 `0.9.1-local.2` → `0.9.1-local.3`。
- README §2「web_fetch 只做开关管控，零重写」与 Q&A「DSHT 的 web_fetch 去哪了」更正为
  描述兜底注册机制；`lib/index.js` 中引用旧 profile patch 机制的过期注释同步更新。

## 2026-10-19（web_search / web_fetch 接管适配 DSH 0.2）

### 修复

- **接管逻辑适配 DSH 0.2.1-rc.2 的 provider 选择机制**（对齐上游 dsh-free-search 0.9.5）：
  DSH 0.2 起 `ctx.web` 的 provider 选择收进 config 的 volatile ref
  （`config.searchProvider` / `config.fetchProvider`），**只能通过 `settings.mutate` 写入**；
  0.1.x 的 `searchProviderId` / `fetchProviderId` 运行时属性已删除。原实现写死属性 →
  无人读取 → 日志谎报 "taking over" 但搜索/抓取实际仍走官方 `deepseek-official` / `http`。
  - `providerSelection` 双形态探测：`web.config[key]` 为带 `.get()` 的 ref 时走 rc.2+ 路径，否则回落旧属性；
  - 接管写入合并为**一次** `settings.mutate("web", ops)`（同 tick 两次 mutate 第二次会被设置文档版本号顶掉），
    且置于 `ctx.inject(["settings"])` 内——apply 期间 settings 未挂载，直接读 ref 永远拿不到；
  - `registerOnce` 幂等注册（吞 `WEB_DUPLICATE_PROVIDER` 复用）+ `appliedContexts` 防同 ctx 重入；
  - `settings/document-updated` 监听 `web` ns 记诊断日志（provider 写入会重建 web 服务并令插件重新 apply）。
- **不动 bundle patch**：静态 `- id: web` 行在插件被禁用/跳过时会留下悬空引用
  （上游 issue #51：`configured web provider "ddg" is not registered` → 所有 web 搜索全挂），
  运行时接管可优雅降级。

### 变更

- 版本号 `0.9.1-local.1` → `0.9.1-local.2`。

## 2026-10-19（发布合规修正）

### 修复

- **`files` 补两个被实际 import 的模块** `lib/paths.js`、`lib/proxy.js`
  （`cache.js`、`fetch_provider.js`、`fetch_upstream.js` 均 import）。此前白名单漏列，
  发到 npm 会直接 `MODULE_NOT_FOUND`。另补入 `README.md`、`LICENSE`。
- **`peerDependencies` 补 `@deepseek-ai/dsh-client-ui-slots`** —— 它在 `dsh.client.inject`
  中声明却未进 peer，属漏声明。
- **`dsh-better-sidebar` peer 由写死的 `0.19.1` 放宽为 `>=0.19.1`** —— 写死旧版会在装
  0.28.x 的 DSHT 上判定版本不兼容。
- **`dsh.compatibility.dshReleases` 补 DSH 0.2**：`0.2.0-rc.1`、`0.2.1-rc.2`（原先只列到 0.1.7-rc.1）。

### 新增

- **`devDependencies` 全量补齐**，覆盖全部 10 个 peer（官方规范要求 dsh 包 peer+dev 双声明），
  dev 版本对齐 runtime 0.2.1-rc.2。

### 文档

- README 安装章节改为准确表述：`dsh plugin add` 与 `data/plugins/` 投放**都是官方标准**，
  前者用于其他 DSH 扩展、后者用于 Tavern 插件；并补 junction 不可用、中文路径下
  `pnpm install` 会静默跳过 `link:` 依赖等实操注意。

## 2026-10-18 · DSHT 适配版首发（v0.9.1）

### 适配声明

- 基于 `dsh-free-search` 的独立 fork，**专为 DSH-Tavern 适配**，不再追踪上游。
- npm 版本检查与自更新命令已重定向，**永不拉取上游包**（避免被上游覆盖导致适配失效）。
- 默认配置（`cordis.patch.yml`）已固化为单机验证过的调优结果，与运行时 `config.json` 逐字一致。

### 适配要点（相对上游的关键改动）

- **联网搜索开关统一门控**：9 个搜索工具 + 官方 `web_fetch` 统一受本局「联网搜索」开关管，
  与官方 `web_search` 同一把钥匙；后台任务按父会话开关继承，不单独处理。
- **抓取修复**：
  - 无头浏览器档超时 25s → 60s（实测重资源站点需 31–53 秒）；
  - direct 档不继承 Windows 系统代理，已显式补全。
- **代理治理**：默认代理「填一次全部生效」，补齐此前漏注入的出网点；国内 4 引擎
  （Baidu / Kimi / 阿里 / 豆包）强制直连。
- **侧栏设置入口**：接入 `dsh-better-sidebar`（v0.19.1），设置卡在右侧栏独立 Tab 渲染。
- **`legacyYamlMigrated`**：旧版 `settings.yaml` `free-search:` 段的一次性迁移标记，
  仅作去重用，不影响功能；本仓库默认 `false`（无旧配置则不迁移）。

### 已固化默认配置（摘要）

- provider：auto（单引擎按 fallbackOrder 失效自动换下一个）
- 工具开关：默认仅开 `research` + `cache_search`
- 官方 `web_fetch`：默认关闭
- 并发：单次最多 6 引擎、至少 2 个有效来源
- SearXNG 实例：`https://search.mectov.my.id`；引擎列表按用户设置页实际勾选固化
- Bing 走 `ja-JP` 市场
