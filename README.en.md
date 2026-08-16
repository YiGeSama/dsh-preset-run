# dsh-preset-run

English | [中文](./README.md)

**DeepSeek Harness plugin** that turns "web session + agent preset" into a programmable interface.

Registers a host-plane tool **`preset_run(preset, task)`** — create a fresh, independent
agent session composed from any agent preset (`router-spec` / `router-standard` /
`standard` / `minimal` / `cordis`), send `task` as its first user message, wait for it
to finish, and return the final answer text. This is the headless equivalent of the
Web UI's **New Session → pick preset → send message** flow.

## Requirements

- **DeepSeek Harness `>= 0.1.0-rc.6`** installed (`dsh` CLI, Web or headless profile)
- **Node.js `>= 18`** (20+ recommended — the plugin and its verify script use modern Node features)
- A configured model service (`agent-default-model` in `settings.yaml`)
- The agent presets you want to call must exist in the deployment's roster (e.g. `router-spec`, `minimal`)

This is a **dsh plugin, not a standalone npm package**: it must be installed through
`dsh plugin add` into a dsh profile. It does not bundle the dsh runtime.

## Install

```bash
# From GitHub (recommended)
dsh plugin --profile web add "github:YiGeSama/dsh-preset-run"

# Alternative: git+https URL
dsh plugin --profile web add "git+https://github.com/YiGeSama/dsh-preset-run.git"

# Alternative: local clone / source directory
dsh plugin --profile web add "file:C:/path/to/dsh-preset-run"
```

> **Windows caveat**: a `file:` local path **containing spaces** may be split by the
> pnpm bridge (`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`, tested with `E:/BaiduSyncdisk/SD Manager/...`).
> In that case use the GitHub install above, clone to a path without spaces, or use the
> 8.3 short path.

**Restart the web process** after installing: `preset_run` is a host-plane tool and
becomes available to every session on the next boot.

`dsh plugin add` performs: pnpm dependency resolution → detects the `dsh.bundle.patch`
declaration in `package.json` → appends `preset-run` to the profile's
`dsh.profile.bundles` list → the `cordis.patch.yml` plugin row is loaded with the
bundle layer on the next start.

### Dependency handling

The plugin imports `@deepseek-ai/dsh-tools`, `dsh-agent`, `dsh-llm`, `dsh-session`
at runtime. They are declared **only as `peerDependencies`, never `dependencies`**:

- These packages are provided by the dsh harness installation that hosts the profile;
- Declaring them as `dependencies` would let pnpm hoist another copy into
  `profiles/web/node_modules/@deepseek-ai/`, so the `tools` service instance and the
  `dsh-agent-loop` `TOOL_RUNTIME_SCHEDULER` symbol would come from two different module
  instances — every tool dispatch would crash
  (`Cannot read properties of undefined (reading 'prepare')`);
- Hence the repository ships no `node_modules` and no machine-specific paths/junctions.

## Usage

Ask the model to call the tool in any session:

```
preset_run("router-spec", "请调用 dev_router_status 工具并输出结果")
preset_run("minimal", "1+1=?")
preset_run("standard", "把 README.md 里的 TODO 列表整理成表格")
```

Optional parameter `timeoutMs` caps a single child run (default `600000` ms).

## Supported presets

`preset_run` uses whatever preset ids the deployment's `agentPresets` roster provides;
it does not hardcode a list.

**Out of the box it supports the 4 default dsh presets** (shipped with dsh, no extra install):

| Preset | Description |
| --- | --- |
| `standard` | Standard full tool catalog |
| `code` | Code mode |
| `minimal` | Minimal preset, good for simple Q&A |
| `cordis` | Cordis authoring/debug preset |

**The other 2 routing presets come from a third-party plugin** ([yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) — not part of this plugin; install it separately for them to appear in the roster):

| Preset | Description |
| --- | --- |
| `router-spec` | First turn exposes only core tools (read/edit/glob/grep + shell); the full catalog opens after the first tool call |
| `router-standard` | Standard task-aware routing preset |

The exact roster depends on the deployment (`agentPreset.list`).

## How it works

- **Preset application follows the official path**: `agentPresets.mount(agentCtx, presetId)`
  runs inside the agent factory's `setup(agentCtx)` hook (before the agent is published —
  a mount failure rolls the whole creation back), and the preset id is recorded in the
  session header (`meta.agentPreset`). This matches the Web backend
  (`dsh-host-apiproxy`'s `composeAgent`/`ensureSession`); it is **not** a loader
  `--patch` hack.
- **Model routing**: reads `agentDefaultModel.currentSelection()` (i.e.
  `agent-default-model` in `settings.yaml`) and installs it on the child agent via
  `installModelSelection` — provider/model/effort all apply.
- **Task execution**: `agent.followup(createUserMessage(task))` drives the child,
  `agent.whenIdle()` waits for it to settle, then the final assistant text and the
  `turn/end` reason are aggregated from the session event log. A run that never emitted
  `turn/end` is reported as failed (strict), even if it produced partial text.
- **Cleanup**: after returning, `dispose()` tears the child agent down; the session is
  removed from the registry and leaves no UI residue. Abort/timeout first call
  `agent.cancel()` so the child stops burning tokens. Cleanup failures are logged and
  never mask the child's own result.

## Security notes

- `preset_run` lets **any session that can call it** spawn child sessions that run tasks
  with the deployment's default permission preset. In multi-user or untrusted
  deployments, make sure only authorized callers reach it.
- Child sessions inherit the deployment's default permission preset (new-session
  sandbox + approval). In a `workspace-write + ask` deployment, a child that requests
  elevation enters an approval flow nobody answers and may block until timeout —
  configure `danger-full-access` (in `settings.yaml` or `DSH_PERMISSION_MODE=danger-full-access`)
  when unattended runs are required.
- Child sessions are one-shot: destroyed after returning, no history is kept.

## Verification

Tested end-to-end on `@deepseek-ai/dsh 0.1.0-rc.6` + `tokenrythm/deepseek-v4-flash-0731`.

```bash
# 1. Start a verification instance (same profile, separate port)
dsh web --port 3083

# 2. Run the acceptance script (drives the web JSON-RPC: create session → send → wait → check catalog/log)
node verify-preset-run.mjs http://127.0.0.1:3083
```

Expected highlights:

- The roster contains `router-spec` / `minimal`;
- A `router-spec` child session's escalated catalog **includes `dev_router_status`** and
  actually calls it (returns `router-mode=spec / mode=1.00 (band=react) / core=[read, write, edit] / override=no`);
- A `minimal` child session answers `1+1=2`;
- Two `preset_run` calls from one standard parent session relay both child answers.

## Notes

- The `router-spec` preset intentionally exposes only core tools on the first turn
  (read/edit/glob/grep + shell); the full catalog opens after the first tool call. If
  your task text asks for a post-escalation tool such as `dev_router_status`, guide the
  child to run one shell command first (e.g. `pwd`).

## Credits

- **Idea & requirements**: YiGeSama (repository owner)
- **Implementation**: built collaboratively by two AI agents — the DeepSeek Harness
  agent (core implementation) and the Hermes agent (coordination, review, engineering).

## License

MIT — see [LICENSE](LICENSE).
