# dsh-preset-run

[English](./README.en.md) | 中文

**DeepSeek Harness 插件**：把「web 会话 + Agent 预设」变成可编程接口。

注册一个 host-plane 工具 **`preset_run(preset, task)`** —— 用指定的 agent 预设
（如 `router-spec` / `router-standard` / `standard` / `minimal` / `cordis`）创建
一个全新的独立会话，执行 `task`，返回最终回答文本。等价于无头模拟 web UI 的
「新建会话 → 选预设 → 发消息」流程。

## 环境要求

- 已安装 **DeepSeek Harness `>= 0.1.0-rc.6`**（`dsh` CLI，web 或 headless profile）
- **Node.js `>= 18`**（建议 20+——插件与验证脚本用到较新的 Node 特性）
- 已配置可用的模型服务（`settings.yaml` 的 `agent-default-model`）
- 目标预设已存在于部署的 roster 中（如 `router-spec`、`minimal`）

这是一个 **dsh 插件，不是独立 npm 包**：必须通过 `dsh plugin add` 装进 dsh
profile，仓库不打包 dsh 运行时。

## 安装

```bash
# 方式一：从 GitHub 安装（推荐）
dsh plugin --profile web add "github:YiGeSama/dsh-preset-run"

# 方式二：git+https 地址
dsh plugin --profile web add "git+https://github.com/YiGeSama/dsh-preset-run.git"

# 方式三：本地 clone / 源码目录
dsh plugin --profile web add "file:C:/path/to/dsh-preset-run"
```

> **Windows 注意**：`file:` 本地路径若**包含空格**，`dsh plugin` 转发给 pnpm 时可能
> 被拆断（实测 `E:/BaiduSyncdisk/SD Manager/dsh-preset-run` 会报
> `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`）。这种情况请改用 GitHub 安装，或把仓库
> clone 到无空格路径，或使用 8.3 短路径。

安装完成后**重启 web 进程**生效：`preset_run` 是 host-plane 工具，重启后所有
会话都能调用。

`dsh plugin` 命令会：pnpm 安装依赖 → 检测到 package.json 的 `dsh.bundle.patch`
声明 → 自动把 `preset-run` 追加进 profile 的 `dsh.profile.bundles` 层列表 →
重启后 `cordis.patch.yml` 的插件行随 bundle 层一起装载。

### 依赖处理

本插件运行时 import `@deepseek-ai/dsh-tools`、`dsh-agent`、`dsh-llm`、
`dsh-session`。它们**只作为 `peerDependencies` 声明，不放进 `dependencies`**：

- 这些包由承载该 profile 的 dsh harness 安装提供；
- 一旦声明为 `dependencies`，`pnpm add` 会把这些包提升进
  `profiles/web/node_modules/@deepseek-ai/`，导致 `tools` 服务实例与
  `dsh-agent-loop` 的 `TOOL_RUNTIME_SCHEDULER` 符号来自两个模块实例，
  任何工具调度都会崩溃（`Cannot read properties of undefined (reading 'prepare')`）；
- 因此仓库不包含 `node_modules`，也没有任何本机绝对路径/junction。

## 用法

会话里直接让模型调用：

```
preset_run("router-spec", "请调用 dev_router_status 工具并输出结果")
preset_run("minimal", "1+1=?")
preset_run("standard", "把 README.md 里的 TODO 列表整理成表格")
```

可选参数 `timeoutMs` 控制单次子会话运行的最长耗时（默认 600000ms）。

## 支持的预设

`preset_run` 使用 `agentPresets` roster 中的预设 id，不硬编码预设列表。

**本插件自身支持 dsh 官方默认的 4 个预设**（随 dsh 自带，无需额外安装）：

| 预设 | 说明 |
| --- | --- |
| `standard` | 标准完整工具目录 |
| `code` | 代码模式 |
| `minimal` | 极简预设，适合简单问答 |
| `cordis` | Cordis 调试/开发相关预设 |

**另外 2 个路由预设来自第三方插件**（[yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)，不属于本插件，需单独安装后才会出现在 roster 中）：

| 预设 | 说明 |
| --- | --- |
| `router-spec` | 首轮只暴露核心工具（read/edit/glob/grep + shell），首次工具调用后开放完整目录 |
| `router-standard` | 标准路由预设 |

实际可用的预设以部署的 roster 为准（`agentPreset.list` 可查看）。

## 工作原理

- **预设应用走官方路径**：`agentPresets.mount(agentCtx, presetId)` 在 agent
  工厂的 `setup(agentCtx)` 钩子里调用（agent 尚未发布，装载失败则整个创建回滚），
  预设 id 同时写入会话 header（`meta.agentPreset`）。这与 web 前端新建会话的后端
  实现（`dsh-host-apiproxy` 的 `composeAgent`/`ensureSession`）完全一致，不是
  loader `--patch` 硬塞。
- **模型路由**：读取 `agentDefaultModel.currentSelection()`（即 settings.yaml 的
  `agent-default-model`），经 `installModelSelection` 挂到子 agent，
  provider/model/effort 一起生效。
- **任务执行**：`agent.followup(createUserMessage(task))` 唤醒驱动，
  `agent.whenIdle()` 等待运行结束，然后从会话事件日志汇总最后一段 assistant 文本
  与 `turn/end` 的 reason。**没有正常结束标记（turn/end）的运行一律按失败返回**
  （严格模式，即使已产生部分文本），非 completed 的结局同样按失败处理（附带已有
  部分文本）。
- **清理**：返回结果后 `dispose()` 子 agent，会话从注册表移除，不残留 UI 会话。
  调用方（exec.signal）中止或超时都会先 `agent.cancel()` 再退出。清理出错只记录
  日志，**绝不覆盖子会话自身的结果/报错**。

## 安全注意

- `preset_run` 让**任何能调用它的会话**都能开子会话跑任务，能力很强。多用户或
  不可信环境部署时，务必确认只有受信调用方能触达它。
- 子会话沿用部署的默认权限预设（新会话默认的 sandbox + approval）；在默认
  workspace-write + ask 的部署里，子 agent 若需要提权会进入审批流程而无人应答，
  可能阻塞到超时。需要无人工介入时请把默认权限预设配成 danger-full-access
  （`settings.yaml` 或环境 `DSH_PERMISSION_MODE=danger-full-access`）。
- 子会话是一次性的：返回文本后即销毁，不留历史。

## 验证

已在 `@deepseek-ai/dsh 0.1.0-rc.6` + `tokenrythm/deepseek-v4-flash-0731` 实测全过。

```bash
# 1. 起一个验证实例（与正式实例同 profile，另开端口）
dsh web --port 3083

# 2. 跑验收脚本（内部走 web 的 JSON-RPC：建会话→发消息→等结果→查目录/日志）
node verify-preset-run.mjs http://127.0.0.1:3083
```

实测输出要点：

- roster 含 `router-spec` / `minimal`（预设目录生效）；
- `router-spec` 会话的提升后目录**包含 `dev_router_status`**，且子会话实际调用
  成功，返回 `router-mode=spec / mode=1.00 (band=react) / core=[read, write, edit] /
  override=no`；
- `minimal` 会话回答 `1+1=2`；
- 一个 standard 父会话两次调用 **preset_run 工具本身**（router-spec 子会话
  输出 dev_router_status 结果；minimal 子会话回答 1+1=2），全部中继成功。

## 注意事项

- router-spec 预设的设计是首轮只暴露核心工具（read/edit/glob/grep + shell），
  首次工具调用后才开放完整目录 —— 让子会话调用 `dev_router_status` 时，任务文本
  应引导它先执行一次 shell 命令（如 pwd）再调。

## 致谢

- **想法与需求**：YiGeSama（本仓库所有者）
- **实现**：由两个 AI 助手协作完成——dsh（DeepSeek Harness）侧的助手负责核心实现，Hermes 侧的助手负责统筹、审查与工程化。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
