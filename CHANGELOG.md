# 更新日志

本文件随每次发布追加一条，记录该次推送的变更项。

> **关于版本号**：本仓库为 `dsh-free-search` 的 **DSHT（DeepSeek Harness Tavern）适配 fork**，
> 不再追踪上游 DDDMUC/dsh-free-search，故版本号独立演进，与上游无对应关系。

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
