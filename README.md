# dsh-free-search —— DSHT 适配版（DeepSeek Harness Tavern）

> **⚠ DSHT 适配 fork 声明**
> 本仓库是 [`dsh-free-search`](https://github.com/DDDMUC/dsh-free-search) 的 **DSH-Tavern（DeepSeek Harness Tavern）适配 fork**，**不再追踪上游** DDDMUC/dsh-free-search。
> - npm 版本检查已重定向到本 fork 自有包名，**永不拉取上游包**（见 `lib/index.js` 的 `NPM_REGISTRY_URL`）；
> - 全部代理 / 联网 / 引擎配置走本插件设置页，默认配置已固化为单机验证过的调优结果；
> - 适配要点与变更记录见 [CHANGELOG.md](./CHANGELOG.md)。
>
> **仅适用于 DSH-Tavern 环境，非 DSH-Tavern 请勿直接使用此 fork。**

---

## 这是什么

给 DSH-Tavern 增加**免费多引擎联网搜索**的插件：注册进 `ctx.web` seam，提供 `web_search` 及 9 个配套工具，无需 API key 即可使用 24 个引擎（Bing / DuckDuckGo / AnySearch / SearXNG / Exa / Tavily / Keenable / Firecrawl / Parallel 免 key；Zhihu 走 MCP；Perplexity / SerpBase / DeepSeek / You.com / Baidu / Kimi / Aliyun / Doubao 带 key；OpenAI / Gemini / Claude 模型内置搜索仅显式调用），带自动智能路由、引擎启停与回退优先级、可编辑中英文分池、multi 并行模式、失败感知回退、时间过滤、平台/域名搜索、`web_fetch` 网页抓取。

**开箱即用**：默认配置已针对本环境调优，安装后即可在「工作台制卡」时联网检索、补充作品信息，无需额外配置（详见下文「开箱即用」章节）。

**本 README 不重复上游文档**。下文只讲清楚「这个 fork 相对上游改了什么、为什么、对你意味着什么」——这也是它与原版最不同的地方。

---

## ⭐ 与上游 DDDMUC/dsh-free-search 的核心差异（本 fork 重点）

### 1. 联网开关统一门控（9 工具 + web_fetch 一把钥匙）

上游的搜索工具与官方 `web_search` 由不同的开关逻辑控制，容易「开了联网却仍有工具能搜 / 关了联网却仍有工具漏网」。

本 fork 把所有本插件工具（含官方 `web_fetch`）统一收口到 **DSHT 本局「联网搜索」开关**，与官方 `web_search` **同一把钥匙**（开/关行为完全一致）：

- 读开关真值 → `system-prompt/assemble` 阶段移除受控工具（与官方 gate 自家 `web_search` **同一层**）→ 执行层 `ctx.tools.guard` 否决任何绕过 assembly 的调用；
- **fail-closed 与官方一致**：解析不到 chat 状态（无映射且反查未命中）= 门禁，不会与官方分叉放行；
- `card` 模式恒放行（与官方不 gate card 一致）；独立后台 / 子 Agent 按父会话开关。

> 这解决了上游「多工具、多套开关、行为不统一」的痛点，让「关联网 = 全静默」成为可预期的硬保证。

### 2. web_fetch 只做开关管控，零重写

`web_fetch` 是 DSHT **官方 web 工具包**提供的工具（抓取你指定的那个网址正文，而非 `web_search` 的片段）。上游某些版本会重新实现它，本 fork **不重写**——只把它纳入第 1 点的开关门控。默认关闭，避免跑团对话被无关网页内容带偏。

### 3. 网页抓取质量链修复（DSHT 环境实测）

原抓取链在 DSH-Tavern 实际环境踩了两个坑，已修复：

- **超时过短**：无头浏览器档上调至 **60s**、整体抓取至 **120s**。实测重资源站点加载需 31–53s，原 25s 上限会过早中断；
- **直连链路不受代理影响**：质量链的 `direct → 无头浏览器 → exa → firecrawl → crawl4ai` 此前**完全不走「每源代理」设置**（`node:https` 无代理能力），导致需要代理才能达境外的 exa/firecrawl 等源静默失败。现已支持走**工具级代理隧道**（`proxyByTool`）。

### 4. 代理治理：填一次，全生效

上游的代理是「三层逐个配」，容易漏、容易配错。本 fork 改为：

- **默认代理（一处配置，全工具生效）**：在默认代理框填一个地址即覆盖本插件所有出网点（统一 `dispatcherFor` 注入，全工具出网共用同一解析入口）；
- **补齐漏注入的出网点**：此前有多个出网点（如 SearXNG）未接入代理，已逐一补齐；
- **境内引擎默认直连**：Baidu / Kimi / 阿里 / 豆包 始终直连——给境内 API 套代理只会更慢更易失败，设置页已明确提示不应为其配代理。

> 代理分三组，互不干扰：
> - **默认代理**：一个地址覆盖全部工具（最省事）；
> - **每源代理**：仅作用于「多源 / 高级 / 测试 / 视频」四个搜索工具的**引擎层**；
> - **工具级代理**：覆盖不经过引擎层的四条直连链路（平台直查 / 垂直领域 / 深度研究 / 天气），未填则自动复用「每源代理」地址。

### 5. 默认代理改为显式勾选（可保存为空）

上游默认代理框存在空值回落 bug：清空后保存会偷偷回落到「每源/工具级代理」的地址，永远存不空。

本 fork 用**独立勾选框**表达启用与否（与「联网搜索」开关同一模式）：
- 勾选 + 有地址 → 全部走该代理；
- 勾选 + 地址留空 → 复用下方两组的地址（保留便利）；
- **取消勾选 → 真清空，全部直连**（不会偷偷换成别的地址）。

### 6. 默认配置固化（安装即带验证过的调优）

插件包内的 `cordis.patch.yml` 是**默认配置种子**，逐字固化了单机验证过的运行时配置（引擎池、回退顺序、代理、工具开关等）。

> **生效范围说明（重要）**：插件包内的 `cordis.patch.yml` 是默认配置种子。通过 **`dsh plugin add`（方式二）注册时，本插件声明了 `dsh.bundle`，安装器会把这份 patch 注册为配置层，26 个调优字段直接生效**——这是推荐路径，无需额外操作。若改走 `plugins/` 文件夹投放（方式二 / 社区通用写法），初始配置取插件 `Config` schema 的通用默认值（非这套调优种子），想用调优值可在设置页把 `cordis.patch.yml` 的字段照搬过去。运行时配置持久化在 `<data>/plugin-data/dsh-free-search-fork-for-dsht/config.json`，任何设置改动都会覆盖种子。

### 7. 不再追踪上游，独立维护

- npm 版本检查指向本 fork 自有包名 `dsh-free-search-fork-for-dsht`（`lib/index.js` 的 `NPM_REGISTRY_URL`），**不会误报上游更新**；
- GitHub 仓库独立维护，不再合并 DDDMUC/dsh-free-search 的上游 PR。

---

## 安装（DSH-Tavern）

DSH-Tavern 的插件安装有两套都受框架支持的方式，按 DeepSeek Harness 官方文档（bundle plugin / repository plugin）与 DSHT 实际实现分为：

- **① 标准方式 `dsh plugin add`**（官方文档定义的 **bundle plugin** 安装法）：底层转发 pnpm，**自动装好 node 依赖**、并把插件 `cordis.patch.yml` 注册为配置层，安装后重启 DSH 生效；
- **② 文件夹扫描投放**（DSHT fork 在 `tavern-plugin/lib/domain/user-plugins.js` 实现的 `scanUserPlugins`）：把文件夹放进 `<data>/plugins/` 即自动注册——社区讨论区 #233 Knock Knock 用的就是它。但此路径**不调 pnpm、不挂 seed**，本插件需手动 `pnpm install` 依赖一次。

两种方式**默认配置都生效、无例外**（见「开箱即用」）。因文件夹投放需手动装依赖，本 README 把能自动装依赖的 `dsh plugin add` 列为推荐。

### 方式一（推荐，开箱即用）：`dsh plugin add`

在 **DSH 终端**执行（桌面版：设置 → 通用设置 → 打开 DSH 终端），profile 固定为 `tavern`：

```bash
# 从 GitHub 安装（推荐，依赖自动安装）
dsh plugin --profile tavern add github:ActivityTime/dsh-free-search-fork-for-dsht

# 从本地绝对路径安装（file: 形式，依赖同样自动安装）
dsh plugin --profile tavern add file:/绝对路径/dsh-free-search-fork-for-dsht

# 本地开发符号链接（link: 形式，不复制、需手动 pnpm install 一次）
dsh plugin --profile tavern add link:/绝对路径/dsh-free-search-fork-for-dsht

# 从 Release tarball 安装（离线 / 网络受限）
dsh plugin --profile tavern add /path/to/dsh-free-search-fork-for-dsht-0.x.x.tgz
```

- `github:` / `.tgz` 形式底层转发 pnpm，**自动装好 `@deepseek-ai/schemastery`、`undici`**；
- 包声明了 `dsh.bundle`，安装器把内置 `cordis.patch.yml`（26 字段调优种子）注册为配置层直接生效——**即开箱即用，无需手改任何 patch**；
- 安装后**完全重启 DSH**（桌面版退出重进）即生效；web 端可 `Ctrl+F5` 刷新一次。

> `file:` 与 `github:` / `.tgz` 同为 pnpm 标准源，**自动装好依赖**；只有 `link:` 开发符号链接模式不复制文件、需先在插件目录 `pnpm install` 一次。`github:` 形式要求本仓库已推送到 GitHub 且公开可读；尚未推送时请用 `file:` / `link:` 本地路径或先推送。

验证（无需启动宿主）：

```bash
dsh --profile tavern --dump-config   # 应出现 "# == dsh-free-search-fork-for-dsht" 层
```

卸载：

```bash
dsh plugin --profile tavern remove dsh-free-search-fork-for-dsht
```

### 方式二（社区通用写法）：`<data>/plugins/` 文件夹投放

把插件文件夹直接放进 Tavern 数据目录的 `plugins/` 下、**完全重启 DSH** 即可——DSH 会自动扫描、注册并写 patch 条目（见 `tavern-plugin/lib/domain/user-plugins.js`）。这正是社区插件 Knock Knock（讨论区 #233）的安装方式。

桌面版路径：读 `launcher-settings.xml` 的 `<DataDirectory>`，放到
`<DataDirectory>/harness/profile-data/tavern/data/plugins/dsh-free-search-fork-for-dsht/`。

| 宿主 | `<data>/plugins/<插件文件夹>` |
|---|---|
| **desktop** | `<DataDirectory>/harness/profile-data/tavern/data/plugins/` |
| **cli** | `~/.dsh-tavern/profiles/tavern/data/plugins/`（`DSH_TAVERN_CLI_HOME` 可覆盖） |
| **android** | 系统 DSH 数据目录下的 `profiles/tavern/data/plugins/` |

> ⚠ **对本插件**，纯文件夹投放还有一个额外步骤（社区里多数简单插件无此问题）：
> 1. **依赖不会自动安装**：扫描逻辑不调用 pnpm，必须先在该文件夹里手动 `pnpm install` 还原 `dependencies`，否则启动报 `MODULE_NOT_FOUND`。
>
> 至于**默认配置**：无需手动配。本插件已把 26 字段调优**烘焙进 `Config` 的 schema 默认值**（单一真相源 `DEFAULT_CONFIG`，见 `lib/index.js`）；文件夹投放只取 schema 默认，解析出的配置就是这套调优值——`dsh plugin add` 走 bundle seed 也得到同一套。两种装法**默认配置完全一致、无例外**。

### 桌面版（Desktop）要点

- 从 **DSH 终端**执行 `dsh` 命令，不要在系统 PowerShell / cmd 直接跑：桌面版 `dsh` 与 `DSH_TAVERN_HOST=desktop` 上下文由 DSH Terminal 提供；
- profile 名是 **`tavern`**（通用 DSH 多为 `web`）；
- `<data>` 取自 `launcher-settings.xml` 的 `<DataDirectory>`，一切路径以它派生为准，勿用 `~/.dsh` 等猜测路径。

---

## 开箱即用（工作台制卡场景）

本插件**安装即生效、无需任何配置**即可在 **工作台制卡** 时联网检索、补充作品信息：

- **默认配置在任何安装方式下都生效，不存在例外**：`dsh plugin add` 走 bundle seed、`<data>/plugins/` 文件夹投放只取 schema 默认——二者解析出的配置都是同一套「单一真相源 `DEFAULT_CONFIG`」（26 字段，含本机代理与国内 SearXNG 源），由 `scripts/check-consistency.mjs` 的 ㉛ 断言保证不漂移；
- 运行依赖由安装器自动拉取（`dsh plugin add`）；文件夹投放时需手动 `pnpm install` 一次依赖，但**默认配置仍自动生效**；
- `web_search` 与本插件已启用工具（`research` / `cache_search`）开箱即就绪；
- 联网检索由 DSHT 顶栏「联网搜索」开关统一门控，打开即用——本插件工具随其一起生效。

> 适用前提：默认配置针对**本机运行环境**调优（含本机代理与国内 SearXNG 源）。换机器 / 换网络（代理未开）时，只需在设置页按需调整代理；**不换环境则完全无需改动**。

## SearXNG 自定义源

SearXNG 是元搜索引擎，本插件允许填**任意自建或公共实例**作为搜索后端：

- **设置项**：`SearXNG 实例`（一行一个 `https://` 地址）+ `SearXNG 后端引擎`（对应请求参数 `engines=`，逗号分隔）。
- **内置经过测试的国内源**：种子已默认填入 `https://search.mectov.my.id`（国内可用、无需特殊代理）。该实例匿名默认引擎是 google 且已被 Suspend，若不带 `engines=` 直接 0 结果；**本插件在请求时自动带上种子里那一长串 `searxngEngines`（bing / yahoo / naver / yep / wikipedia 等 34 个），从而正常出结果**——这也是 seed 里配了 34 个引擎而非留空的原因。
- **换成你自己的源**：在设置页把 `SearXNG 实例` 改成你的地址即可。注意公共实例的「默认引擎池」常含被封的 google，务必同时显式填 `SearXNG 后端引擎`，否则容易 0 结果；自建实例可用宿主机在局域网的 IP（`127.0.0.1` 在服务端指它自己）。
- **代理**：SearXNG 走引擎级代理（`proxyByEngine`），未单独配置时随默认代理 / 直连。

---

## 设置页速览

| 设置 | 说明 |
|---|---|
| **联网搜索开关**（DSHT 顶栏） | 本局总开关，统一门控全部本插件工具与 `web_fetch` |
| **默认代理** | 勾选 + 填一个地址 = 全工具走代理；取消勾选 = 全部直连 |
| **每源代理** | 仅「多源/高级/测试/视频」的引擎层 |
| **工具级代理** | 平台直查 / 垂直领域 / 深度研究 / 天气 四条直连链路 |
| **中 / 英文查询池** | Auto 路由与 Multi 并发的引擎集合，可编辑 |
| **web_fetch** | 官方网页抓取工具，默认关闭，受顶栏开关约束 |

---

## 已固化的默认配置

`cordis.patch.yml` 即默认种子。它**逐字复制了单机验证过的运行时 `config.json`**，包括：

- 搜索 provider：`auto` 自动模式；
- 引擎回退顺序与触发条件（quota / auth 冷却 / transient 重试）；
- 中英文池各 8 个免费引擎；
- 工具开关：仅开启 `research` + `cache_search`；
- 代理：`proxyByTool` 已为本机 V2rayN 配置（换机需改）。

**修改默认配置**：改设置页并保存即可（运行时 `config.json` 在 `<dataRoot>/plugin-data/dsh-free-search-fork-for-dsht/`）；若要改「新装默认」，编辑 `cordis.patch.yml` 后重建插件数据。

---

## 更新与维护

- **以 GitHub 仓库为准**：`https://github.com/ActivityTime/dsh-free-search-fork-for-dsht`
- 本地改完发布副本后，运行 `push.cmd`（REST 推送，绕过代理）即可更新线上；
- 插件内 `checkUpdate` 指向本 fork 自有 npm 包；npm 未发布时不会提示更新（不影响使用）。

---

## 已知限制

- **仅适用于 DSH-Tavern**：强依赖宿主的 `dsh-client-ui-*` / `dsh-tools` / `dsh-settings` 等包；
- 发布版不含 `node_modules`，依赖需安装器或手动 `npm install`；
- 境内引擎（Baidu / Kimi / 阿里 / 豆包）约定直连，勿为其配代理；
- 配置与运行时分离：`cordis.patch.yml` 是种子，运行后由 `config.json` 覆盖。

---

## License

MIT —— 继承自上游 DDDMUC/dsh-free-search，本 fork 适配改动同样以 MIT 发布。
