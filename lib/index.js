/**
 * preset-run — host half.
 *
 * Registers the `preset_run(preset, task)` tool on the HOST-plane tools
 * registry. The tool is the programmable equivalent of the Web UI's
 * "New Session → pick agent preset → send message" flow: it creates a brand
 * new, independent agent session composed from the named agent preset
 * (router-spec / router-standard / standard / minimal / cordis / …), routes it
 * with the deployment's `agent-default-model` selection (settings.yaml), runs
 * the task to completion, returns the final assistant text, then tears the
 * child session down.
 *
 * The composition follows the official Web create path (dsh-host-apiproxy's
 * `composeAgent` + `ensureSession`): the preset is resolved BEFORE the session
 * exists, mounted inside the agent factory's `setup(agentCtx)` (so a mount
 * failure rolls the whole creation back), and recorded on the session header
 * via `meta.agentPreset`. Task delivery mirrors the headless runner
 * (dsh-headless): `followup()` a user message, `whenIdle()`, then summarize
 * the assistant text from the session event log.
 */
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

/** Stable Cordis plugin name. */
export const name = "preset-run";
/** Core services required before the tool can be registered. `agentPresets`
 * is read with ctx.get (optional) so the plugin still mounts on a profile
 * that composes no roster; the tool then fails loud when called. */
export const inject = [
  "tools",
  "agents",
  "sessions",
  "agentDefaultModel"
];

/** Default deadline for one child run; overridable per call. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Join the text blocks of one assistant message. */
function assistantText(message) {
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Aggregate the last assistant text and turn outcome from the events a child
 * session produced after `firstSeq` — the same shape the headless runner uses.
 * @param events - the session's event log.
 * @param firstSeq - sequence the task's turn starts after.
 * @returns the final non-empty assistant text and the last turn/end reason.
 */
function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = assistantText(event.data.message);
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(reason, text) {
  if (reason === void 0) return text === "" ? "child run produced no turn/end outcome" : void 0;
  const headline = (() => {
    switch (reason.kind) {
      case "completed": return void 0;
      case "blocked": return "child run was blocked (a step was rejected before running)";
      case "max-tokens": return "child run hit its token limit before finishing";
      case "aborted": return "child run was cancelled";
      case "error": return `child run failed: ${reason.error?.message ?? String(reason.error)}`;
      default: return `child run ended abnormally (${String(reason.kind)})`;
    }
  })();
  if (headline === void 0) return void 0;
  if (text === "") return headline;
  return `${headline}\nPartial output before the run ended:\n${text}`;
}

/**
 * Await the child's activity, honouring the caller's signal and an overall
 * deadline. On timeout the child is cancelled so it stops burning tokens.
 * @returns when the child settles; rejects with the abort/timeout reason.
 */
async function waitIdle(agent, signal, timeoutMs) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("preset_run aborted before the child started");
  const controller = new AbortController();
  const onAbort = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("preset_run aborted");
    controller.abort(reason);
    agent.cancel(reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const reason = new Error(`preset_run timed out after ${timeoutMs}ms`);
    controller.abort(reason);
    agent.cancel(reason);
  }, timeoutMs);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Mount the tool. The registration is effect-scoped, so stop/update/unload of
 * this plugin unregisters it with the tree.
 * @param ctx - plugin context carrying the core registries.
 */
export function apply(ctx) {
  const dispose = ctx.tools.register(defineTool({
    name: "preset_run",
    description: "Create a fresh, independent agent session composed from the named agent preset (exactly like the Web UI's New Session flow, but headless), send the given task as its first user message, wait for it to finish, and return the final answer text. The child session is routed with the deployment's agent-default-model (settings.yaml) and gets the preset's own tools, prompt sections, and skills. It is torn down afterwards. Use this to run a one-shot task under a specific agent preset (e.g. router-spec / router-standard / standard / minimal / cordis) without touching the current conversation.",
    parameters: {
      preset: {
        type: "string",
        required: true,
        description: "Agent preset id to compose the child session from, e.g. router-spec, router-standard, standard, minimal or cordis. It must exist in the agent-presets roster."
      },
      task: {
        type: "string",
        required: true,
        description: "The task text to send as the child session's first user message."
      },
      timeoutMs: {
        type: "number",
        description: `Optional overall deadline for the child run in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`
      }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { preset, task, timeoutMs } = args;
      const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
      const presets = ctx.get("agentPresets");
      if (presets === void 0) throw new Error("preset_run: no agent-presets roster is composed in this deployment (the web profile composes one; a profile without it cannot name presets)");

      // Resolve BEFORE the session exists: a bad preset must never mint a
      // session (the Web flow resolves in the same order).
      await presets.resolveMountable(preset);

      const parent = exec.agent;
      const cwd = parent?.session?.header?.cwd ?? process.cwd();
      const selection = ctx.agentDefaultModel.currentSelection();

      let handle;
      try {
        handle = await ctx.agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          agentOptions: {
            provider: selection.provider,
            model: selection.model
          },
          meta: {
            cwd,
            agentPreset: preset
          },
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, {
              current: selection,
              assembled: void 0
            });
            await presets.mount(agentCtx, preset);
          },
          signal: exec.signal
        });
      } catch (error) {
        throw new Error(`preset_run: failed to create a "${preset}" session: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }

      const { agent, dispose } = handle;
      try {
        await agent.whenIdle();
        const firstSeq = agent.session.seq;
        agent.followup(createUserMessage({
          content: [{ type: "text", text: task }],
          source: { kind: "user" }
        }));
        await waitIdle(agent, exec.signal, deadline);
        const outcome = summarize(agent.session.events, firstSeq);
        const failure = stopReasonError(outcome.reason, outcome.text);
        if (failure !== void 0) throw new Error(`preset_run: ${failure}`);
        return outcome.text;
      } finally {
        await dispose();
      }
    }
  }));
  return dispose;
}
