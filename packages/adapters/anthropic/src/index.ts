/**
 * Anthropic Claude Agent SDK adapter (the abstraction's STRESS case).
 *
 * Maps the neutral Backend onto @anthropic-ai/claude-agent-sdk 0.3.185 (verified against
 * the installed sdk.d.ts AND the official docs at
 * code.claude.com/docs/en/agent-sdk/typescript). Unlike the OpenAI/Pi adapters this one is a
 * PROCESS-OF-PROCESS: the SDK spawns the bundled `claude` binary, which persists sessions as
 * on-disk JSONL under CLAUDE_CONFIG_DIR. The adapter therefore:
 *   - sets a PER-TENANT CLAUDE_CONFIG_DIR so tenants never cross-contaminate
 *   - VERIFIES the bundled binary at startup (claude --version)
 *   - runs an AUTH-MODE SELF-CHECK (reconcileAuthMode): detects a stray ANTHROPIC_API_KEY
 *     (which silently bills the API instead of the subscription)
 *   - OWNS + ABORTS the `claude` child via an AbortController (never leaks a process)
 *   - re-derives the neutral conversation from the CLI's message stream (typed content blocks),
 *     and can also re-derive from the on-disk JSONL session (reDeriveJsonl) — both adapter-internal,
 *     NEVER RaySpec's source of truth (untrusted).
 *
 * --- DOC-FIRST verified API surface used here (sdk.d.ts:symbol + official docs) -----------------
 *   - query({ prompt, options }): Query                                        (sdk.d.ts:2437)
 *       Query extends AsyncGenerator<SDKMessage> + .interrupt()                (sdk.d.ts:2182,2192)
 *   - Options.outputFormat?: OutputFormat = JsonSchemaOutputFormat             (sdk.d.ts:1638,1968)
 *       JsonSchemaOutputFormat = { type:'json_schema'; schema:Record<string,unknown> } (sdk.d.ts:868)
 *       -> NATIVE structured output; result on SDKResultSuccess.structured_output (sdk.d.ts:3879)
 *   - Options.abortController?: AbortController                                 (sdk.d.ts:1239)
 *       For a PLAIN-STRING prompt, abortController is THE cancellation mechanism (interrupt() is
 *       streaming-input-only per the official docs). We own one and abort it in `finally`.
 *   - Options.mcpServers?: Record<string, McpServerConfig>                      (sdk.d.ts:1620)
 *   - createSdkMcpServer({ name, version?, tools }): McpSdkServerConfigWithInstance (sdk.d.ts:437)
 *       "runs in-process inside your application, not as a separate process" — the tool handler is a
 *       PARENT-PROCESS closure (official custom-tools doc). This is THE bridge: the handler calls
 *       back into ctx.dispatchTool (the untrusted-content boundary chokepoint) and returns the opaque result in the MCP
 *       tool-result channel. The adapter holds NO handler.
 *   - tool(name, description, inputSchema:ZodRawShape, handler): SdkMcpToolDefinition (sdk.d.ts:6364)
 *       inputSchema is a ZOD raw shape (NOT JSON-Schema) — the SDK's hard requirement. We project the
 *       neutral JSON-Schema into a FAITHFUL recursive Zod shape (jsonSchemaToZodShape) so
 *       the SDK's in-proc MCP validate-and-repair (validateToolInput -> safeParseAsync, which runs
 *       BEFORE our handler — verified in sdk.mjs) catches a malformed NESTED arg at the model boundary;
 *       the projection is a SUBSET of the neutral contract (never stricter — Zod z.object STRIPS unknown
 *       keys, no injected `required`), and ctx.dispatchTool stays the sole AUTHORITATIVE validate-in.
 *       There is NO `strict` flag on the SDK tool surface (tool()/SdkMcpToolDefinition, sdk.d.ts:6364/
 *       3600) — the Zod shape IS the model-facing contract.
 *       handler: (args, extra) => Promise<CallToolResult> ; CallToolResult = { content:[{type:'text',text}], isError? }.
 *   - Options.allowedTools?: string[]                                          (sdk.d.ts:1287)
 *       MCP tools are exposed to the model as `mcp__<serverName>__<toolName>`; we allowlist them.
 *       allowedTools is NOT a restrictor — sdk.d.ts:1282-1283: "To restrict which tools are
 *       available, use the `tools` option instead."
 *   - Options.tools?: string[] | {type:'preset';preset:'claude_code'}          (sdk.d.ts:1343-1346)
 *       THE built-in-tool restrictor: `[]` DISABLES ALL built-in tools (Bash/Read/Write/Edit/Grep/
 *       Glob/WebFetch/ToolSearch/…); a preset/omitted enables the full Claude Code preset. We pass
 *       `tools: []` so NO built-in tool can ever execute. VERIFIED LIVE (sdk 0.3.185,
 *       claude-haiku-4-5): with `tools:[]` the in-proc MCP tool mcp__rayspec__get_weather STILL
 *       fires through the bridge (MCP comes from mcpServers+allowedTools — orthogonal to the built-in
 *       preset) and ZERO built-in tool_use blocks appear. (the headline untrusted-content boundary fix.)
 *   - Options.canUseTool?: CanUseTool                                          (sdk.d.ts:188,1292)
 *       Per-tool-call permission hook (toolName,input)=>{behavior:'allow'|'deny'}. DEFENSE-IN-DEPTH:
 *       we install a hook that ALLOWS only `mcp__<MCP_SERVER_NAME>__*` and DENIES everything else, so
 *       even if a built-in were ever reachable it cannot execute. VERIFIED LIVE alongside tools:[].
 *   - messages: SDKSystemMessage(init){apiKeySource,session_id}  (sdk.d.ts:3976), SDKAssistantMessage
 *     {message:BetaMessage}  (sdk.d.ts:2647), SDKUserMessage{message:MessageParam} (sdk.d.ts:4127),
 *     SDKResultSuccess{result,usage,total_cost_usd,structured_output,num_turns} (sdk.d.ts:3859).
 *
 * --- TOOL SUPPORT: BRIDGED (NOT fail-closed) ---------------------------------------------------
 *   The in-proc MCP server's tool handler runs in the PARENT Node process and reaches
 *   ctx.dispatchTool directly (a closure). So Anthropic tools ARE supported and route through the
 *   single untrusted-content boundary chokepoint — the adapter holds no handler. CAPABILITIES.anthropic.tools stays true.
 *   The untrusted-content boundary holds because the ONLY callable tools are the in-proc MCP ones: built-in tools
 *   are disabled (tools:[]) and a canUseTool deny hook allows only mcp__<server>__* — so every tool
 *   that CAN run is dispatched through ctx.dispatchTool and therefore opaque-wrapped + journaled
 *   exactly as OpenAI/Pi. As belt-and-suspenders the conversation re-derivation also QUARANTINES any
 *   tool_use/tool_result block whose name is not one of this run's MCP tools, so a stray built-in's
 *   raw output can never land in the neutral transcript even if one somehow fired.
 *
 * No SDK type escapes this file — everything returned is a neutral RunResult.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
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
import { classifyUpstreamError, hashJson } from '@rayspec/core';
import { z } from 'zod';

/** The single in-proc MCP server name; tools are exposed to the model as `mcp__<NAME>__<tool>`. */
const MCP_SERVER_NAME = 'rayspec';

/**
 * The pinned @anthropic-ai/claude-agent-sdk version this adapter was written + recorded against
 * (pinned exactly, zero caret/tilde — matches packages/adapters/anthropic/package.json). The
 * version-bump-re-record RULE asserts this equals the INSTALLED pinned version, so
 * bumping the SDK without re-recording the fixtures fails CI. Bump BOTH together.
 */
export const ANTHROPIC_SDK_VERSION = '0.3.185';

/** Provenance tag recorded on every journal step: SDK + adapter version. */
export const ANTHROPIC_PRODUCED_BY = `@anthropic-ai/claude-agent-sdk@${ANTHROPIC_SDK_VERSION}+adapter-anthropic`;

export interface AnthropicAdapterOptions {
  /** Root under which per-tenant CLAUDE_CONFIG_DIR directories are created. */
  configRoot: string;
  /** Optional explicit path to the `claude` binary (else the SDK auto-resolves the bundled one). */
  pathToClaudeCodeExecutable?: string;
}

export interface AuthSelfCheck {
  authMode: AuthMode;
  apiKeySource: string;
  strayApiKeyDetected: boolean;
  oauthTokenPresent: boolean;
}

/**
 * Reject a hostile raw tenant id BEFORE it reaches any path op (fail-closed, no silent path
 * collapse): a path separator (`/` or `\`), a `..` traversal segment, a NUL, an absolute-path
 * marker, or an empty id. With separators already rejected, the only remaining `..` traversal form
 * is the bare `..`. The post-resolve + realpath containment checks in configDirFor stay as
 * defense-in-depth (they are NOT removed).
 */
function assertSafeTenantId(tenantId: string): void {
  if (
    tenantId.length === 0 ||
    tenantId.includes('\0') ||
    tenantId.includes('/') ||
    tenantId.includes('\\') ||
    tenantId === '..' ||
    isAbsolute(tenantId)
  ) {
    throw new Error(
      `anthropic adapter: refusing an unsafe tenant id — a path separator, '..' traversal, absolute path, or empty id can never be contained under the configured root (tenant '${tenantId}').`,
    );
  }
}

export class AnthropicAdapter implements Backend {
  readonly id = 'anthropic' as const;
  private readonly configRoot: string;
  private readonly execPath?: string;

  constructor(opts: AnthropicAdapterOptions) {
    this.configRoot = opts.configRoot;
    this.execPath = opts.pathToClaudeCodeExecutable;
    this.assertConfigRoot();
  }

  /**
   * Boot-time guard on the config ROOT itself: the per-tenant child dirs are 0o700-guarded, but a
   * group/world-accessible ROOT would undermine the whole isolation. Assert an existing root has no
   * group/other bits (fail-closed), or create it 0o700 when absent (idempotent) — which also gives
   * configDirFor its precondition that the parent exists for the non-recursive per-tenant create.
   */
  private assertConfigRoot(): void {
    const existing = lstatSync(this.configRoot, { throwIfNoEntry: false });
    if (existing === undefined) {
      mkdirSync(this.configRoot, { recursive: true, mode: 0o700 });
      return;
    }
    if (existing.mode & 0o077) {
      throw new Error(
        `anthropic adapter: config root is group/world-accessible (${this.configRoot}).`,
      );
    }
  }

  /** Per-tenant config dir — created on demand, isolates credentials + JSONL transcripts. */
  configDirFor(tenantId: string): string {
    // Validate the RAW tenantId BEFORE any path op (fail-closed, no silent path collapse). The
    // post-resolve + realpath containment checks below stay as defense-in-depth.
    assertSafeTenantId(tenantId);
    const dir = join(this.configRoot, `tenant-${tenantId}`);
    // Containment: the target must be a DIRECT child named tenant-<id>. A separator or traversal in
    // tenantId that would place the dir anywhere else is refused, never created.
    if (dirname(resolve(dir)) !== resolve(this.configRoot)) {
      throw new Error(
        `anthropic adapter: refusing tenant config dir outside the configured root (tenant '${tenantId}').`,
      );
    }
    // ATOMIC create: a NON-recursive mkdir either creates the dir fresh (0o700) or throws EEXIST —
    // no check-then-create race. A concurrently-planted entry surfaces as EEXIST and is validated on
    // the branch below, never silently accepted (recursive:true would no-op on an existing path,
    // skipping validation). 0o700 so a tenant's credentials + on-disk JSONL transcripts are never
    // group/world-readable.
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      // The path already existed — validate the pre-existing entry.
      const existing = lstatSync(dir);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        // Never follow a symlink (or a non-directory) into place — it could redirect a tenant's dir.
        throw new Error(
          `anthropic adapter: tenant config path is a symlink or not a directory (tenant '${tenantId}').`,
        );
      }
      if (existing.mode & 0o077) {
        // An existing dir reachable by group/world is not trustworthy for credential isolation.
        throw new Error(
          `anthropic adapter: tenant config dir is group/world-accessible (tenant '${tenantId}').`,
        );
      }
    }
    // Realpath containment: after resolving every symlink, the real dir must still sit directly under
    // the real configured root (defeats a symlinked path component between the root and the dir).
    if (dirname(realpathSync(dir)) !== realpathSync(this.configRoot)) {
      throw new Error(
        `anthropic adapter: tenant config dir resolves outside the configured root (tenant '${tenantId}').`,
      );
    }
    return dir;
  }

  /** Verify the bundled `claude` binary runs at startup (process-of-process dependency). */
  verifyBinary(): { ok: boolean; version?: string; error?: string } {
    try {
      const bin = this.execPath ?? this.resolveBundledBinary();
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
      return { ok: true, version: out.trim() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Best-effort path to the platform-specific bundled binary (darwin/linux/win x64/arm64). */
  private resolveBundledBinary(): string {
    const platform = process.platform; // 'darwin' | 'linux' | 'win32'
    const arch = process.arch; // 'x64' | 'arm64'
    const pkg = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
    const req = createRequire(import.meta.url);
    try {
      const pkgJson = req.resolve(`${pkg}/package.json`);
      const dir = pkgJson.replace(/package\.json$/, '');
      const candidate = join(dir, platform === 'win32' ? 'claude.exe' : 'claude');
      if (existsSync(candidate)) return candidate;
    } catch {
      /* fall through */
    }
    return 'claude';
  }

  /**
   * Auth self-check WITHOUT making a model call: inspect the environment. The definitive
   * apiKeySource comes from the init message during a run; this pre-check surfaces a stray
   * ANTHROPIC_API_KEY before any tokens are spent.
   */
  async resolveAuth(): Promise<AuthMode> {
    return this.envAuthCheck().authMode;
  }

  /**
   * Pre-run auth self-check from the environment. Anthropic auth precedence:
   * ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN > /login.
   *  - A stray ANTHROPIC_API_KEY would silently bill the API instead of the subscription -> 'api-key'.
   *  - A CLAUDE_CODE_OAUTH_TOKEN is the sanctioned official-harness subscription path.
   *  - NEITHER present -> 'unauthenticated' (a fresh per-tenant CLAUDE_CONFIG_DIR does not reuse the
   *    global /login; absence of a stray key is not evidence of a working subscription).
   */
  envAuthCheck(): AuthSelfCheck {
    const strayApiKeyDetected = Boolean(process.env.ANTHROPIC_API_KEY);
    const oauthTokenPresent = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    let authMode: AuthMode;
    let apiKeySource: string;
    if (strayApiKeyDetected) {
      authMode = 'api-key';
      apiKeySource = 'temporary';
    } else if (oauthTokenPresent) {
      authMode = 'subscription-oauth-official-harness';
      apiKeySource = 'oauth';
    } else {
      authMode = 'unauthenticated';
      apiKeySource = 'none';
    }
    return { authMode, apiKeySource, strayApiKeyDetected, oauthTokenPresent };
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const preCheck = this.envAuthCheck();
    let authMode: AuthMode = ctx.authMode ?? preCheck.authMode;

    // Run-core is the SINGLE per-run seq authority. Emit SEQ-LESS through ctx.onEvent;
    // run-core's wrapped sink stamps the one monotonic seq across the adapter's events AND
    // dispatchTool's tool events. No adapter-local makeEventIngest (deleted).
    const emit = (e: NeutralEventInput) => ctx.onEvent?.(e as NeutralEvent);
    await emit({ type: 'run_started', runId: ctx.runId });

    const llmIdemKey = (turn: number) => `llm:${this.runHash(spec)}:${turn}`;

    // ---- REPLAY = neutral-journal step short-circuit -------------------------------------------
    if (ctx.replay) {
      const replayed = await this.replayFromJournal(spec, authMode, ctx);
      if (replayed) return replayed;
    }

    const configDir = this.configDirFor(ctx.tenantId);
    const startedAt = Date.now();

    // ---- own + abort the `claude` child (process lifecycle) ------------------------------------
    // A run that outlives/aborts MUST own + abort the spawned binary or it leaks. We pass our own
    // AbortController to the SDK and abort it in `finally` so the child is always torn down. (For a
    // plain-string prompt, abortController — not Query.interrupt() — is the documented cancellation
    // mechanism.)
    const abortController = new AbortController();

    // ---- in-proc MCP tool bridge (BRIDGED, not fail-closed) -----------------------------------
    // Register the neutral tools as an IN-PROCESS MCP server whose handler runs in THIS Node
    // process and ONLY: marshal args -> ctx.dispatchTool(name, args, toolCallId) -> return the
    // opaque tool_data/tool_error into the MCP tool-RESULT channel. The adapter holds NO handler;
    // the gate (gate:adapter-handlers) verifies every tool path routes through dispatchTool.
    const { mcpServers, allowedTools, toolEvents } = this.buildToolBridge(spec, ctx, emit);

    // The SET of tool names that ARE sanctioned (the in-proc MCP tools, both the bare neutral
    // name e.g. `get_weather` and the model-facing `mcp__rayspec__get_weather`). Used by (a) the
    // canUseTool deny hook to allow ONLY these and (b) the re-derivation quarantine to exclude any
    // block whose name is not one of them — so a stray built-in's raw output never enters the SoT.
    const sanctionedToolNames = new Set<string>();
    for (const t of spec.tools) {
      sanctionedToolNames.add(t.name);
      sanctionedToolNames.add(`mcp__${MCP_SERVER_NAME}__${t.name}`);
    }

    // Re-derivation source: the typed content blocks observed on the message stream (assistant
    // tool_use / user tool_result / text). Adapter-internal, never the SoT.
    const observed: ObservedMessage[] = [];

    let finalText = '';
    let sessionId: string | undefined;
    let structuredOutput: unknown;
    let apiKeySource = preCheck.apiKeySource;
    let status: 'completed' | 'error' = 'completed';
    let errorMessage: string | undefined;
    // OBS-01: the neutral class of a failed run. The Anthropic child (Claude Agent SDK query())
    // has NO HTTP status object — a non-success `result` carries only a `subtype`, and a thrown error
    // is a stringified child error. So we classify the SUBTYPE explicitly (below) and run a THROWN
    // error through classifyUpstreamError (message heuristics for rate-limit/overloaded/timeout).
    // Default `internal` — never a mis-tag. NEUTRAL vocabulary: no SDK error shape leaks out.
    let errorClass: ErrorClass = 'internal';
    // OBS-01: a Retry-After (seconds) the classifier captured from a THROWN child error (rate-limit/
    // 5xx), recorded into the failing journal step output so the sync endpoint can surface the header.
    let errorRetryAfter: number | undefined;
    // Per-REAL-MODEL-CALL usage — the REAL per-step ledger source.
    //
    // The Claude Agent SDK emits MULTIPLE `type:'assistant'` STREAM FRAMES for ONE real model call
    // (e.g. a `thinking` content-block frame, then the `text`/`tool_use` frame), and each frame
    // carries the SAME cumulative per-turn `message.usage`. Counting one `llm` step PER FRAME would
    // double-journal a single model call (inflating stepCount + the COMPUTED cost_usd value-metric;
    // on an api-key auth that propagates to billed_cost_usd → real over-billing). So we COALESCE the
    // frames of one model call into ONE turnUsages entry, joined by the BetaMessage `message.id`
    // (verified doc-first: stable across the frames of one response, changes for a new model call —
    // e.g. after a tool result). Because the SDK reports CUMULATIVE per-turn usage, we REPLACE the
    // entry's usage with the latest frame's (NOT sum). Belt-and-suspenders for a missing id: dedup a
    // consecutive frame whose usage is byte-identical to the previous (the message.id join is primary).
    const turnUsages: Usage[] = [];
    // The BetaMessage id of the entry currently at the tail of turnUsages, used as the coalesce join.
    let lastAssistantMessageId: string | undefined;
    let aggUsage: Usage = emptyUsage();
    let cost = 0;
    // N1: track whether the SDK ACTUALLY reported a provider cost. total_cost_usd may be
    // absent (e.g. an error/partial result); we must NOT fabricate a $0 provider cost (which would
    // surface a FALSE cost_drift against the non-zero computed cost). Stays undefined until present.
    let providerCost: number | undefined;

    try {
      const q = query({
        prompt: this.buildPrompt(spec),
        options: {
          model: spec.model,
          maxTurns: spec.maxTurns,
          cwd: configDir,
          systemPrompt: spec.instructions,
          // NATIVE structured output (replaces an earlier prompt-injection JSON hack) — capability
          // descriptor says anthropic has native structured output; honor it.
          ...(spec.outputSchema
            ? { outputFormat: { type: 'json_schema' as const, schema: spec.outputSchema.schema } }
            : {}),
          // The in-proc MCP tool bridge + its allowlist (mcp__rayspec__<tool>).
          ...(mcpServers ? { mcpServers } : {}),
          ...(allowedTools.length > 0 ? { allowedTools } : {}),
          // The untrusted-content boundary: DISABLE ALL built-in tools (Bash/Read/Write/Edit/Grep/Glob/
          // WebFetch/ToolSearch/…). `tools: []` is the documented restrictor (sdk.d.ts:1343-1346);
          // allowedTools is NOT a restrictor. The in-proc MCP tools come from mcpServers+allowedTools
          // and stay callable (verified live) — so the ONLY callable tools are the dispatchTool-backed
          // MCP ones. NO built-in tool can run outside the untrusted-content boundary chokepoint.
          tools: [],
          // Defense-in-depth: a per-call permission hook that ALLOWS only the sanctioned MCP tools
          // and DENIES everything else. Even if a built-in were ever reachable it cannot execute.
          canUseTool: makeMcpOnlyPermission(sanctionedToolNames),
          // Fully isolated per-tenant run.
          settingSources: [],
          permissionMode: 'bypassPermissions',
          env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
          abortController,
          ...(this.execPath ? { pathToClaudeCodeExecutable: this.execPath } : {}),
        },
      });

      for await (const msg of q) {
        const m = msg as AnthropicMessage;
        if (m.type === 'system' && m.subtype === 'init') {
          // AUTH-MODE SELF-CHECK from the live init message — the definitive source (note:
          // a successful subscription run reports apiKeySource='none', not 'oauth').
          apiKeySource = m.apiKeySource ?? apiKeySource;
          authMode = reconcileAuthMode(apiKeySource, preCheck);
          sessionId = m.session_id ?? sessionId;
        } else if (m.type === 'assistant') {
          // Capture the typed assistant content blocks (text + tool_use) for re-derivation, stream
          // text deltas, and accrue per-turn usage for the per-step journal.
          const blocks = m.message?.content;
          observed.push({ role: 'assistant', content: Array.isArray(blocks) ? blocks : [] });
          const text = extractAssistantText(m);
          if (text) await emit({ type: 'text_delta', runId: ctx.runId, text });
          const u = neutralUsageFromAnthropic(m.message?.usage);
          if (u) {
            // Coalesce frames of ONE real model call into ONE turnUsages entry.
            // PRIMARY join — the BetaMessage id (the same id for every frame of one model response,
            // a new id for a genuinely separate call). Same id as the tail ⇒ this is another frame of
            // the SAME call: REPLACE the entry's usage with this frame's (the SDK reports CUMULATIVE
            // per-turn usage, so the latest frame is the authoritative whole-call total — never sum).
            const messageId = m.message?.id;
            const last = turnUsages.length - 1;
            if (
              messageId !== undefined &&
              lastAssistantMessageId !== undefined &&
              messageId === lastAssistantMessageId &&
              last >= 0
            ) {
              turnUsages[last] = u;
            } else if (
              // FALLBACK (only when no usable message.id): the SDK envelope didn't carry an id, so we
              // can't join by it. Treat a CONSECUTIVE frame whose usage is byte-identical to the
              // current tail as the same call (the cumulative usage repeats across the frames) and
              // coalesce it. A distinct usage starts a new entry. The message.id join above is the
              // primary mechanism; this only guards the (unexpected) id-less stream.
              messageId === undefined &&
              lastAssistantMessageId === undefined &&
              last >= 0 &&
              usageEquals(turnUsages[last], u)
            ) {
              turnUsages[last] = u;
            } else {
              turnUsages.push(u);
            }
            lastAssistantMessageId = messageId;
          }
        } else if (m.type === 'user') {
          // User-role messages on the stream carry tool_result blocks (the CLI feeds the tool
          // output back as a user turn). Capture them for re-derivation.
          const blocks = m.message?.content;
          if (Array.isArray(blocks)) observed.push({ role: 'user', content: blocks });
        } else if (m.type === 'result') {
          sessionId = m.session_id ?? sessionId;
          if (m.subtype === 'success') {
            finalText = m.result ?? '';
            structuredOutput = m.structured_output;
            aggUsage = neutralUsageFromAnthropic(m.usage) ?? emptyUsage();
            // Only surface a provider cost when the SDK actually reported one (never default to 0).
            providerCost = m.total_cost_usd;
            cost = m.total_cost_usd ?? 0;
          } else {
            status = 'error';
            errorMessage = `result subtype=${m.subtype}`;
            // OBS-01: classify the SDK result error subtype into the neutral class. The CLI
            // exposes these four error subtypes (sdk.d.ts:3839). `error_max_turns` is a loop/turn
            // exhaustion → the neutral `timeout` class (a deadline-style limit); the budget/retry/
            // generic execution subtypes have no upstream-network analogue → honestly `internal`
            // (we never fabricate an upstream 4xx/5xx for a CLI-side limit).
            errorClass = m.subtype === 'error_max_turns' ? 'timeout' : 'internal';
          }
        }
      }
    } catch (err) {
      status = 'error';
      // OBS-01: a THROWN child error — classify (preserving the cause). The child may surface a
      // rate-limit / overloaded / timeout in its message; the heuristic catches those, else `internal`.
      const classified = classifyUpstreamError(err);
      errorMessage = classified.message;
      errorClass = classified.errorClass;
      errorRetryAfter = classified.retryAfter;
    } finally {
      // OWN + ABORT the child no matter what — never leak the spawned `claude` process.
      abortController.abort();
    }

    const latencyMs = Date.now() - startedAt;

    // ---- REAL conversation re-derivation (text + correlated tool_call/tool_result) -------------
    // Prefer the typed message-stream blocks; fall back to the on-disk JSONL session re-derivation
    // (reDeriveJsonl). The system turn is the TRUSTED spec.instructions, never re-injected
    // from the stream/JSONL. On an ERROR run there is no trustworthy transcript -> [] (matches the
    // OpenAI/Pi error-path shape, so the cross-backend parity gate holds over the error scenario).
    const derivedFromStream = deriveConversationFromObserved(
      spec,
      observed,
      finalText,
      sanctionedToolNames,
    );
    const conversation =
      status === 'error'
        ? []
        : derivedFromStream.length > 1
          ? derivedFromStream
          : sessionId
            ? prependTrustedSystem(spec, reDeriveJsonl(configDir, sessionId, sanctionedToolNames))
            : deriveConversation(spec, finalText);

    // ---- REAL per-step journal: one `llm` step per assistant turn ----------------------------
    // The dispatched tool steps are journaled by ctx.dispatchTool (toolEvents counts them). If the
    // SDK surfaced no per-turn usage, fall back to ONE llm step carrying the aggregate.
    const llmUsages = turnUsages.length > 0 ? turnUsages : [aggUsage];
    const perStepLatency = latencyMs / llmUsages.length;
    for (let i = 0; i < llmUsages.length; i++) {
      const stepUsage = llmUsages[i] ?? emptyUsage();
      const isFinal = i === llmUsages.length - 1;
      const step: StepReport = {
        type: 'llm',
        idempotencyKey: llmIdemKey(i),
        inputHash: hashJson({ input: spec.input, turn: i }),
        // Persist a NEUTRAL, SDK-free projection (final marker on the last). The opaque payload is
        // the replay cache source. The FINAL llm step carries finalText/output/sessionId/apiKeySource.
        // OBS-01: on the FINAL step of an ERROR run, also record { error, errorClass } in the
        // output jsonb so GET /v1/runs/{id} can DERIVE the classified error from the failing step.
        output: isFinal
          ? {
              finalText,
              output: this.deriveOutput(spec, structuredOutput, finalText),
              sessionId,
              apiKeySource,
              turnCount: llmUsages.length,
              ...(status === 'error'
                ? {
                    error: errorMessage,
                    errorClass,
                    ...(errorRetryAfter !== undefined ? { retryAfter: errorRetryAfter } : {}),
                  }
                : {}),
            }
          : { turnIndex: i },
        usage: stepUsage,
        // costUsd is RE-COMPUTED authoritatively in run-core from the registry; the SDK's
        // total_cost_usd is surfaced as the PROVIDER cost on the FINAL step for reconciliation.
        costUsd: isFinal ? cost : 0,
        // PROVIDER cost: Anthropic SDKResultSuccess.total_cost_usd (sdk.d.ts:3875) on
        // the FINAL llm step only (it is the whole-run reported cost). Earlier turns report none.
        // N1: mirror Pi's guard — surface providerCostUsd ONLY when total_cost_usd was
        // actually present (!== undefined); never default to 0 (a fabricated $0 would trip a FALSE
        // cost_drift against the non-zero computed cost). Absent -> journal provider_cost_usd NULL.
        ...(isFinal && providerCost !== undefined ? { providerCostUsd: providerCost } : {}),
        model: spec.model,
        producedBy: ANTHROPIC_PRODUCED_BY,
        latencyMs: perStepLatency,
        status: isFinal && status === 'error' ? 'error' : 'ok',
      };
      await ctx.journal.record({ ...step, authMode });
    }

    const output = this.deriveOutput(spec, structuredOutput, finalText);
    const toolStepCount = toolEvents.count;

    await emit({
      type: 'run_completed',
      runId: ctx.runId,
      status: status === 'completed' ? 'ok' : 'error',
      usage: aggUsage,
    });

    return {
      runId: ctx.runId,
      backend: this.id,
      authMode,
      status,
      finalText,
      // Key-presence: output ALWAYS set — native structured output when requested, else null.
      output,
      // Key-presence: error ALWAYS present (the message on error, null otherwise).
      error: errorMessage ?? null,
      // OBS-01: errorClass is always-present — the neutral class on error, null on success.
      // Guard on `status` (not on the `errorClass` default) so a completed run is unambiguously null.
      errorClass: status === 'error' ? errorClass : null,
      conversation,
      usage: aggUsage,
      costUsd: cost,
      // Real per-step total: one llm step per assistant turn + the dispatched tool steps.
      stepCount: llmUsages.length + toolStepCount,
    };
  }

  /**
   * Build the in-proc MCP tool bridge (BRIDGED, not fail-closed). Returns the mcpServers map,
   * the allowedTools allowlist (`mcp__rayspec__<tool>`), and a counter the run reads for the real
   * tool-step total. When the spec declares no tools, returns an empty bridge.
   *
   * Each MCP tool's handler is a PARENT-PROCESS closure that does ONLY: marshal args ->
   * ctx.dispatchTool(name, args, toolCallId) -> return the opaque tool_data/tool_error stringified
   * into the MCP tool-RESULT channel (CallToolResult.content[0].text, isError on a tool_error). The
   * adapter holds NO handler; dispatchTool owns validate-in/idempotency/timeout/validate-out/
   * opaque-wrap/one-journaled-step (the untrusted-content boundary chokepoint).
   */
  private buildToolBridge(
    spec: AgentSpec,
    ctx: RunContext,
    emit: (e: NeutralEventInput) => unknown,
  ): {
    mcpServers?: Record<string, ReturnType<typeof createSdkMcpServer>>;
    allowedTools: string[];
    toolEvents: { count: number };
  } {
    const toolEvents = { count: 0 };
    if (spec.tools.length === 0) return { allowedTools: [], toolEvents };

    const mcpTools = spec.tools.map((t) => {
      // tool() requires a ZOD raw shape (sdk.d.ts:6364), and the model fills THOSE fields directly.
      // We therefore project the neutral JSON-Schema `parameters` into a Zod raw shape so the model
      // calls the tool with the REAL fields (e.g. { city }) — not a single opaque `args` blob (which
      // the model fills with a JSON STRING that then fails validate-in). The AUTHORITATIVE validate-in
      // still runs inside ctx.dispatchTool against the neutral JSON-Schema; this shape only shapes the
      // model-facing call.
      //
      // Track PER TOOL whether the projection FELL BACK to the single `{ args: z.unknown() }`
      // shape (a non-object/unschemaable spec). The single-`args` UNWRAP must ONLY apply for that
      // fallback — otherwise a legit tool whose sole real property is literally named `args` would be
      // corrupted (its `{ args: ... }` object wrongly unwrapped). For a real projected shape we pass
      // the args object straight through.
      const { shape, usedArgsFallback } = jsonSchemaToZodShape(t.parameters);
      return tool(
        t.name,
        t.description,
        shape,
        // The return is the MCP CallToolResult shape, cast through unknown so the adapter never
        // imports an SDK result type onto its surface.
        async (rawArgs: unknown, extra: unknown) => {
          // The SDK exposes a per-call tool_use id on `extra` (MCP request _meta / toolCallId). Use
          // it as the REAL correlation id; dispatchTool generates a uuid fallback if absent.
          const toolCallId = extractMcpToolCallId(extra);
          // The model's actual arguments arrive as the shaped object; pass them straight to the
          // dispatcher (which re-validates against the neutral JSON-Schema inputSchema). Only unwrap a
          // single-`args` blob when THIS tool's projection used the args-fallback shape.
          const argsForDispatch = usedArgsFallback ? unwrapMcpArgs(rawArgs) : rawArgs;
          if (!ctx.dispatchTool) {
            // No dispatcher means no tools were wired — fail closed (never run anything inline).
            const message = `tool '${t.name}' has no dispatcher (no sanctioned tool path)`;
            await emit({
              type: 'tool_error',
              runId: ctx.runId,
              toolCallId: toolCallId ?? `tool:${t.name}`,
              name: t.name,
              message,
            });
            return asMcp(mcpError(JSON.stringify({ kind: 'tool_error', name: t.name, message })));
          }
          toolEvents.count++;
          const result: ToolDispatchResult = await ctx.dispatchTool(
            t.name,
            argsForDispatch,
            toolCallId,
          );
          // Return the opaque dispatcher result into the MCP tool-RESULT channel (never raw output).
          return asMcp(
            result.kind === 'tool_error'
              ? mcpError(JSON.stringify(result))
              : mcpText(JSON.stringify(result)),
          );
        },
      );
    });

    const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools: mcpTools });
    const allowedTools = spec.tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);
    return { mcpServers: { [MCP_SERVER_NAME]: server }, allowedTools, toolEvents };
  }

  /** Build the prompt. Structured output is NATIVE (outputFormat); no prompt JSON hack. */
  private buildPrompt(spec: AgentSpec): string {
    return spec.input;
  }

  /** Derive `output` — native structured output when requested, else null. */
  private deriveOutput(spec: AgentSpec, structuredOutput: unknown, finalText: string): unknown {
    if (!spec.outputSchema) return null;
    // Native path: the SDK returns structured_output. Fall back to a best-effort parse of finalText
    // only if the native field is absent (defensive — should not happen with outputFormat set).
    return structuredOutput ?? tryParseJson(finalText) ?? null;
  }

  /** Deterministic per-run hash used as the llm idempotency-key prefix. */
  private runHash(spec: AgentSpec): string {
    return hashJson({ name: spec.name, input: spec.input, model: spec.model });
  }

  /**
   * Replay reconstruction: rebuild the neutral RunResult from the neutral journal +
   * the rehydrated ConversationStore WITHOUT spawning the `claude` child. Returns null if the run
   * is not journaled (the first llm step is not cached) — no live re-run masquerading as replay.
   */
  private async replayFromJournal(
    spec: AgentSpec,
    authMode: AuthMode,
    ctx: RunContext,
  ): Promise<RunResult | null> {
    const first = await ctx.journal.lookup(`llm:${this.runHash(spec)}:0`);
    if (!first) return null;

    let lastOutput = first.output as AnthropicLlmStepOutput | null;
    let llmStepCount = 1;
    // BOUNDED by maxTurns (a run can never have more llm steps than turns) so a degenerate journal
    // can't loop; the FINAL step's turnCount tightens it when present.
    const maxProbe = lastOutput?.turnCount ?? Math.max(1, spec.maxTurns);
    for (let i = 1; i < maxProbe; i++) {
      const next = await ctx.journal.lookup(`llm:${this.runHash(spec)}:${i}`);
      if (!next) break;
      lastOutput = next.output as AnthropicLlmStepOutput | null;
      llmStepCount++;
    }

    const finalText = lastOutput?.finalText ?? '';
    const output = spec.outputSchema ? (lastOutput?.output ?? null) : null;

    const rehydrated = ctx.rehydrate
      ? prependTrustedSystem(spec, stripLeadingSystem(await ctx.rehydrate()))
      : deriveConversation(spec, finalText);
    const toolStepCount = countToolParts(rehydrated);

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
      // OBS-01: errorClass is always-present — null on the (replay) success path.
      errorClass: null,
      conversation: rehydrated,
      // Usage/cost are DROPPED on replay (no new spend) — metered on the live run.
      usage: emptyUsage(),
      costUsd: 0,
      stepCount: llmStepCount + toolStepCount,
    };
  }
}

// ---------------------------------------------------------------------------------------
// auth_mode reconciliation — kept exported for the test.
// ---------------------------------------------------------------------------------------

/**
 * Reconcile the journaled auth_mode from the live `system/init` `apiKeySource` + the env pre-check.
 *
 * Note: a SUCCESSFUL subscription-OAuth run reports `apiKeySource: 'none'` in system/init
 * (NOT 'oauth') — verified against claude-agent-sdk 0.3.185.
 *
 * Precedence:
 *   1. A stray ANTHROPIC_API_KEY (or an init apiKeySource that NAMES an API key) => 'api-key'.
 *   2. Else, OAuth token present AND init authenticated WITHOUT an API key ('none'|'oauth') =>
 *      'subscription-oauth-official-harness'.
 *   3. Else => 'unauthenticated' (never overclaim a subscription the run didn't use).
 */
export function reconcileAuthMode(
  apiKeySource: string | undefined,
  preCheck: { strayApiKeyDetected: boolean; oauthTokenPresent: boolean },
): AuthMode {
  const apiKeyBilled =
    preCheck.strayApiKeyDetected ||
    apiKeySource === 'temporary' ||
    apiKeySource === 'apikey' ||
    apiKeySource === 'ANTHROPIC_API_KEY';
  if (apiKeyBilled) return 'api-key';
  if (preCheck.oauthTokenPresent) return 'subscription-oauth-official-harness';
  return 'unauthenticated';
}

// ---------------------------------------------------------------------------------------
// SDK-type-free structural views + helpers
// ---------------------------------------------------------------------------------------

/** A typed Anthropic content block (SDK-type-free structural view; standard Messages API blocks). */
interface AnthropicContentBlock {
  type?: string;
  text?: string;
  // tool_use block (assistant): { type:'tool_use', id, name, input }
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block (user): { type:'tool_result', tool_use_id, content }
  tool_use_id?: string;
  content?: unknown;
  // thinking block: { type:'thinking', thinking }
  thinking?: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicMessage {
  type: string;
  subtype?: string;
  apiKeySource?: string;
  session_id?: string;
  result?: string;
  usage?: AnthropicUsage;
  total_cost_usd?: number;
  structured_output?: unknown;
  // `message` is the BetaMessage on an assistant frame. `id` (the BetaMessage "Unique object
  // identifier") is the coalesce join — the same id for every stream frame of ONE real
  // model call, a new id for a genuinely separate call.
  message?: { id?: string; content?: AnthropicContentBlock[] | string; usage?: AnthropicUsage };
}

/** What we capture per stream message for re-derivation (role + typed content blocks). */
interface ObservedMessage {
  role: 'assistant' | 'user';
  content: AnthropicContentBlock[];
}

/** The neutral projection persisted as the FINAL llm step output (the replay source). */
interface AnthropicLlmStepOutput {
  finalText?: string;
  output?: unknown;
  sessionId?: string;
  apiKeySource?: string;
  turnCount?: number;
}

/** The MCP tool-result shape we return from the bridge handler (CallToolResult subset). */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function mcpText(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}
function mcpError(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Cast our neutral MCP-result shape to the SDK's CallToolResult handler-return type WITHOUT
 * importing the SDK result type onto the adapter surface. The runtime shape is identical
 * ({content:[{type:'text',text}],isError?}); the cast through `unknown` keeps the SDK type out of
 * our types while satisfying the SDK's broad index-signature return contract.
 */
function asMcp(result: McpToolResult): McpHandlerReturn {
  return result as unknown as McpHandlerReturn;
}

/** The opaque SDK handler-return type the `tool()` helper expects (kept off the adapter surface). */
type McpHandlerReturn = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

/**
 * The model's tool arguments arrive shaped by the projected Zod schema (the REAL fields). Normally
 * this is exactly the argument object to dispatch. As a defensive fallback for an older single-`args`
 * shape (or a model that wraps the call in `{ args: "<json>" }`), unwrap + JSON.parse that string so
 * the neutral JSON-Schema validate-in in dispatchTool always sees the real argument OBJECT.
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

/**
 * Recursively project a single neutral JSON-Schema NODE into a FAITHFUL Zod type.
 *
 * The SDK's in-proc MCP server validates the model's tool arguments against this Zod schema
 * (validateToolInput -> safeParseAsync, verified doc-first in sdk.mjs) BEFORE our handler runs, and on
 * failure returns a tool_result error that drives the model's repair loop. A SHALLOW projection
 * (array -> z.array(z.unknown()), object -> z.record(unknown)) made that validation blind to nested
 * shape, so a weak model (e.g. Haiku) could emit a malformed nested arg (e.g. an action_items entry
 * missing `description`) and churn to MaxTurns — the late ctx.dispatchTool rejection never reaches the
 * model as a repairable tool_result in the same turn-efficient way. Recursing makes the existing
 * validate-and-repair actually catch malformed nested args at the model boundary.
 *
 * Untrusted-content-boundary / over-rejection guard (CRITICAL): the projected schema is a SUBSET of the neutral contract,
 * NEVER stricter. We do NOT inject `additionalProperties:false` (Zod z.object STRIPS unknown keys by
 * default — it never REJECTS them), and we honor ONLY the schema's own `required` list. So the
 * model-facing schema can only reject args the neutral JSON-Schema (and thus ctx.dispatchTool — the
 * sole AUTHORITATIVE validator, byte-unchanged) would ALSO reject. Anything unschemaable maps to
 * z.unknown() (accept-anything), keeping us strictly looser than dispatchTool's ajv.
 *
 *  - string                 -> z.string()      (+ z.enum/z.literal for enum/const)
 *  - integer                -> z.number().refine(Number.isInteger)
 *                              (faithful to ajv — `.int()` clamps to the JS safe-integer range and
 *                              OVER-rejects |v|>2^53 that ajv's `{type:'integer'}` ACCEPTS; this
 *                              accepts large integers, still rejects 3.5)
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
    // z.enum requires string literals; for an all-string enum use it, else fall back to a union of
    // literals (still a faithful subset). A single-value enum is a literal.
    if (values.every((v) => typeof v === 'string')) {
      return values.length === 1
        ? z.literal(values[0] as string)
        : z.enum(values as [string, ...string[]]);
    }
    // Mixed-type (or non-string) enum: a union of literals over the JSON-primitive members. If any
    // member is non-primitive (object/array/null) we cannot faithfully literal it -> accept anything
    // (dispatchTool stays the authoritative gate).
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
      // Faithful to dispatchTool's ajv, which accepts ANY integer value
      // for `{type:'integer'}` (no safe-int clamp). `z.number().int()` clamps to |v|<=2^53 and would
      // OVER-reject large integers ajv accepts (an untrusted-content-boundary subset violation). `refine(Number.isInteger)`
      // matches ajv exactly: accepts large integers, rejects non-integers (e.g. 3.5).
      return z.number().refine((v) => Number.isInteger(v));
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      // Tuple `items` (array form) is uncommon in neutral specs; recurse the single-schema form and
      // otherwise accept any element (still looser than dispatchTool).
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
 * Project a neutral JSON-Schema `parameters` object into a Zod RAW SHAPE for the SDK `tool()` helper
 * (which requires a Zod raw shape). The model fills these TOP-LEVEL fields directly, so we map each
 * to a FAITHFUL Zod type (recursing nested arrays/objects via jsonSchemaToZodType) so
 * the SDK's in-proc MCP validate-and-repair catches malformed NESTED args at the model boundary. The
 * AUTHORITATIVE validation (required, formats, additionalProperties) still runs in ctx.dispatchTool
 * against the FULL neutral JSON-Schema. A non-object / unschemaable spec falls back to a single
 * passthrough field. This keeps the contract single-sourced (the neutral JSON-Schema) while giving
 * the model real, individually-named fields to fill. The projected schema is a SUBSET of the neutral
 * contract — never stricter (see jsonSchemaToZodType's over-rejection guard).
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
  // Defensive: a schema with no usable properties still needs at least one field for the SDK.
  if (Object.keys(shape).length > 0) return { shape, usedArgsFallback: false };
  return { shape: { args: z.unknown() }, usedArgsFallback: true };
}

/** The neutral subset of the SDK's PermissionResult our deny hook returns (kept off the surface). */
type McpPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * Build the defense-in-depth permission hook (canUseTool). It ALLOWS a tool call ONLY when the
 * tool name is one of this run's sanctioned in-proc MCP tools (`mcp__<server>__*` or its bare neutral
 * name); every other tool — including any built-in (Bash/Read/Write/Edit/ToolSearch/…) — is DENIED.
 * Combined with `tools: []` this guarantees the ONLY callable tools are the dispatchTool-backed MCP
 * ones. The cast keeps the SDK's CanUseTool signature off the adapter surface.
 */
function makeMcpOnlyPermission(
  sanctioned: Set<string>,
): (toolName: string, input: Record<string, unknown>) => Promise<McpPermissionResult> {
  return async (toolName: string, input: Record<string, unknown>): Promise<McpPermissionResult> => {
    if (sanctioned.has(toolName) || toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message: `tool '${toolName}' is not a sanctioned MCP tool (built-in tools are disabled)`,
    };
  };
}

/**
 * Extract the REAL per-call tool_use id from the MCP handler's `extra` argument. Verified live
 * (claude-agent-sdk 0.3.185): the in-proc MCP handler receives
 *   extra._meta['claudecode/toolUseId'] = 'toolu_...'   (the model's real tool_use block id)
 * which is EXACTLY the id the message stream uses for the matching tool_use block — so the journal
 * step + the transcript tool_call/tool_result parts JOIN on the same real id. We also check a few
 * forward-compat aliases. Returns undefined -> dispatchTool generates a uuid fallback.
 */
function extractMcpToolCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') return undefined;
  const e = extra as Record<string, unknown>;
  const direct = e.toolUseId ?? e.tool_use_id ?? e.toolCallId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const meta = e._meta as Record<string, unknown> | undefined;
  const fromMeta = meta?.['claudecode/toolUseId'] ?? meta?.toolUseId ?? meta?.['claude/toolUseId'];
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  return undefined;
}

function extractAssistantText(m: AnthropicMessage): string {
  const content = m.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/**
 * Map an Anthropic usage shape to the neutral Usage, carrying cache tokens (sdk.d.ts:2913-2914).
 * Returns undefined for an absent usage (so the per-turn ledger only records turns that reported).
 */
function neutralUsageFromAnthropic(u: AnthropicUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const usage: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
  if (u.cache_read_input_tokens !== undefined) usage.cacheReadTokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens !== undefined) {
    usage.cacheCreationTokens = u.cache_creation_input_tokens;
  }
  return usage;
}

/**
 * Byte-identical neutral Usage equality (fallback only). Used to coalesce two CONSECUTIVE
 * id-less assistant frames carrying the same cumulative per-turn usage into one real model call when
 * the SDK envelope provided no `message.id` to join on. The message.id join is the primary mechanism.
 */
function usageEquals(a: Usage | undefined, b: Usage | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.totalTokens === b.totalTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens
  );
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
// REAL conversation re-derivation
// ---------------------------------------------------------------------------------------

/**
 * Re-derive the neutral transcript from the captured message-stream content blocks (the REAL,
 * typed source). The system turn is the TRUSTED spec.instructions — never from the stream.
 *
 *  - assistant text block        -> assistant turn, text part
 *  - assistant thinking block    -> assistant turn, reasoning part
 *  - assistant tool_use block    -> assistant turn, tool_call part (toolCallId = block.id)
 *  - user tool_result block      -> tool turn, tool_result part (toolCallId = block.tool_use_id)
 *  - user text block             -> user turn, text part
 * tool_call/tool_result correlate by the SDK's real tool_use id, so a call pairs with its result.
 *
 * QUARANTINE (defense-in-depth): if `sanctioned` is provided, any tool_use/tool_result block whose
 * tool name is NOT a sanctioned in-proc MCP tool is EXCLUDED from the neutral transcript (and its id
 * is tracked so the matching tool_result is dropped too). So even if a built-in ever fired, its raw,
 * un-opaque-wrapped, un-journaled output can never land in the RaySpec-owned transcript.
 */
export function deriveConversationFromObserved(
  spec: AgentSpec,
  observed: ObservedMessage[],
  finalText: string,
  sanctioned?: Set<string>,
): ConvTurn[] {
  const turns: ConvTurn[] = [];
  let index = 0;
  const push = (role: ConvTurn['role'], parts: ConvPart[]): void => {
    if (parts.length === 0) return;
    turns.push({ role, index: index++, parts });
  };
  // Ids of quarantined (non-sanctioned) tool_use blocks, so their tool_result is dropped too.
  const quarantinedIds = new Set<string>();

  // Trusted system instructions, never from the stream.
  push('system', [{ kind: 'text', text: spec.instructions }]);
  // The user input is the trusted spec.input (the prompt we sent), not echoed stream content.
  push('user', [{ kind: 'text', text: spec.input }]);

  let sawAssistantText = false;
  for (const msg of observed) {
    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (msg.role === 'assistant') {
          push('assistant', [{ kind: 'text', text: block.text }]);
          sawAssistantText = true;
        }
        // A user-role text block on the stream is internal CLI echo; not re-injected.
        continue;
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        push('assistant', [{ kind: 'reasoning', text: block.thinking }]);
        continue;
      }
      if (block.type === 'tool_use' && block.id && block.name) {
        const name = String(block.name);
        if (!isSanctionedTool(name, sanctioned)) {
          // Quarantine: a non-MCP (built-in) tool_use — exclude it AND its eventual result.
          quarantinedIds.add(String(block.id));
          continue;
        }
        push('assistant', [
          {
            kind: 'tool_call',
            toolCallId: String(block.id),
            name,
            args: block.input ?? null,
          },
        ]);
        continue;
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        const id = String(block.tool_use_id);
        // Quarantine: drop a result whose call was quarantined OR whose correlated tool is non-MCP.
        if (quarantinedIds.has(id) || !isSanctionedResult(turns, id, sanctioned)) continue;
        push('tool', [
          {
            kind: 'tool_result',
            toolCallId: id,
            // The tool name is correlated by id; re-derive from the matching tool_call below if needed.
            name: toolNameForCall(turns, id),
            result: normalizeToolResultContent(block.content),
          },
        ]);
      }
    }
  }

  if (!sawAssistantText && finalText) {
    push('assistant', [{ kind: 'text', text: finalText }]);
  }
  return turns;
}

/**
 * Quarantine predicate: is `name` a sanctioned in-proc MCP tool? When `sanctioned` is undefined
 * (e.g. a fixtured re-derivation with no allowlist) quarantine is OFF (legacy behavior) — but the
 * run() path ALWAYS passes the set, so production re-derivation always quarantines.
 */
function isSanctionedTool(name: string, sanctioned?: Set<string>): boolean {
  if (!sanctioned) return true;
  return sanctioned.has(name) || name.startsWith(`mcp__${MCP_SERVER_NAME}__`);
}

/**
 * Quarantine predicate for a tool_result: a result is sanctioned iff its correlated tool_call (by
 * id) was a sanctioned tool. If no matching call is found (e.g. the call block was already
 * quarantined/absent), it is NOT sanctioned — drop it.
 */
function isSanctionedResult(
  turns: ConvTurn[],
  toolCallId: string,
  sanctioned?: Set<string>,
): boolean {
  if (!sanctioned) return true;
  const name = toolNameForCallOrNull(turns, toolCallId);
  return name !== null && isSanctionedTool(name, sanctioned);
}

/** Like toolNameForCall but returns null (not the 'tool' fallback) when no matching call exists. */
function toolNameForCallOrNull(turns: ConvTurn[], toolCallId: string): string | null {
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'tool_call' && part.toolCallId === toolCallId) return part.name;
    }
  }
  return null;
}

/** Find the tool name for a tool_use id from an already-pushed tool_call part (correlation). */
function toolNameForCall(turns: ConvTurn[], toolCallId: string): string {
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'tool_call' && part.toolCallId === toolCallId) return part.name;
    }
  }
  return 'tool';
}

/** Normalize a tool_result block's `content` (string | array of text blocks) into neutral DATA. */
function normalizeToolResultContent(content: unknown): unknown {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  if (Array.isArray(content)) {
    const text = content
      .map((c) =>
        c && typeof c === 'object' && 'text' in (c as Record<string, unknown>)
          ? String((c as { text: unknown }).text)
          : '',
      )
      .join('');
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return content;
  }
  return content ?? null;
}

/**
 * Re-derive a neutral transcript from the CLI's JSONL session file (text +
 * correlated tool_use/tool_result parts). The CLI writes sessions under
 * <configDir>/projects/<encoded-cwd>/<session_id>.jsonl. Adapter-internal, NEVER the SoT.
 * Exported so the round-trip acceptance can exercise the REAL code path. Returns NON-system turns
 * (the caller prepends the trusted system turn) — a stored 'system' line is dropped.
 *
 * QUARANTINE: when `sanctioned` is provided, any tool_use/tool_result block whose tool name is not
 * a sanctioned in-proc MCP tool is EXCLUDED — a stray built-in's raw output never enters the SoT.
 */
export function reDeriveJsonl(
  configDir: string,
  sessionId: string,
  sanctioned?: Set<string>,
): ConvTurn[] {
  const file = findSessionFile(configDir, sessionId);
  if (!file) return [];
  const turns: ConvTurn[] = [];
  let index = 0;
  const push = (role: ConvTurn['role'], parts: ConvPart[]): void => {
    if (parts.length === 0) return;
    turns.push({ role, index: index++, parts });
  };
  // Ids of quarantined (non-sanctioned) tool_use blocks, so their tool_result is dropped too.
  const quarantinedIds = new Set<string>();
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const role = mapJsonlRole(entry);
      if (!role || role === 'system') continue; // stored system line dropped
      const blocks = jsonlContentBlocks(entry);
      const parts: ConvPart[] = [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ kind: 'text', text: block.text });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          parts.push({ kind: 'reasoning', text: block.thinking });
        } else if (block.type === 'tool_use' && block.id && block.name) {
          const name = String(block.name);
          if (!isSanctionedTool(name, sanctioned)) {
            quarantinedIds.add(String(block.id)); // Quarantine: drop built-in tool_use + its result
            continue;
          }
          parts.push({
            kind: 'tool_call',
            toolCallId: String(block.id),
            name,
            args: block.input ?? null,
          });
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          const id = String(block.tool_use_id);
          // Quarantine: drop a result whose call was quarantined OR whose tool is non-MCP.
          if (quarantinedIds.has(id) || !isSanctionedResult(turns, id, sanctioned)) continue;
          parts.push({
            kind: 'tool_result',
            toolCallId: id,
            name: toolNameForCall(turns, id),
            result: normalizeToolResultContent(block.content),
          });
        }
      }
      // tool_result blocks live on a user-role JSONL line; route them to a 'tool' turn so the
      // neutral role matches the part kind.
      const hasToolResult = parts.some((p) => p.kind === 'tool_result');
      if (hasToolResult && role === 'user') {
        const toolParts = parts.filter((p) => p.kind === 'tool_result');
        const otherParts = parts.filter((p) => p.kind !== 'tool_result');
        if (otherParts.length > 0) push('user', otherParts);
        push('tool', toolParts);
      } else {
        push(role, parts);
      }
    }
  } catch {
    return [];
  }
  return turns;
}

function findSessionFile(configDir: string, sessionId: string): string | undefined {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return undefined;
  const stack = [projects];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (name === `${sessionId}.jsonl` || name.includes(sessionId)) return full;
    }
  }
  return undefined;
}

function mapJsonlRole(entry: Record<string, unknown>): ConvTurn['role'] | undefined {
  const t = entry.type as string | undefined;
  if (t === 'user') return 'user';
  if (t === 'assistant') return 'assistant';
  if (t === 'system') return 'system';
  const msg = entry.message as { role?: string } | undefined;
  if (msg?.role === 'user') return 'user';
  if (msg?.role === 'assistant') return 'assistant';
  return undefined;
}

/** Extract typed content blocks from a JSONL entry's message.content (string or array). */
function jsonlContentBlocks(entry: Record<string, unknown>): AnthropicContentBlock[] {
  const msg = entry.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content as AnthropicContentBlock[];
  if (typeof entry.content === 'string') return [{ type: 'text', text: entry.content }];
  return [];
}

function tryParseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Prepend the TRUSTED system turn (spec.instructions) and re-index (never from JSONL). */
function prependTrustedSystem(spec: AgentSpec, rest: ConvTurn[]): ConvTurn[] {
  const trustedSystem: ConvTurn = {
    role: 'system',
    index: 0,
    parts: [{ kind: 'text', text: spec.instructions }],
  };
  const reindexed = rest.map((t, i) => ({ ...t, index: i + 1 }));
  return [trustedSystem, ...reindexed];
}

/**
 * Strip a leading coerced-system turn (a 'user' turn whose single text part is the instructions) so
 * the trusted system turn can be re-prepended on replay — mirrors the OpenAI adapter's handling
 * (rehydrate.ts coerces a stored 'system' row to 'user').
 */
function stripLeadingSystem(rehydrated: ConvTurn[]): ConvTurn[] {
  const rest = [...rehydrated];
  const head = rest[0];
  if (
    head?.role === 'system' ||
    (head?.role === 'user' && head.parts.length === 1 && head.parts[0]?.kind === 'text')
  ) {
    // Only strip a leading system OR a single-text user turn that is the coerced instructions row.
    if (head.role === 'system') rest.shift();
    else if (head.parts[0]?.kind === 'text') rest.shift();
  }
  return rest;
}

/**
 * TRIVIAL happy-path projection (system / user / assistant text only) — the LAST-RESORT fallback
 * when neither the message stream nor the JSONL re-derivation is available.
 */
function deriveConversation(spec: AgentSpec, finalText: string): ConvTurn[] {
  const turns: ConvTurn[] = [
    { role: 'system', index: 0, parts: [{ kind: 'text', text: spec.instructions }] },
    { role: 'user', index: 1, parts: [{ kind: 'text', text: spec.input }] },
  ];
  if (finalText) {
    turns.push({ role: 'assistant', index: 2, parts: [{ kind: 'text', text: finalText }] });
  }
  return turns;
}
