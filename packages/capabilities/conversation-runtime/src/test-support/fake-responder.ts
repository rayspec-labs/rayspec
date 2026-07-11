/**
 * A deterministic, counting `ConversationTurnResponder` fake for unit/composition tests. It
 * DERIVES its reply from the RECEIVED input string (the fail-the-fix discipline for the
 * turn-2-saw-turn-1 law: a garbled/missing history changes the derived reply and fails the
 * asserting test), counts invocations (the zero-model-work pins), and lets a test override the
 * outcome (error arms) or inject concurrent activity via `beforeReturn`.
 */
import type { ConversationTurnResponder, TurnReplyOutcome } from '../responder.js';

export class FakeTurnResponder implements ConversationTurnResponder {
  readonly agentId: string = 'fake_responder';
  readonly historyWindow = { turns: 20, chars: 64 * 1024 };
  readonly calls: Array<{ input: string; turnRef: string }> = [];
  /** Optional hook fired before returning (simulates concurrent activity mid-"model-run"). */
  beforeReturn?: () => Promise<void>;
  /** S4: true iff `respond` was handed a live `onEvent` sink (the SSE thread). */
  receivedOnEvent = false;
  /**
   * S4 — the per-backend STREAM cardinality knob. Events forwarded through the received `onEvent`
   * BEFORE the outcome resolves (simulating a live run). Default `[]` models the OpenAI ZERO-DELTA
   * backend (no stream text → the reply arrives ONLY in the terminal frame). Set it to token/message
   * `text_delta` shapes to model Pi / Anthropic-Codex.
   */
  emit: unknown[] = [];
  /**
   * S4 SS-3 — the UNEXPECTED-THROW knob: when set, `respond` THROWS this AFTER firing any `emit`
   * events (models an infra/persist fault mid-stream — the `{ok:false}` Result path is `outcome`,
   * NOT this). The producer must still stream a terminal `conversation_reply_error` frame. A throw
   * carrying `errorClass`/`runId` exercises the best-effort extraction on the error frame.
   */
  throwError?: unknown;
  /** Override the outcome (defaults to a completed reply derived from the input). */
  outcome: (args: { input: string; turnRef: string }) => TurnReplyOutcome = ({
    input,
    turnRef,
  }) => ({
    status: 'completed',
    runId: `run-${turnRef.split(':').pop() ?? 'x'}`,
    text: `ECHO(${input})`,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });

  async respond(args: {
    input: string;
    turnRef: string;
    onEvent?: (event: unknown) => void | Promise<void>;
  }): Promise<TurnReplyOutcome> {
    this.calls.push({ input: args.input, turnRef: args.turnRef });
    if (args.onEvent) {
      this.receivedOnEvent = true;
      for (const e of this.emit) await args.onEvent(e);
    }
    await this.beforeReturn?.();
    if (this.throwError !== undefined) throw this.throwError;
    return this.outcome(args);
  }
}
