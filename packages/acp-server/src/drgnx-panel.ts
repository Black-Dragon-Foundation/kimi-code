/**
 * The `_drgnx/panel` extension (drgnx's editor panel), version 1.
 *
 * The server advertises `agentCapabilities._meta["_drgnx/panel"] = {version, features}` to a client that
 * sent `clientCapabilities._meta["_drgnx/panel"] = {version: 1}`, and only with the features the engine
 * can serve:
 *  - `context`: a `_drgnx/context` notification after each turn (`used` / `size` as `usage_update`
 *    reports them, `parts` estimated from the engine's own token counting).
 *  - `compact-preview`: a `_drgnx/compact/preview` request answered from the compaction strategy
 *    (`computeCompactCount`), with no model call.
 *  - `before-tool`: a `_drgnx/before_tool` request from the tool executor's before-execute event,
 *    honouring the answer. Only a deny, a failed request or an unreadable answer stops the tool; an
 *    allow continues and never grants a permission.
 *
 * Not advertised, because the engine has no operation behind them yet: `drop` and `pin`.
 */

import { RequestError, type ClientCapabilities } from '@agentclientprotocol/sdk';
import {
  getLiveSessionById,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentToolExecutorService,
  IAgentToolSelectService,
  ISessionTokenCountingService,
  MAIN_AGENT_ID,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { denyToolExecution } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/beforeToolExecuteEvent';
import { RuntimeCompactionStrategy } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/strategy';
import type { BeforeToolExecuteEvent } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolHooks';
import type { IDisposable } from '@moonshot-ai/klient';

import type { AcpClient } from './acp-client';
import { acpToolCallId, inferToolKind } from './events-map';
import { log } from './log';

export const DRGNX_PANEL_KEY = '_drgnx/panel';
export const DRGNX_CONTEXT_METHOD = '_drgnx/context';
export const DRGNX_BEFORE_TOOL_METHOD = '_drgnx/before_tool';
export const DRGNX_COMPACT_PREVIEW_METHOD = '_drgnx/compact/preview';

const VERSION = 1;
const FEATURES = ['context', 'before-tool', 'compact-preview'];
const MAX_ITEMS = 200;
const MAX_LABEL = 256;

/** What the server advertises, or nothing when the client did not send `_drgnx/panel` version 1. */
export function panelCapability(
  client: Pick<ClientCapabilities, '_meta'> | null | undefined,
): { version: number; features: string[] } | undefined {
  const offered = (client?._meta as Record<string, { version?: unknown } | undefined> | null | undefined)?.[
    DRGNX_PANEL_KEY
  ];
  if (offered?.version !== VERSION) return undefined;
  return { version: VERSION, features: [...FEATURES] };
}

export type ContextKind = 'system' | 'tools' | 'files' | 'tool-output' | 'conversation';
const KIND_ORDER: readonly ContextKind[] = ['system', 'tools', 'files', 'tool-output', 'conversation'];

export interface DrgnxContext {
  used: number;
  size: number;
  parts: { kind: ContextKind; tokens: number }[];
}

export interface PanelItem {
  id: string;
  label: string;
  tokens: number;
}

export interface CompactPreview {
  frees: number;
  kept: PanelItem[];
  summarised: PanelItem[];
  note: string;
}

/** Estimated tokens of each part of the window, as the engine's token counting sees them. */
export type Breakdown = Partial<Record<ContextKind, number>>;

/** What the panel needs of a live session; built from the engine scope by {@link panelRuntimeFor}. */
export interface PanelRuntime {
  breakdown(): Breakdown;
  preview(): CompactPreview;
  onBeforeTool(listener: (event: BeforeToolExecuteEvent) => Promise<void>): IDisposable;
}

/** The hub's breakdown: parts with no tokens left out, in the hub's order. */
export function contextFrom(used: number, size: number, breakdown: Breakdown): DrgnxContext {
  return {
    used,
    size,
    parts: KIND_ORDER.flatMap((kind) => {
      const tokens = Math.round(breakdown[kind] ?? 0);
      return tokens > 0 ? [{ kind, tokens }] : [];
    }),
  };
}

type MessageLike = {
  readonly role: string;
  readonly id?: string;
  readonly content?: unknown;
};

function snippet(message: MessageLike): string {
  let text = '';
  if (typeof message.content === 'string') text = message.content;
  else if (Array.isArray(message.content)) {
    for (const part of message.content as { type?: string; text?: string }[]) {
      if (part.type === 'text' && typeof part.text === 'string') {
        text = part.text;
        break;
      }
    }
  }
  const one = text.replaceAll(/\s+/g, ' ').trim().slice(0, 60);
  return one.length > 0 ? `${message.role}: ${one}` : message.role;
}

function itemsOf(
  messages: readonly MessageLike[],
  from: number,
  to: number,
  tokensOf: (message: MessageLike) => number,
): PanelItem[] {
  const items: PanelItem[] = [];
  let start = from;
  if (to - from > MAX_ITEMS) {
    const folded = to - from - (MAX_ITEMS - 1);
    let tokens = 0;
    for (let i = from; i < from + folded; i++) tokens += tokensOf(messages[i]!);
    items.push({ id: `m${from}-${from + folded - 1}`, label: `${folded} earlier messages`, tokens });
    start = from + folded;
  }
  for (let i = start; i < to; i++) {
    const m = messages[i]!;
    items.push({
      id: (m.id ?? `m${i}`).slice(0, MAX_LABEL),
      label: snippet(m).slice(0, MAX_LABEL),
      tokens: tokensOf(m),
    });
  }
  return items;
}

/**
 * What a manual compaction would do now: the first `count` messages (from the compaction strategy) are
 * summarised, the rest kept. `frees` is the summarised messages' tokens, before the summary's own size.
 */
export function previewFrom(
  messages: readonly MessageLike[],
  count: number,
  tokensOf: (message: MessageLike) => number,
): CompactPreview {
  const n = Math.max(0, Math.min(count, messages.length));
  const summarised = itemsOf(messages, 0, n, tokensOf);
  const kept = itemsOf(messages, n, messages.length, tokensOf);
  return {
    frees: summarised.reduce((sum, item) => sum + item.tokens, 0),
    kept,
    summarised,
    note:
      n === 0
        ? 'nothing to compact yet'
        : 'estimate: the summary that replaces the summarised messages takes tokens of its own; no model call was made',
  };
}

/** One session's panel: the before-tool listener, the context push and the compaction preview. */
export class DrgnxPanelSession {
  private readonly listener: IDisposable;

  constructor(
    private readonly sessionId: string,
    private readonly client: Pick<AcpClient, 'extRequest' | 'extNotification'>,
    private readonly runtime: PanelRuntime,
  ) {
    this.listener = runtime.onBeforeTool((event) => this.beforeTool(event));
  }

  private async beforeTool(event: BeforeToolExecuteEvent): Promise<void> {
    const deny = (reason: string): void => {
      event.veto(denyToolExecution(reason));
    };
    try {
      const answer = (await this.client.extRequest(
        DRGNX_BEFORE_TOOL_METHOD,
        {
          sessionId: this.sessionId,
          toolCall: {
            toolCallId: acpToolCallId(event.turnId, event.toolCall.id),
            title: event.toolCall.name,
            kind: inferToolKind(event.toolCall.name),
            rawInput: event.args,
          },
        },
        event.signal,
      )) as { outcome?: unknown; reason?: unknown } | undefined;
      if (answer?.outcome === 'allow') return;
      if (answer?.outcome === 'deny') {
        deny(typeof answer.reason === 'string' ? answer.reason : 'drgnx refused this tool call');
        return;
      }
      deny('drgnx gave no valid answer to _drgnx/before_tool');
    } catch (error) {
      deny(`drgnx could not be asked before the tool ran: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Sends `_drgnx/context`. Never throws. */
  async pushContext(used: number, size: number): Promise<void> {
    try {
      await this.client.extNotification(DRGNX_CONTEXT_METHOD, {
        sessionId: this.sessionId,
        ...contextFrom(used, size, this.runtime.breakdown()),
      });
    } catch (error) {
      log.warn('acp: failed to push _drgnx/context', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  compactPreview(): CompactPreview {
    try {
      return this.runtime.preview();
    } catch (error) {
      log.error('acp: compaction preview failed', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw RequestError.internalError(undefined, 'compaction preview failed');
    }
  }

  dispose(): void {
    this.listener.dispose();
  }
}

/** The engine-backed runtime of a live session's main agent, or undefined when it is not live. */
export function panelRuntimeFor(core: Scope, sessionId: string): PanelRuntime | undefined {
  const session = getLiveSessionById(core.accessor, sessionId);
  const agent = session?.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  if (session === undefined || agent === undefined) return undefined;
  const counting = session.accessor.get(ISessionTokenCountingService);
  const get = agent.accessor;
  const messages = () => get.get(IAgentContextMemoryService).get();
  return {
    breakdown() {
      const profile = get.get(IAgentProfileService);
      const tools = get
        .get(IAgentToolSelectService)
        .defaultTools()
        .filter((tool) => tool.deferred !== true);
      const out: Breakdown = {
        system: counting.estimateText(profile.getSystemPrompt()),
        tools: counting.estimateTools(tools),
        conversation: 0,
        'tool-output': 0,
      };
      for (const message of messages()) {
        const kind = message.role === 'tool' ? 'tool-output' : 'conversation';
        out[kind] = (out[kind] ?? 0) + counting.estimateMessage(message);
      }
      return out;
    },
    preview() {
      const profile = get.get(IAgentProfileService);
      const all = messages();
      const strategy = new RuntimeCompactionStrategy(
        () => profile.resolveModelContext(),
        (message) => counting.estimateMessage(message),
      );
      return previewFrom(all, strategy.computeCompactCount(all, 'manual'), (message) =>
        counting.estimateMessage(message as (typeof all)[number]),
      );
    },
    onBeforeTool(listener) {
      return get.get(IAgentToolExecutorService).onBeforeExecuteTool(listener);
    },
  };
}
