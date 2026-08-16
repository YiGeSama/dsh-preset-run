/**
 * verify-preset-run.mjs — end-to-end acceptance driver for the preset-run
 * plugin, driven against a dsh web instance's JSON-RPC API.
 *
 * Usage: node verify-preset-run.mjs [baseUrl]   (default http://127.0.0.1:3083)
 *
 * Part 1 — preset effectiveness via the Web flow (the same composition path
 *          preset_run uses internally: session.create + agentPresets.mount):
 *   A. router-spec session's promoted tool catalog MUST contain
 *      dev_router_status (deterministic proof the preset is effective) and
 *      the run returns non-empty assistant text.
 *   B. minimal session answers "1+1=?" with a numeric result.
 *
 * Part 2 — the actual preset_run TOOL: a standard session is prompted to call
 *          preset_run("router-spec", ...) and preset_run("minimal", "1+1=?")
 *          and relay the child's answer text.
 */
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://127.0.0.1:3083";

async function rpc(method, payload, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const rpcId = randomUUID();
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
    const full = await res.json();
    if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}`);
    return full.result;
  } finally {
    clearTimeout(timer);
  }
}

function okOrThrow(result, what) {
  if (!result.ok) throw new Error(`${what} failed: ${result.error?.code ?? "unknown"}: ${result.error?.message ?? JSON.stringify(result.error)}`);
  return result.value;
}

function unwrap(events) {
  return events.map((entry) => (entry && typeof entry === "object" && "event" in entry ? entry.event : entry));
}

function assistantText(events) {
  let text = "";
  for (const event of unwrap(events)) {
    if (event.type !== "assistant/message") continue;
    const joined = (event.data?.message?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (joined !== "") text = joined;
  }
  return text;
}

/** The tool names each request carried, in order of appearance. */
function requestToolNames(events) {
  const names = [];
  for (const event of unwrap(events)) {
    if (event.type !== "request/header") continue;
    const tools = event.data?.header?.tools;
    if (!Array.isArray(tools)) continue;
    for (const t of tools) if (!names.includes(t.name)) names.push(t.name);
  }
  return names;
}

async function waitReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/dsh-health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`web instance at ${base} did not become ready in 90s`);
}

async function runFlow(preset, task, maxWaitMs = 600_000) {
  const created = okOrThrow(await rpc("session.create", { cwd: process.cwd(), agentPreset: preset }), `session.create(${preset})`);
  const sessionId = created.sessionId;
  if (created.agentPreset !== preset) throw new Error(`session.create did not record agentPreset="${preset}" (got ${String(created.agentPreset)})`);
  okOrThrow(await rpc("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: task }] }), `session.prompt(${preset})`);
  const deadline = Date.now() + maxWaitMs;
  let summary;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const list = okOrThrow(await rpc("session.list", {}), "session.list");
    summary = list.items.find((item) => item.sessionId === sessionId);
    if (summary === void 0) throw new Error(`session ${sessionId} vanished from the list`);
    if (!summary.running) break;
  }
  if (summary === void 0 || summary.running) throw new Error(`[${preset}] run did not finish within ${maxWaitMs}ms`);
  const history = okOrThrow(await rpc("session.history", { sessionId }), "session.history");
  return { sessionId, history, text: assistantText(history.events).trim() };
}

const results = [];
const pass = (name, extra = "") => { console.log(`✓ ${name}${extra === "" ? "" : ` — ${extra}`}`); results.push({ name, ok: true }); };
const fail = (name, error) => { console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); results.push({ name, ok: false }); };

try {
  await waitReady();
  pass("instance ready", base);

  const roster = okOrThrow(await rpc("agentPreset.list", {}), "agentPreset.list");
  const ids = roster.presets.map((p) => p.id);
  console.log(`roster: ${ids.join(", ")}`);
  if (!ids.includes("router-spec")) throw new Error("router-spec not in the roster");
  if (!ids.includes("minimal")) throw new Error("minimal not in the roster");
  pass("roster contains router-spec + minimal");

  // ── Part 1A: router-spec preset effectiveness (web flow) ─────────────────
  const ROUTER_SPEC_TASK =
    "请先调用一次 pwsh 工具执行 pwd（这会激活本会话的完整工具目录），然后调用 dev_router_status 工具并输出其结果。你的完整工具目录里确实有 dev_router_status 这个工具。";
  try {
    const spec = await runFlow("router-spec", ROUTER_SPEC_TASK);
    if (spec.text.length === 0) throw new Error("router-spec run returned empty text");
    const names = requestToolNames(spec.history.events);
    const hasDevTool = names.includes("dev_router_status");
    const called = unwrap(spec.history.events).some((e) => e.type === "tool/call" && e.data?.name === "dev_router_status");
    console.log(`[router-spec] catalog seen by the model (${names.length} tools): ${names.join(", ")}`);
    console.log(`[router-spec] dev_router_status called: ${called}`);
    console.log(`[router-spec] final text (${spec.text.length} chars):`);
    console.log("------\n" + spec.text + "\n------");
    if (!hasDevTool) throw new Error("dev_router_status is absent from the router-spec session's tool catalog — preset not effective");
    pass("router-spec preset effective: dev_router_status in the session catalog", called ? "and actually called" : "model did not call it, but the tool is present");
  } catch (error) { fail("router-spec preset effectiveness", error); }

  // ── Part 1B: minimal preset answers 1+1 (web flow) ───────────────────────
  try {
    const min = await runFlow("minimal", "1+1=?");
    if (!/(2|二|两)/.test(min.text)) throw new Error(`minimal run did not answer 2; got: ${min.text}`);
    pass("minimal preset answers 1+1", `"${min.text.slice(0, 120)}"`);
  } catch (error) { fail("minimal preset run", error); }

  // ── Part 2: the actual preset_run TOOL, called from a session ────────────
  const PRESET_RUN_PARENT_TASK = [
    "依次调用 preset_run 工具两次，把每次返回的文本原样输出（不要加自己的评论，不要改内容）：",
    "1. preset_run(preset=\"router-spec\", task=\"请先调用一次 pwsh 工具执行 pwd 以激活完整工具目录，然后调用 dev_router_status 工具并输出其结果。你的工具目录里确实有 dev_router_status。\")",
    "2. preset_run(preset=\"minimal\", task=\"1+1=?\")",
    "输出格式：第一段是第一次调用返回的文本，第二段是第二次调用返回的文本，中间用 --- 分隔。"
  ].join("\n");
  try {
    const parent = await runFlow("standard", PRESET_RUN_PARENT_TASK, 900_000);
    if (parent.text.length === 0) throw new Error("preset_run tool test returned empty parent text");
    const calledPresetRun = unwrap(parent.history.events).filter((e) => e.type === "tool/call" && e.data?.name === "preset_run");
    console.log(`[preset_run tool] calls logged: ${calledPresetRun.length}`);
    for (const c of calledPresetRun) console.log(`[preset_run tool]   preset_run args: ${c.data.arguments}`);
    console.log(`[preset_run tool] parent reply (${parent.text.length} chars):`);
    console.log("------\n" + parent.text + "\n------");
    if (calledPresetRun.length === 0) throw new Error("the parent session never called the preset_run tool");
    if (!/(2|二|两)/.test(parent.text)) throw new Error("preset_run(minimal) result missing a numeric answer in the relayed text");
    pass("preset_run tool works end-to-end (router-spec + minimal child runs)", `${calledPresetRun.length} preset_run call(s), child answers relayed`);
  } catch (error) { fail("preset_run tool end-to-end", error); }
} catch (error) {
  console.error(`\nfatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  results.push({ name: "run", ok: false });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${results.length} total) ===`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
process.exit(failed.length === 0 ? 0 : 1);
