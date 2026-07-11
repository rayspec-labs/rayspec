/**
 * OpenAI/ChatGPT **Codex** adapter (the 4th backend, FULL parity with openai/anthropic/pi).
 *
 * Maps the neutral Backend interface onto @openai/codex-sdk 0.142.2 (pinned, zero caret; verified
 * doc-first against the INSTALLED dist/index.d.ts + dist/index.js AND the `codex` CLI
 * config schema, with the load-bearing behaviors PROVEN by a live subscription probe before this
 * file was written).
 *
 * --- THE LOAD-BEARING FACT (drives the whole design) -------------------------------------------
 * `@openai/codex-sdk` is NOT a direct API SDK like @openai/agents / the Claude Agent SDK / Pi. It
 * WRAPS the `codex` CLI: `new Codex()` spawns `codex exec --experimental-json` as a CHILD PROCESS
 * and exchanges JSONL events over stdio (dist/index.js:137-284). It bundles its own `@openai/codex`
 * CLI + platform binary (findCodexPath) — NOT the system `codex` on PATH. So this adapter is a
 * PROCESS-OF-PROCESS (like Anthropic), and every custom tool flows through an in-process MCP server.
 *
 * --- DOC-FIRST verified API surface used here (dist/index.d.ts:symbol) --------------------------
 *   - new Codex({ env?, config?, apiKey?, baseUrl?, codexPathOverride? })           (index.d.ts:216)
 *       `env` set => the child inherits ONLY what we pass (index.js:231-240) — the structural
 *       mis-billing guard. `config` is flattened into `--config key=value` (index.js:173-176).
 *       `apiKey` => injects CODEX_API_KEY (index.js:244-246); we NEVER pass it.
 *   - codex.startThread(options?: ThreadOptions): Thread                            (index.d.ts:265)
 *       ThreadOptions: model, sandboxMode, workingDirectory, skipGitRepoCheck, networkAccessEnabled,
 *       webSearchEnabled, approvalPolicy, additionalDirectories                     (index.d.ts:239)
 *   - thread.runStreamed(input, { outputSchema?, signal? }): { events:AsyncGenerator<ThreadEvent> }
 *                                                                                   (index.d.ts:206)
 *   - ThreadEvent: thread.started | turn.started | turn.completed{usage} | turn.failed{error{message}}
 *       | item.started/updated/completed{item} | error{message}                    (index.d.ts:165)
 *   - ThreadItem: agent_message{text} | reasoning{text} | command_execution | file_change
 *       | mcp_tool_call{server,tool,arguments,result,error,status} | web_search | todo_list | error
 *                                                                                   (index.d.ts:104)
 *   - Usage{ input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } (index.d.ts:120)
 *
 * --- Untrusted-content boundary — built-in-tool CONFINEMENT (documented HONESTLY) ---------------
 * Codex's built-in tools (shell / apply-patch / web-search) run INSIDE the codex sandbox, OUTSIDE
 * `ctx.dispatchTool` — the exact untrusted-content-boundary hazard first caught with the Anthropic
 * adapter. The SDK exposes NO
 * `tools:[]` restrictor (codex's shell is core, not removable). We therefore CONFINE them:
 *   startThread({ sandboxMode:'read-only', networkAccessEnabled:false, webSearchEnabled:false,
 *                 approvalPolicy:'never', workingDirectory:<fixed empty scratch dir>, skipGitRepoCheck:true })
 * — a read-only, network-disabled, empty scratch dir with no human approver. VERIFIED EMPIRICALLY
 * (the bundled codex 0.142.2 binary, this exact config): a model-generated shell command
 * CANNOT write (`Operation not permitted`) and CANNOT reach the network (DNS blocked) — but read-only
 * does NOT restrict READS (it CAN read files outside the cwd, e.g. ~/.codex/auth.json). With the
 * write+network block, read content cannot be EXFILTRATED externally; the residual risk is an
 * adversarial PROMPT surfacing read content in the agent's own response. Acceptable for the current
 * internal/pre-hardening posture because RaySpec agent prompts (instructions+input) are trusted/
 * deployment-authored and the untrusted data (tool RESULTS) is opaque-wrapped — but the
 * per-tenant sandbox remains the BINDING isolation for untrusted/multi-tenant prompts (a
 * documented limitation). apply-patch + web-search are confined the same way (no write/network). This is
 * sandbox CONFINEMENT, not tool REMOVAL. ALL product tools go through the MCP bridge →
 * ctx.dispatchTool. The workingDirectory is a SINGLE fixed empty scratch dir REUSED across runs (so
 * codex registers ONE ~/.codex/config.toml `[projects]` entry total, not one-per-run); it is NOT
 * torn down because it is shared across (concurrent) runs and read-only-
 * confined (codex cannot write into it — it stays empty + accumulates no state).
 *
 * --- TOOLS — the in-process streamable-HTTP MCP bridge → ctx.dispatchTool -----------------------
 * Codex's only first-class custom-tool path is MCP. We host an IN-PROCESS streamable-HTTP MCP server
 * (@modelcontextprotocol/sdk McpServer + StreamableHTTPServerTransport) on 127.0.0.1:<ephemeral>,
 * bearer-token-guarded (a random per-run token codex sends), and point codex at it via
 *   config.mcp_servers.rayspec = { url, bearer_token_env_var:'RAYSPEC_MCP_TOKEN',
 *                                   default_tools_approval_mode:'approve' }
 * Each MCP tool handler is an INLINE fn that ONLY: marshal args -> ctx.dispatchTool(name, args,
 * toolCallId) -> return the opaque tool_data/tool_error into the MCP tool-RESULT channel. The adapter
 * holds NO handler (the gate:adapter-handlers TOOL_BUILDER_CALL_RE requires the inline ctx.dispatchTool
 * call on every registerTool()). dispatchTool owns validate-in/idempotency/timeout/validate-out/
 * opaque-wrap/one-journaled-step (the untrusted-content-boundary chokepoint).
 *
 * Verified empirically by a live probe before this was written: the per-server
 * `default_tools_approval_mode:'approve'` config key is REQUIRED. Without it, `codex exec` (non-
 * interactive) CANCELS the MCP tool call ("user cancelled MCP tool call") — the tools/list handshake
 * succeeds but tools/call never reaches us. `approve` = auto-approve (no human prompt). The valid
 * enum is { auto, prompt, approve } (codex config-load rejects anything else). Verified: with this
 * key the handler FIRES under read-only sandbox + approval_policy:never; without it, it is cancelled.
 *
 * --- AUTH — subscription-ONLY (the #1 audit target: mis-billing) --------------------------------
 * The codex adapter is the subscription-ONLY OpenAI backend (the @openai/agents api-key adapter
 * remains the api-key option). We build a CURATED child env (HOME/PATH/CODEX_HOME/LANG/
 * TMPDIR + the per-run RAYSPEC_MCP_TOKEN) that EXCLUDES OPENAI_API_KEY/CODEX_API_KEY/*_BASE_URL —
 * structurally forbidding a stray key from reaching the subprocess (index.js:231-246). `resolveAuth()`
 * verifies ~/.codex/auth.json is the OAuth/ChatGPT form (auth_mode:'chatgpt' + tokens, no real
 * OPENAI_API_KEY). PROVEN: with a STRAY OPENAI_API_KEY/CODEX_API_KEY injected into process.env, the
 * curated env strips them and the run completes via the subscription (real usage, billed=$0). We NEVER
 * pass `apiKey`/`baseUrl` to CodexOptions, so CODEX_API_KEY is never injected.
 *
 * --- STRUCTURED OUTPUT — NATIVE ----------------------------------------------------------------
 * TurnOptions.outputSchema (a plain JSON-Schema object) → the SDK writes a temp file + passes
 * --output-schema; finalResponse is the JSON. nativeStructuredOutput:true.
 *
 * --- JOURNAL granularity -----------------------------------------------------------------------
 * One thread.run() = ONE turn = ONE `llm` journal step (codex internalizes the agent loop in the
 * subprocess; we cannot pause mid-loop). Tool steps are journaled by ctx.dispatchTool. Honest per-
 * backend granularity difference; parity asserts SHAPE, not stepCount.
 *
 * No SDK type escapes this file — everything returned is a neutral RunResult; the adapter is the
 * anti-corruption layer.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSpec,
  AuthMode,
  Backend,
  ConvPart,
  ConvTurn,
  ErrorClass,
  NeutralEvent,
  NeutralEventInput,
  RunContext,
  RunResult,
  StepReport,
  ToolDispatchResult,
  Usage,
} from '@rayspec/core';
import { classifyUpstreamError, costUsd, hashJson } from '@rayspec/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Codex } from '@openai/codex-sdk';
import { z } from 'zod';

/** The single in-proc MCP server name; tools are dispatched by codex as server='rayspec'. */
const MCP_SERVER_NAME = 'rayspec';

/** The env var codex reads for the per-run MCP bearer token (config.bearer_token_env_var). */
const MCP_TOKEN_ENV = 'RAYSPEC_MCP_TOKEN';

/**
 * Max buffered MCP request body (4 MiB). The bridge is loopback-only + bearer-guarded, but a runaway
 * or malformed request must not exhaust memory — over this cap the handler responds 413 and stops
 * buffering (the transport never sees the body). 4 MiB comfortably exceeds any real MCP JSON-RPC frame.
 */
const MCP_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The SINGLE fixed, empty, read-only scratch dir reused as the codex workingDirectory across ALL runs
 * (concurrent runs included). codex keys its trusted-projects list (~/.codex/config.toml `[projects]`)
 * on the cwd PATH, so a per-run mkdtemp'd path made codex accrete ONE `[projects]` entry PER RUN.
 * A fixed path => codex registers ONE `[projects]` entry TOTAL. It is created idempotently
 * (mkdirSync recursive) and NEVER torn down: it is shared across runs and the `sandboxMode:'read-only'`
 * confinement means codex CANNOT write into it, so it stays empty + accumulates no state.
 */
const CODEX_SCRATCH_CWD = join(tmpdir(), 'rayspec-codex-scratch');

/**
 * The pinned @openai/codex-sdk version this adapter was written + recorded against (doc-first, zero
 * caret/tilde — matches packages/adapters/codex/package.json). The version-bump-re-record RULE
 * asserts this equals the INSTALLED pinned version, so bumping the SDK without
 * re-recording the fixtures fails CI. Bump BOTH together (this constant + a fresh fixture capture).
 */
export const CODEX_SDK_VERSION = '0.142.2';

/** Provenance tag recorded on every journal step (deliverable A6): SDK + adapter version. */
export const CODEX_PRODUCED_BY = `@openai/codex-sdk@${CODEX_SDK_VERSION}+adapter-codex`;

/** The neutral auth mode for a Codex run on the ChatGPT OAuth subscription. */
export const CODEX_SUBSCRIPTION_AUTH_MODE: AuthMode = 'codex-subscription-oauth';

/**
 * The codex MCP per-server config that makes `codex exec` AUTO-APPROVE our in-proc MCP tool calls in
 * non-interactive mode. Without `default_tools_approval_mode:'approve'` codex CANCELS the call
 * ("user cancelled MCP tool call") — verified live. The valid enum is { auto, prompt, approve };
 * `approve` = auto-approve with no human prompt. Exported so the Tier-1 wire golden pins it (flipping
 * it breaks the golden — a real config-key regression would be caught).
 */
export const MCP_TOOLS_APPROVAL_MODE = 'approve' as const;

export interface CodexAdapterOptions {
  /**
   * Optional explicit path to the `codex` CLI binary. Default: the SDK auto-resolves its OWN bundled
   * platform binary (findCodexPath) — NOT the system `codex` on PATH (which may be a different
   * version). Provided only for tests / unusual deploys.
   */
  codexPathOverride?: string;
  /** Optional override of the codex home dir (~/.codex by default) — where auth.json lives. */
  codexHome?: string;
}

/** The result of the pre-run auth self-check (mirrors anthropic AuthSelfCheck). */
export interface CodexAuthSelfCheck {
  authMode: AuthMode;
  /** True iff ~/.codex/auth.json exists AND is the OAuth/ChatGPT form (tokens, not an api-key file). */
  oauthSessionPresent: boolean;
  /** True iff a stray OPENAI_API_KEY / CODEX_API_KEY was present in the ambient env (it is STRIPPED). */
  strayApiKeyDetected: boolean;
}

export class CodexAdapter implements Backend {
  readonly id = 'codex' as const;
  private readonly codexPathOverride?: string;
  private readonly codexHome?: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.codexPathOverride = opts.codexPathOverride;
    this.codexHome = opts.codexHome;
  }

  /** The codex home directory (where auth.json lives). CODEX_HOME env > opts.codexHome > ~/.codex. */
  private resolveCodexHome(): string {
    return process.env.CODEX_HOME ?? this.codexHome ?? join(process.env.HOME ?? '', '.codex');
  }

  /**
   * Resolve + validate auth WITHOUT a model call. The codex adapter is subscription-ONLY: it verifies
   * ~/.codex/auth.json is the OAuth/ChatGPT form (auth_mode:'chatgpt' + a `tokens` object, with NO real
   * OPENAI_API_KEY in the file). Present ⇒ 'codex-subscription-oauth'; absent ⇒ 'unauthenticated'
   * (we NEVER fall through to api-key — that is the @openai/agents adapter's job).
   *
   * A stray OPENAI_API_KEY/CODEX_API_KEY in the ambient env is DETECTED (recorded as a self-check note)
   * but never changes the auth mode — the curated child env STRIPS it, so it cannot mis-bill the API.
   */
  async resolveAuth(): Promise<AuthMode> {
    return this.authSelfCheck().authMode;
  }

  /** Inspect ~/.codex/auth.json + the ambient env to determine the auth mode (no model call). */
  authSelfCheck(): CodexAuthSelfCheck {
    const strayApiKeyDetected = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
    const oauthSessionPresent = this.hasOauthSession();
    return {
      authMode: oauthSessionPresent ? CODEX_SUBSCRIPTION_AUTH_MODE : 'unauthenticated',
      oauthSessionPresent,
      strayApiKeyDetected,
    };
  }

  /**
   * Read ~/.codex/auth.json and decide whether it is a usable OAuth/ChatGPT SUBSCRIPTION session.
   * The ChatGPT-login form carries `auth_mode:'chatgpt'` + a `tokens` object (id_token/access_token/
   * refresh_token/account_id) and OPENAI_API_KEY:null. We accept it iff there is a non-empty `tokens`
   * object AND there is no real (non-null, non-empty) `OPENAI_API_KEY` baked into the file (an api-key
   * auth.json is NOT the subscription path). Robust to a missing/malformed file (returns false).
   */
  private hasOauthSession(): boolean {
    const file = join(this.resolveCodexHome(), 'auth.json');
    if (!existsSync(file)) return false;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        auth_mode?: unknown;
        tokens?: unknown;
        OPENAI_API_KEY?: unknown;
      };
      const tokens = raw.tokens;
      const hasTokens =
        tokens !== null &&
        typeof tokens === 'object' &&
        typeof (tokens as { access_token?: unknown }).access_token === 'string' &&
        (tokens as { access_token: string }).access_token.length > 0;
      const fileApiKey = raw.OPENAI_API_KEY;
      const hasRealApiKeyInFile = typeof fileApiKey === 'string' && fileApiKey.length > 0;
      // Subscription iff there is an OAuth token AND the file is NOT an api-key file. We do NOT hard-
      // require auth_mode==='chatgpt' (forward-compat for a renamed mode) — the token+no-key shape is
      // the real signal — but if auth_mode IS present it must not name an api-key mode.
      const apiKeyMode = raw.auth_mode === 'apikey' || raw.auth_mode === 'api_key';
      return hasTokens && !hasRealApiKeyInFile && !apiKeyMode;
    } catch {
      return false;
    }
  }

  /**
   * Build the CURATED child env for `new Codex({ env })`. An ALLOWLIST (HOME/PATH/CODEX_HOME/LANG/
   * LC_x/TMPDIR + the per-run MCP bearer token) that EXCLUDES OPENAI_API_KEY/CODEX_API_KEY/
   * OPENAI_BASE_URL/CODEX_BASE_URL — so a stray key STRUCTURALLY cannot reach the subprocess (the
   * #1 mis-billing guard; index.js sets the child env to EXACTLY what we pass). Exported via the
   * Tier-1 golden's caller so a regression that leaks a key into the curated env is caught.
   */
  private buildCuratedEnv(mcpToken: string): Record<string, string> {
    return buildCuratedCodexEnv(process.env, mcpToken, this.codexHome);
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const preCheck = this.authSelfCheck();
    const authMode: AuthMode = ctx.authMode ?? preCheck.authMode;

    // C2: run-core is the SINGLE per-run seq authority. Emit SEQ-LESS through ctx.onEvent; run-core's
    // wrapped sink stamps the one monotonic seq across the adapter's events AND dispatchTool's events.
    const emit = (e: NeutralEventInput) => ctx.onEvent?.(e as NeutralEvent);
    await emit({ type: 'run_started', runId: ctx.runId });

    const llmIdemKey = `llm:${this.runHash(spec)}:0`;

    // ---- REPLAY = neutral-journal step short-circuit ------------------------------------------
    if (ctx.replay) {
      const replayed = await this.replayFromJournal(spec, authMode, ctx);
      if (replayed) return replayed;
    }

    // ---- in-proc MCP tool bridge (the ONLY sanctioned tool path → ctx.dispatchTool) -------------
    // The per-run MCP bearer token. The bridge + the scratch cwd are allocated INSIDE the try below so
    // that a setup failure (httpServer.listen / mcp.connect / mkdirSync) becomes a NEUTRAL error
    // RunResult (never a throw out of run()) AND the finally still tears the bridge down (no leak). The
    // scratch cwd is the SINGLE fixed dir (CODEX_SCRATCH_CWD) reused across runs — NOT torn down.
    const mcpToken = randomBytes(24).toString('hex');
    const toolEvents = { count: 0 };
    let bridge: Awaited<ReturnType<CodexAdapter['startMcpBridge']>> | null = null;
    let cwd: string | undefined;
    const startedAt = Date.now();

    // The neutral re-derivation source: typed thread items observed on the stream (adapter-internal,
    // NEVER the SoT). agent_message text + the dispatched tool parts (from dispatchTool's own
    // correlation) compose the transcript.
    let finalText = '';
    let structuredText: string | undefined;
    const reasoningTexts: string[] = [];
    let status: 'completed' | 'error' = 'completed';
    let errorMessage: string | undefined;
    // OBS-01: the neutral class of a failed run. A codex turn.failed/error carries only a
    // `message` string (no HTTP status object), so we run it through classifyUpstreamError (message
    // heuristics for rate-limit/5xx/timeout); default `internal` — never a mis-tag.
    let errorClass: ErrorClass = 'internal';
    let errorRetryAfter: number | undefined;
    let usage: Usage = emptyUsage();
    // Defense-in-depth: a (rare) second agent_message in one turn must not double-emit a text_delta.
    // We keep finalText = LAST agent_message (as before) but only EMIT the first one as a delta.
    let emittedText = false;

    const abort = new AbortController();
    try {
      // The sandbox confinement + tool bridge are allocated HERE (inside try) so a setup throw yields a
      // neutral error RunResult and the finally tears everything down.
      bridge =
        spec.tools.length > 0
          ? await this.startMcpBridge(spec, ctx, emit, mcpToken, toolEvents)
          : null;
      // The SINGLE fixed empty read-only scratch dir, reused across runs. A fixed path bounds codex's
      // `~/.codex/config.toml` `[projects]` registration to AT MOST ONE entry for it (never one-per-run)
      // AND avoids creating+deleting a temp dir on every run. (Verified empirically: codex 0.142.2 under our exact
      // `skipGitRepoCheck:true` non-interactive config writes ZERO `[projects]` entries either way — the
      // observed accretion was from non-skip/interactive probes — so this is honest belt-and-suspenders,
      // not an active-bug fix.) Created idempotently (no throw if it already exists); kept INSIDE the try
      // so a setup throw still yields a neutral error RunResult and the finally teardown runs. NOT removed
      // in the finally: it is shared across (concurrent) runs + read-only-confined (codex cannot write into
      // it — it stays empty), so removing it would break a concurrent run.
      mkdirSync(CODEX_SCRATCH_CWD, { recursive: true });
      cwd = CODEX_SCRATCH_CWD;
      const codex = new Codex({
        ...(this.codexPathOverride ? { codexPathOverride: this.codexPathOverride } : {}),
        // The CURATED env — NO api key, NO base url, plus the per-run MCP bearer token. This is the
        // structural mis-billing guard (the subprocess inherits ONLY these vars).
        env: this.buildCuratedEnv(mcpToken),
        // The in-proc MCP server (only when the run has tools) + the auto-approve key so a non-
        // interactive exec does not cancel the tool call.
        ...(bridge
          ? {
              config: {
                mcp_servers: {
                  [MCP_SERVER_NAME]: {
                    url: bridge.url,
                    bearer_token_env_var: MCP_TOKEN_ENV,
                    default_tools_approval_mode: MCP_TOOLS_APPROVAL_MODE,
                  },
                },
              },
            }
          : {}),
      });
      const thread = codex.startThread({
        model: spec.model,
        // Sandbox CONFINEMENT — read-only sandbox, no network, no web search, never-approve, empty cwd.
        sandboxMode: 'read-only',
        networkAccessEnabled: false,
        webSearchEnabled: false,
        approvalPolicy: 'never',
        workingDirectory: cwd,
        skipGitRepoCheck: true,
      });

      const { events } = await thread.runStreamed(this.buildPrompt(spec), {
        ...(spec.outputSchema ? { outputSchema: spec.outputSchema.schema } : {}),
        signal: abort.signal,
      });

      for await (const rawEvent of events) {
        const ev = rawEvent as CodexThreadEvent;
        if (ev.type === 'item.completed' || ev.type === 'item.updated') {
          const item = ev.item;
          if (!item) continue;
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            // The agent's final response (or, with outputSchema, the JSON). On `item.completed` it is
            // the whole message — keep the LAST one as finalText/structured, but EMIT only the FIRST
            // agent_message text as a text_delta (defense-in-depth: a rare 2nd one must not double-emit).
            if (ev.type === 'item.completed') {
              finalText = item.text;
              if (spec.outputSchema) structuredText = item.text;
              if (!emittedText) {
                emittedText = true;
                await emit({ type: 'text_delta', runId: ctx.runId, text: item.text });
              }
            }
          } else if (item.type === 'reasoning' && typeof item.text === 'string') {
            if (ev.type === 'item.completed') {
              reasoningTexts.push(item.text);
              await emit({ type: 'reasoning_delta', runId: ctx.runId, text: item.text });
            }
          }
          // mcp_tool_call items are NOT emitted here: ctx.dispatchTool (called by the MCP handler) OWNS
          // tool_called/tool_result/tool_error + the journal step (avoid the Pi double-emit bug). The
          // command_execution/file_change/web_search/todo_list items are confined built-ins — with the
          // read-only/no-network sandbox they are inert; we never surface them as neutral tool events.
        } else if (ev.type === 'turn.completed') {
          usage = neutralUsageFromCodex(ev.usage) ?? usage;
        } else if (ev.type === 'turn.failed') {
          status = 'error';
          const classified = classifyUpstreamError(ev.error?.message ?? 'codex turn failed');
          errorMessage = classified.message;
          errorClass = classified.errorClass;
          errorRetryAfter = classified.retryAfter;
        } else if (ev.type === 'error') {
          status = 'error';
          const classified = classifyUpstreamError(ev.message ?? 'codex stream error');
          errorMessage = classified.message;
          errorClass = classified.errorClass;
          errorRetryAfter = classified.retryAfter;
        }
      }
    } catch (err) {
      status = 'error';
      const classified = classifyUpstreamError(err);
      errorMessage = classified.message;
      errorClass = classified.errorClass;
      errorRetryAfter = classified.retryAfter;
    } finally {
      // Tear down: abort any in-flight child (never leak a process) + close the MCP bridge. Guarded
      // because the bridge is allocated INSIDE the try — a setup throw leaves it unset, and it must
      // STILL be cleaned (no leak) if partially allocated. The scratch cwd is NOT torn down: it is the
      // SINGLE fixed dir shared across (concurrent) runs and read-only-confined (codex cannot write
      // into it — it stays empty + no state accumulates), so removing it would break concurrent runs.
      abort.abort();
      if (bridge) await bridge.close();
    }

    // The dispatched tool_call/tool_result parts the bridge collected (correlated by the real callId in
    // the MCP handler) — read AFTER the finally since `bridge` is now assigned inside the try.
    const toolParts = bridge?.toolParts ?? [];
    const latencyMs = Date.now() - startedAt;

    // ---- ONE `llm` journal step per thread.run() (one turn; codex runs the loop in-subprocess) ---
    // Tool steps are journaled by ctx.dispatchTool (toolEvents.count). On an ERROR run the step is
    // recorded with status='error' + the classified { error, errorClass } in the output jsonb so
    // GET /v1/runs/{id} can DERIVE the class from the failing step (mirrors the other adapters).
    const output = this.deriveOutput(spec, structuredText, finalText);
    const llmStep: StepReport = {
      type: 'llm',
      idempotencyKey: llmIdemKey,
      inputHash: hashJson({ input: spec.input }),
      output:
        status === 'error'
          ? {
              error: errorMessage,
              errorClass,
              ...(errorRetryAfter !== undefined ? { retryAfter: errorRetryAfter } : {}),
            }
          : { finalText, output, reasoningCount: reasoningTexts.length },
      usage,
      // costUsd is RE-COMPUTED authoritatively in run-core from the registry; pass our estimate for
      // back-compat. Codex on the subscription bills $0 (run-core applies the subscription rule).
      costUsd: costUsd(spec.model, usage.inputTokens, usage.outputTokens),
      // Codex/the SDK surface NO provider cost — leave providerCostUsd unset (journal records null).
      model: spec.model,
      producedBy: CODEX_PRODUCED_BY,
      latencyMs,
      status: status === 'error' ? 'error' : 'ok',
    };
    await ctx.journal.record({ ...llmStep, authMode });

    // ---- REAL conversation re-derivation -------------------------------------------------------
    // On an ERROR run there is no trustworthy transcript -> [] (matches openai/anthropic/pi error
    // shape so the cross-backend parity gate holds over the error scenario).
    const conversation =
      status === 'error'
        ? []
        : deriveConversation(spec, reasoningTexts, toolParts, finalText, output);

    await emit({
      type: 'run_completed',
      runId: ctx.runId,
      status: status === 'completed' ? 'ok' : 'error',
      usage,
    });

    const toolStepCount = toolEvents.count;
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode,
      status,
      finalText: status === 'error' ? '' : finalText,
      // Key-presence: output ALWAYS set — native structured output when requested, else null.
      output: status === 'error' ? null : output,
      // Key-presence: error ALWAYS present (the message on error, null otherwise).
      error: errorMessage ?? null,
      // OBS-01: errorClass is always-present — the neutral class on error, null on success.
      errorClass: status === 'error' ? errorClass : null,
      conversation,
      usage,
      costUsd: costUsd(spec.model, usage.inputTokens, usage.outputTokens),
      // One llm step (the turn) + the dispatched tool steps — the real per-step total.
      stepCount: 1 + toolStepCount,
    };
  }

  /**
   * Start the IN-PROCESS streamable-HTTP MCP server for this run's neutral tools. Each tool's handler
   * is an INLINE closure that ONLY marshals args -> ctx.dispatchTool(name, args, toolCallId) -> returns
   * the opaque tool_data/tool_error into the MCP tool-RESULT channel. The adapter holds NO handler; the
   * gate (gate:adapter-handlers) requires the inline ctx.dispatchTool call on every registerTool().
   *
   * Returns the loopback `url` codex connects to (bearer-token-guarded), a `close()` teardown, and the
   * `toolParts` array the run() re-derivation reads (the dispatched tool_call/tool_result parts, joined
   * by the SAME callId the journal step carries).
   */
  private async startMcpBridge(
    spec: AgentSpec,
    ctx: RunContext,
    emit: (e: NeutralEventInput) => unknown,
    mcpToken: string,
    toolEvents: { count: number },
  ): Promise<{
    url: string;
    close: () => Promise<void>;
    toolParts: { call: ConvPart; result: ConvPart }[];
  }> {
    const toolParts: { call: ConvPart; result: ConvPart }[] = [];
    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' });

    for (const t of spec.tools) {
      // Project the neutral JSON-Schema parameters into a Zod raw shape so the model fills the REAL
      // fields (the AUTHORITATIVE validate-in still runs inside ctx.dispatchTool against the neutral
      // JSON-Schema). A non-object/unschemaable spec falls back to a single passthrough field.
      const { shape, usedArgsFallback } = jsonSchemaToZodShape(t.parameters);
      mcp.registerTool(
        t.name,
        { description: t.description, inputSchema: shape },
        // INLINE handler: marshal args -> ctx.dispatchTool -> opaque result into the MCP channel.
        async (rawArgs: unknown, extra: unknown) => {
          // The MCP RequestHandlerExtra carries the per-call `requestId` (verified live: a numeric id,
          // distinct per call) — use it as the REAL correlation id so two calls journal distinct rows.
          const toolCallId = extractMcpToolCallId(extra);
          const argsForDispatch = usedArgsFallback ? unwrapMcpArgs(rawArgs) : rawArgs;
          if (!ctx.dispatchTool) {
            const message = `tool '${t.name}' has no dispatcher (no sanctioned tool path)`;
            await emit({
              type: 'tool_error',
              runId: ctx.runId,
              toolCallId: toolCallId ?? `tool:${t.name}`,
              name: t.name,
              message,
            });
            return mcpResult(JSON.stringify({ kind: 'tool_error', name: t.name, message }), true);
          }
          toolEvents.count++;
          const result: ToolDispatchResult = await ctx.dispatchTool(
            t.name,
            argsForDispatch,
            toolCallId,
          );
          // Record the neutral tool_call/tool_result parts for the transcript re-derivation, joined by
          // the SAME callId the journal step + the emitted events carry (untrusted-content boundary: a tool result is DATA).
          // The stored `result` is the FULL opaque dispatch wrapper (tool_data/tool_error) — matches
          // the openai adapter's fixture, so the cross-backend parity gate holds for both outcomes.
          const callId = result.toolCallId;
          toolParts.push({
            call: { kind: 'tool_call', toolCallId: callId, name: t.name, args: argsForDispatch },
            result: { kind: 'tool_result', toolCallId: callId, name: t.name, result },
          });
          return mcpResult(JSON.stringify(result), result.kind === 'tool_error');
        },
      );
    }

    // One session-managed streamable-HTTP transport per run (a fresh server per run, torn down after).
    // It mints a per-run Mcp-Session-Id via sessionIdGenerator because the MCP SDK forbids reusing a
    // STATELESS transport across requests (the very shape GHSA-345p-7cg4-v4c7 patches), and our run
    // issues initialize → tools/call over this one transport. The MCP SDK parses the JSON-RPC; we only
    // buffer the body + cap its size + guard the bearer token + bind to loopback (only our child can
    // reach it). Connected below (inside the init try) so a mid-init failure cleans up + rethrows
    // instead of leaking.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString('hex'),
    });

    // The bearer value codex must present (compared constant-time below). Buffer once.
    const expectedAuth = Buffer.from(`Bearer ${mcpToken}`);

    const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Bearer-token guard (constant-time): ONLY a request carrying our per-run token is served
      // (defense-in-depth on top of the loopback bind). A missing/wrong token is rejected before the
      // transport sees it; the comparison is constant-time so it cannot be guessed via timing.
      if (!bearerMatches(req.headers.authorization, expectedAuth)) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end('not found');
        return;
      }
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      let rejectedTooLarge = false;
      req.on('data', (c: Buffer) => {
        if (rejectedTooLarge) return;
        bodyBytes += c.length;
        // Bound the buffered body (the child is loopback-only, but a runaway/malformed request must
        // not exhaust memory). Over the cap → 413 and stop buffering (never reach the transport).
        if (bodyBytes > MCP_MAX_BODY_BYTES) {
          rejectedTooLarge = true;
          if (!res.headersSent) res.writeHead(413).end('payload too large');
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (rejectedTooLarge) return;
        let body: unknown;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        } catch {
          body = undefined;
        }
        transport.handleRequest(req, res, body).catch((e: unknown) => {
          if (!res.headersSent) res.writeHead(500).end(String(e));
        });
      });
    });

    // Connect the MCP server + bind to loopback. If any step mid-init throws, close whatever was
    // already allocated before re-throwing (no partial-init leak) — the run()'s try/finally then turns
    // the throw into a neutral error RunResult.
    try {
      await mcp.connect(transport);
      // A `listen` error (e.g. EADDRINUSE) must REJECT the listen promise rather than hang.
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      });
    } catch (initErr) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve())).catch(() => {});
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
      try {
        await mcp.close();
      } catch {
        /* best-effort */
      }
      throw initErr;
    }
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/mcp`;

    const close = async (): Promise<void> => {
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
      try {
        await mcp.close();
      } catch {
        /* best-effort */
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    };

    return { url, close, toolParts };
  }

  /** Build the model prompt: fold the trusted instructions + the task into one input (codex has no system slot). */
  private buildPrompt(spec: AgentSpec): string {
    // Both instructions + input are TRUSTED spec content (tool RESULTS remain the untrusted, opaque-
    // wrapped data). codex `run(input)` has no separate system slot, so we concatenate with a clear
    // "Developer instructions / Task" framing.
    if (!spec.instructions) return spec.input;
    return `Developer instructions:\n${spec.instructions}\n\nTask:\n${spec.input}`;
  }

  /** Derive `output` — native structured output (parsed finalResponse JSON) when requested, else null. */
  private deriveOutput(
    spec: AgentSpec,
    structuredText: string | undefined,
    finalText: string,
  ): unknown {
    if (!spec.outputSchema) return null;
    // The native path: finalResponse is the JSON (codex --output-schema). Parse the structured text
    // (the agent_message under an outputSchema), falling back to a best-effort parse of finalText.
    return tryParseJson(structuredText ?? finalText) ?? null;
  }

  /** Deterministic per-run hash used as the llm idempotency-key prefix. */
  private runHash(spec: AgentSpec): string {
    return hashJson({ name: spec.name, input: spec.input, model: spec.model });
  }

  /**
   * Replay reconstruction: rebuild the neutral RunResult from the neutral journal + the
   * rehydrated ConversationStore WITHOUT spawning codex. Returns null if the run is not journaled (the
   * llm step is not cached) — no live re-run masquerading as replay.
   */
  private async replayFromJournal(
    spec: AgentSpec,
    authMode: AuthMode,
    ctx: RunContext,
  ): Promise<RunResult | null> {
    const cached = await ctx.journal.lookup(`llm:${this.runHash(spec)}:0`);
    if (!cached) return null;

    const stepOut = cached.output as CodexLlmStepOutput | null;
    const finalText = stepOut?.finalText ?? '';
    const output = spec.outputSchema ? (stepOut?.output ?? null) : null;

    const rehydrated = ctx.rehydrate
      ? await ctx.rehydrate()
      : deriveConversation(spec, [], [], finalText, output);
    const conversation = ctx.rehydrate ? reattachTrustedSystemTurn(spec, rehydrated) : rehydrated;
    const toolStepCount = countToolParts(conversation);

    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: emptyUsage(),
    } as NeutralEvent);

    return {
      runId: ctx.runId,
      backend: this.id,
      authMode,
      status: 'completed',
      finalText,
      output,
      error: null,
      errorClass: null,
      conversation,
      // Usage/cost are DROPPED on replay (no new spend) — metered on the live run.
      usage: emptyUsage(),
      costUsd: 0,
      stepCount: 1 + toolStepCount,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Exported pure projections (Tier-1 wire goldens drive these — flipping them breaks a golden).
// ---------------------------------------------------------------------------------------

/**
 * Build the CURATED codex child env (the mis-billing structural guard). An ALLOWLIST that EXCLUDES
 * OPENAI_API_KEY / CODEX_API_KEY / OPENAI_BASE_URL / CODEX_BASE_URL — so a stray key in `source` can
 * NEVER reach the codex subprocess (the SDK sets the child env to EXACTLY this when `env` is passed).
 * Exported so the Tier-1 wire golden asserts the REAL projection: a regression that lets a key through
 * (or drops a needed var) breaks the golden. The per-run MCP bearer token is injected under
 * RAYSPEC_MCP_TOKEN; LC_* locale vars + an optional codexHome (CODEX_HOME) are carried through.
 */
export function buildCuratedCodexEnv(
  source: NodeJS.ProcessEnv,
  mcpToken: string,
  codexHome?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  // The fixed allowlist (only these ambient vars cross into the child).
  for (const key of ['HOME', 'PATH', 'LANG', 'TMPDIR', 'TMP', 'TEMP']) {
    const v = source[key];
    if (typeof v === 'string' && v.length > 0) env[key] = v;
  }
  // Locale LC_* vars (LC_ALL/LC_CTYPE/…) — carried through so the child's locale matches.
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && typeof value === 'string' && value.length > 0) env[key] = value;
  }
  // CODEX_HOME: from the ambient env, or the adapter's explicit override (where auth.json lives).
  const home = source.CODEX_HOME ?? codexHome;
  if (typeof home === 'string' && home.length > 0) env.CODEX_HOME = home;
  // The per-run MCP bearer token (the bridge guard) — codex reads it via bearer_token_env_var.
  env[MCP_TOKEN_ENV] = mcpToken;
  // EXPLICITLY NOT INCLUDED (structural mis-billing guard): OPENAI_API_KEY, CODEX_API_KEY,
  // OPENAI_BASE_URL, CODEX_BASE_URL — never copied, so the subscription OAuth path is forced.
  return env;
}

/** The keys a stray-mis-billing leak would put in the curated env — for the golden's negative assertion. */
export const CODEX_FORBIDDEN_ENV_KEYS: readonly string[] = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_BASE_URL',
];

/**
 * Convert a single neutral JSON-Schema node into a FAITHFUL Zod type (mirrors the
 * anthropic adapter's `jsonSchemaToZodType` verbatim). The codex MCP bridge advertises the projected
 * Zod RAW SHAPE as `registerTool({ inputSchema })`, and the MCP server validates the model's tool
 * arguments against it with `safeParseAsync` (doc-first verified in @modelcontextprotocol/sdk@1.29.0,
 * `mcp.js:174`) BEFORE our handler runs — so a malformed NESTED arg now gets rejected at the model
 * boundary and drives the SDK's repair loop, instead of a SHALLOW schema (array→array(unknown),
 * object→record) letting it through to a late dispatchTool rejection (the MaxTurns churn the codex
 * adapter shared with the earlier anthropic/pi adapters).
 *
 * Untrusted-content boundary / over-rejection guard (CRITICAL): the projected schema is a
 * SUBSET of the neutral contract, NEVER stricter. We do NOT inject `additionalProperties:false`
 * (z.object STRIPS unknown keys by default — never REJECTS them) and honor ONLY the schema's own
 * `required` list, so the model-facing schema can only reject args ctx.dispatchTool's AUTHORITATIVE
 * ajv (byte-unchanged) would ALSO reject. Anything unschemaable maps to z.unknown() (accept-anything),
 * keeping us strictly looser than dispatchTool's ajv. Codex uses Zod (like anthropic), so it ignores
 * `format` entirely and does NOT need Pi's TypeBox/stripSchemaNode/format machinery.
 *
 *  - string                 -> z.string()      (+ z.enum/z.literal for enum/const)
 *  - integer                -> z.number().refine(Number.isInteger)  (NOT z.number().int(), which clamps
 *                              to the JS safe-integer range and OVER-rejects |v|>2^53 that ajv's
 *                              `{type:'integer'}` ACCEPTS — a subset violation; this accepts large
 *                              integers, still rejects 3.5)
 *  - number                 -> z.number()
 *  - boolean                -> z.boolean()
 *  - array{items}           -> z.array(<recurse items>)   (no items -> z.array(z.unknown()))
 *  - object{properties}     -> z.object({ <recurse each prop, required vs .optional()> })
 *                              (object without properties -> z.record(z.string(), z.unknown()))
 *  - enum / const (any type)-> z.enum([...]) / z.literal(v)
 *  - unknown / unschemaable -> z.unknown()
 */
export function jsonSchemaToZodType(node: unknown): z.ZodTypeAny {
  if (!node || typeof node !== 'object') return z.unknown();
  const schema = node as Record<string, unknown>;

  // enum / const carry the tightest faithful constraint, independent of `type`.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum;
    if (values.every((v) => typeof v === 'string')) {
      return values.length === 1
        ? z.literal(values[0] as string)
        : z.enum(values as [string, ...string[]]);
    }
    // Mixed/non-string enum: a union of literals over the JSON-primitive members. A non-primitive
    // member (object/array/null) can't be faithfully literal'd -> accept anything (dispatchTool gates).
    const primitives = values.filter(
      (v): v is string | number | boolean =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    );
    if (primitives.length !== values.length) return z.unknown();
    const literals = primitives.map((v) => z.literal(v));
    if (literals.length === 1) return literals[0] as z.ZodTypeAny;
    return z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  if ('const' in schema) {
    const c = schema.const;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean')
      return z.literal(c);
    return z.unknown();
  }

  switch (schema.type) {
    case 'string':
      return z.string();
    case 'integer':
      // Faithful to dispatchTool's ajv (accepts ANY integer value; no safe-int clamp). `.int()` would
      // OVER-reject |v|>2^53 ajv accepts (a subset violation). `refine(Number.isInteger)` matches
      // ajv exactly: accepts large integers, rejects 3.5.
      return z.number().refine((v) => Number.isInteger(v));
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = schema.items;
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        return z.array(jsonSchemaToZodType(items));
      }
      return z.array(z.unknown());
    }
    case 'object': {
      const props = schema.properties;
      if (!props || typeof props !== 'object') return z.record(z.string(), z.unknown());
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
        const zt = jsonSchemaToZodType(raw);
        shape[key] = required.has(key) ? zt : zt.optional();
      }
      // An object with an empty properties map still validates as "an object" (subset-safe).
      return z.object(shape);
    }
    default:
      // No (or an unrecognized) `type` -> accept anything; dispatchTool stays the authoritative gate.
      return z.unknown();
  }
}

/**
 * Project a neutral JSON-Schema `parameters` object into a Zod RAW SHAPE for the MCP registerTool()
 * inputSchema (which requires a Zod raw shape). The model fills these TOP-LEVEL fields directly, so we
 * map each to a FAITHFUL Zod type (recursing nested arrays/objects via jsonSchemaToZodType)
 * so the MCP server's validate-and-repair catches malformed NESTED args at the model
 * boundary. The AUTHORITATIVE validation still runs in ctx.dispatchTool against the FULL neutral
 * JSON-Schema. A non-object / unschemaable spec falls back to a single passthrough field. Mirrors the
 * anthropic adapter's projection (same contract). The projected schema is a SUBSET of the neutral
 * contract — never stricter (see jsonSchemaToZodType's over-rejection guard). Exported so the
 * Tier-1 golden pins it.
 */
export function jsonSchemaToZodShape(parameters: Record<string, unknown>): {
  shape: Record<string, z.ZodTypeAny>;
  /** True iff the projection fell back to the single `{ args: z.unknown() }` shape. */
  usedArgsFallback: boolean;
} {
  const props = parameters?.properties;
  if (parameters?.type !== 'object' || !props || typeof props !== 'object') {
    return { shape: { args: z.unknown() }, usedArgsFallback: true };
  }
  const required = new Set(
    Array.isArray(parameters.required) ? (parameters.required as string[]) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    const zt = jsonSchemaToZodType(raw);
    shape[key] = required.has(key) ? zt : zt.optional();
  }
  if (Object.keys(shape).length > 0) return { shape, usedArgsFallback: false };
  return { shape: { args: z.unknown() }, usedArgsFallback: true };
}

// ---------------------------------------------------------------------------------------
// SDK-type-free structural views + helpers
// ---------------------------------------------------------------------------------------

/** A codex thread item (SDK-type-free structural view; matches index.d.ts ThreadItem). */
interface CodexThreadItem {
  type?: string;
  text?: string;
  // mcp_tool_call: { server, tool, arguments, result, error, status }
  server?: string;
  tool?: string;
  status?: string;
}

/** A codex thread event (SDK-type-free structural view; matches index.d.ts ThreadEvent). */
interface CodexThreadEvent {
  type: string;
  item?: CodexThreadItem;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
}

/** Codex Usage shape (index.d.ts:120). */
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/** The neutral projection persisted as the llm step output (the replay source). */
interface CodexLlmStepOutput {
  finalText?: string;
  output?: unknown;
  reasoningCount?: number;
}

/** The MCP tool-result shape we return from the bridge handler (CallToolResult subset). */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Build an MCP CallToolResult and cast it through unknown to the SDK handler-return type WITHOUT
 * importing the SDK result type onto the adapter surface (runtime shape is identical).
 */
function mcpResult(text: string, isError: boolean): McpHandlerReturn {
  const r: McpToolResult = {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
  return r as unknown as McpHandlerReturn;
}

/** The opaque SDK handler-return type registerTool expects (kept off the adapter surface). */
type McpHandlerReturn = Awaited<ReturnType<Parameters<McpServer['registerTool']>[2]>>;

/**
 * Extract the REAL per-call correlation id from the MCP handler's `extra` argument. Verified live
 * (codex-sdk 0.142.2 + mcp-sdk 1.29.0): the in-proc handler receives
 *   extra.requestId = <number> (the JSON-RPC request id, distinct per call)
 * and extra._meta may carry codex turn metadata. We use requestId (stringified) as the per-call id so
 * two byte-identical calls in one run journal DISTINCT rows. Returns undefined -> dispatchTool
 * generates a uuid fallback (never collide two calls).
 */
/**
 * Constant-time bearer check for the in-proc MCP bridge. Compares the provided `Authorization` header
 * against the expected `Bearer <token>` buffer WITHOUT a short-circuit on the first differing byte (so
 * a wrong token cannot be guessed via response-timing). `timingSafeEqual` throws on unequal lengths, so
 * a length mismatch (incl. a missing/short header) is rejected first — itself constant w.r.t. the
 * secret's content. A missing/non-string header is a reject.
 */
function bearerMatches(provided: string | undefined, expected: Buffer): boolean {
  if (typeof provided !== 'string') return false;
  const providedBuf = Buffer.from(provided);
  if (providedBuf.length !== expected.length) return false;
  return timingSafeEqual(providedBuf, expected);
}

function extractMcpToolCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') return undefined;
  const e = extra as Record<string, unknown>;
  const direct = e.toolCallId ?? e.requestId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (typeof direct === 'number') return `codex-req-${direct}`;
  const meta = e._meta as Record<string, unknown> | undefined;
  const fromMeta = meta?.toolCallId ?? meta?.['codex/toolCallId'];
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  return undefined;
}

/**
 * The model's tool arguments arrive shaped by the projected Zod schema (the REAL fields). Normally
 * this is exactly the argument object to dispatch. As a defensive fallback for a single-`args` shape
 * (or a model that wraps the call in `{ args: "<json>" }`), unwrap + JSON.parse so dispatchTool's
 * neutral validate-in always sees the real argument OBJECT. Mirrors the anthropic adapter.
 */
function unwrapMcpArgs(rawArgs: unknown): unknown {
  if (
    rawArgs &&
    typeof rawArgs === 'object' &&
    Object.keys(rawArgs as Record<string, unknown>).length === 1 &&
    'args' in (rawArgs as Record<string, unknown>)
  ) {
    const inner = (rawArgs as { args: unknown }).args;
    if (typeof inner === 'string') {
      try {
        return JSON.parse(inner);
      } catch {
        return inner;
      }
    }
    if (inner !== undefined) return inner;
  }
  return rawArgs;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/**
 * Map a codex Usage to the neutral Usage. cached_input_tokens -> cacheReadTokens (Anthropic-style),
 * reasoning_output_tokens -> reasoningTokens (OpenAI-style). totalTokens = input + output (the codex
 * Usage does not surface a separate total on this surface). Returns undefined for an absent usage.
 */
function neutralUsageFromCodex(u: CodexUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const usage: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
  if (u.cached_input_tokens !== undefined && u.cached_input_tokens > 0) {
    usage.cacheReadTokens = u.cached_input_tokens;
  }
  if (u.reasoning_output_tokens !== undefined && u.reasoning_output_tokens > 0) {
    usage.reasoningTokens = u.reasoning_output_tokens;
  }
  return usage;
}

function tryParseJson(text: string | undefined): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  // Fast path: the whole text is the JSON (codex --output-schema returns the bare JSON).
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the brace-slice */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Count tool_call parts in a conversation (one dispatched tool step per call). */
function countToolParts(conversation: ConvTurn[]): number {
  let n = 0;
  for (const turn of conversation) {
    for (const part of turn.parts) if (part.kind === 'tool_call') n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// REAL conversation re-derivation (system+user trusted; reasoning + dispatched tool parts + final).
// ---------------------------------------------------------------------------------------

/**
 * Re-derive the neutral transcript. Untrusted-content boundary: the SYSTEM turn is composed ONLY from the TRUSTED
 * spec.instructions; the USER turn is the trusted spec.input — never echoed stream content. Then:
 *   - reasoning items   -> assistant turns with `reasoning` parts (codex surfaces reasoning summaries)
 *   - dispatched tools  -> an assistant tool_call turn + a tool tool_result turn, correlated by the
 *                          SAME real callId the journal step + emitted events carry (the dispatcher is
 *                          the single tool authority; we never re-derive a built-in's raw output)
 *   - the final answer  -> an assistant text turn
 * Codex confines its built-in tools (shell/apply-patch/web-search) — they are not dispatched tools, so
 * they never enter the neutral transcript (untrusted-content boundary: only opaque dispatchTool results are DATA we keep).
 */
export function deriveConversation(
  spec: AgentSpec,
  reasoningTexts: string[],
  toolParts: { call: ConvPart; result: ConvPart }[],
  finalText: string,
  output: unknown,
): ConvTurn[] {
  const turns: ConvTurn[] = [];
  let index = 0;
  const push = (role: ConvTurn['role'], parts: ConvPart[]): void => {
    if (parts.length === 0) return;
    turns.push({ role, index: index++, parts });
  };

  // Untrusted-content boundary: trusted system + user turns (never from the stream).
  push('system', [{ kind: 'text', text: spec.instructions }]);
  push('user', [{ kind: 'text', text: spec.input }]);

  // Reasoning summaries (codex surfaces them as their own items) — assistant reasoning parts.
  for (const text of reasoningTexts) {
    if (text) push('assistant', [{ kind: 'reasoning', text }]);
  }

  // The dispatched tool calls + results (correlated by the real callId), in order.
  for (const tp of toolParts) {
    push('assistant', [tp.call]);
    push('tool', [tp.result]);
  }

  // The model's final answer.
  if (finalText) push('assistant', [{ kind: 'text', text: finalText }]);

  // Structured output, when requested, is an explicit `output` part on its own turn.
  if (spec.outputSchema && output !== null && output !== undefined) {
    push('assistant', [{ kind: 'output', value: output }]);
  }

  return turns;
}

/**
 * Rebuild the replay conversation so its FIRST turn is the TRUSTED system turn (role='system',
 * spec.instructions) — IDENTICAL to the live path. On read the stored 'system' row was coerced to
 * 'user' (rehydrate.ts defense-in-depth); strip that leading coerced-system turn and re-prepend the
 * trusted system turn, re-indexing. Mirrors the openai/anthropic adapters.
 */
function reattachTrustedSystemTurn(spec: AgentSpec, rehydrated: ConvTurn[]): ConvTurn[] {
  const rest = [...rehydrated];
  const head = rest[0];
  const isCoercedTrustedSystem =
    head?.role === 'user' &&
    head.parts.length === 1 &&
    head.parts[0]?.kind === 'text' &&
    head.parts[0].text === spec.instructions;
  if (isCoercedTrustedSystem || head?.role === 'system') rest.shift();
  const trustedSystem: ConvTurn = {
    role: 'system',
    index: 0,
    parts: [{ kind: 'text', text: spec.instructions }],
  };
  const reindexed = rest.map((t, i) => ({ ...t, index: i + 1 }));
  return [trustedSystem, ...reindexed];
}
