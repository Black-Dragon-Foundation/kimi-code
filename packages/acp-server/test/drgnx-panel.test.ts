import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  contextFrom,
  DrgnxPanelSession,
  panelCapability,
  previewFrom,
  type PanelRuntime,
} from '../src/drgnx-panel';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { createScriptedProvider, type ScriptedProvider } from './_helpers/scriptedProvider';

const OFFER = { _meta: { '_drgnx/panel': { version: 1 } } };

describe('panelCapability', () => {
  it('offers the features only to a client that sent version 1', () => {
    expect(panelCapability(OFFER)).toEqual({
      version: 1,
      features: ['context', 'before-tool', 'compact-preview'],
    });
    expect(panelCapability(undefined)).toBeUndefined();
    expect(panelCapability({})).toBeUndefined();
    expect(panelCapability({ _meta: { '_drgnx/panel': { version: 2 } } })).toBeUndefined();
  });
});

describe('contextFrom', () => {
  it('orders parts for the hub and leaves out empty ones', () => {
    expect(
      contextFrom(100, 1000, { conversation: 40.4, system: 30, tools: 0, 'tool-output': 10 }),
    ).toEqual({
      used: 100,
      size: 1000,
      parts: [
        { kind: 'system', tokens: 30 },
        { kind: 'tool-output', tokens: 10 },
        { kind: 'conversation', tokens: 40 },
      ],
    });
  });
});

describe('previewFrom', () => {
  const messages = [
    { role: 'user', id: 'a', content: 'first question' },
    { role: 'assistant', id: 'b', content: [{ type: 'text', text: 'an answer' }] },
    { role: 'user', content: 'second' },
  ];
  const tokens = () => 10;

  it('splits the messages into summarised and kept, without a model call', () => {
    const preview = previewFrom(messages, 2, tokens);
    expect(preview.frees).toBe(20);
    expect(preview.summarised.map((i) => i.id)).toEqual(['a', 'b']);
    expect(preview.summarised[1]!.label).toBe('assistant: an answer');
    expect(preview.kept).toEqual([{ id: 'm2', label: 'user: second', tokens: 10 }]);
  });

  it('says so when there is nothing to compact', () => {
    const preview = previewFrom(messages, 0, tokens);
    expect(preview.frees).toBe(0);
    expect(preview.note).toBe('nothing to compact yet');
  });

  it('folds the earliest messages when there are more than 200 items', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const preview = previewFrom(many, 300, tokens);
    expect(preview.summarised).toHaveLength(200);
    expect(preview.summarised[0]!.label).toBe('101 earlier messages');
    expect(preview.frees).toBe(3000);
  });
});

describe('DrgnxPanelSession before-tool', () => {
  function setup(answer: () => Promise<unknown>) {
    let listener!: (event: never) => Promise<void>;
    const runtime: PanelRuntime = {
      breakdown: () => ({}),
      preview: () => previewFrom([], 0, () => 0),
      onBeforeTool: (l) => {
        listener = l as never;
        return { dispose: vi.fn() };
      },
    };
    const extRequest = vi.fn((_method: string, _params: unknown, _signal?: AbortSignal) => answer());
    const panel = new DrgnxPanelSession('s1', { extRequest, extNotification: vi.fn() }, runtime);
    expect(panel).toBeInstanceOf(DrgnxPanelSession);
    const event = {
      turnId: 3,
      toolCall: { type: 'function', id: 'c1', name: 'Bash', arguments: null },
      args: { command: 'ls' },
      signal: new AbortController().signal,
      veto: vi.fn(),
      allow: vi.fn(),
      pass: vi.fn(),
      waitUntil: vi.fn(),
    };
    return { run: () => listener(event as never), event, extRequest };
  }

  it('sends the call to the hub and continues on allow, without granting anything', async () => {
    const { run, event, extRequest } = setup(async () => ({ outcome: 'allow' }));
    await run();
    expect(extRequest.mock.calls[0]![0]).toBe('_drgnx/before_tool');
    expect(extRequest.mock.calls[0]![1]).toMatchObject({
      sessionId: 's1',
      toolCall: { toolCallId: '3:c1', title: 'Bash', kind: 'execute', rawInput: { command: 'ls' } },
    });
    expect(event.veto).not.toHaveBeenCalled();
    expect(event.allow).not.toHaveBeenCalled();
    expect(event.pass).not.toHaveBeenCalled();
  });

  it('refuses the tool with the hub reason on deny', async () => {
    const { run, event } = setup(async () => ({ outcome: 'deny', reason: 'not here' }));
    await run();
    expect(event.veto).toHaveBeenCalledWith({ output: 'not here', isError: true });
  });

  it.each([
    ['a failed request', () => Promise.reject(new Error('link lost'))],
    ['an empty answer', async () => undefined],
    ['an unknown outcome', async () => ({ outcome: 'maybe' })],
    ['an agent-style verdict', async () => ({ verdict: 'allow' })],
  ])('refuses the tool on %s', async (_name, answer) => {
    const { run, event } = setup(answer as () => Promise<unknown>);
    await run();
    expect(event.veto).toHaveBeenCalledTimes(1);
    expect(event.allow).not.toHaveBeenCalled();
  });
});

describe('_drgnx/panel over the real engine (scripted LLM)', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let scripted: ScriptedProvider | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  type Caps = { _meta?: Record<string, unknown> };

  async function boot(offer: boolean): Promise<{ c: TestClient; caps: Caps }> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-drgnx-panel-'));
    await writeFakeModelConfig(homeDir);
    scripted = createScriptedProvider();
    const c = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
    client = c;
    c.onRequest('terminal/create', () => ({ terminalId: 'term-1' }));
    c.onRequest('terminal/output', () => ({
      output: 'ran\n',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    }));
    c.onRequest('terminal/wait_for_exit', () => ({ exitCode: 0, signal: null }));
    c.onRequest('terminal/kill', () => ({}));
    c.onRequest('terminal/release', () => ({}));
    const init = (await c.send('initialize', {
      protocolVersion: 1,
      clientCapabilities: { terminal: true, ...(offer ? OFFER : {}) },
    })) as { agentCapabilities: Caps };
    return { c, caps: init.agentCapabilities };
  }

  async function newSession(c: TestClient): Promise<string> {
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    return created.sessionId;
  }

  function bashCall(): void {
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_1',
      name: 'Bash',
      arguments: '{"command":"echo hi"}',
    });
    scripted!.mockNextText('done');
  }

  async function runBash(
    answer: (params: unknown) => unknown,
  ): Promise<{ asked: unknown[]; permissions: unknown[]; terminals: number; history: string }> {
    const { c } = await boot(true);
    const asked: unknown[] = [];
    const permissions: unknown[] = [];
    let terminals = 0;
    c.onRequest('_drgnx/before_tool', (params) => {
      asked.push(params);
      return answer(params);
    });
    c.onRequest('session/request_permission', (params) => {
      permissions.push(params);
      return { outcome: { outcome: 'selected', optionId: 'approve_once' } };
    });
    c.onRequest('terminal/create', () => {
      terminals++;
      return { terminalId: 'term-1' };
    });
    bashCall();
    const sessionId = await newSession(c);
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'run it' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    return { asked, permissions, terminals, history: JSON.stringify(scripted!.callHistory()[1]) };
  }

  it('advertises only to a client that sent version 1', async () => {
    const offered = await boot(true);
    expect(offered.caps['_meta']).toEqual({
      '_drgnx/panel': { version: 1, features: ['context', 'before-tool', 'compact-preview'] },
    });
    await client!.close();
    client = undefined;
    const plain = await boot(false);
    expect(plain.caps['_meta']?.['_drgnx/panel']).toBeUndefined();
  }, 30_000);

  it('a deny stops the tool before it asks the user or runs', async () => {
    const run = await runBash(() => ({ outcome: 'deny', reason: 'hub says no' }));
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]).toMatchObject({ toolCall: { title: 'Bash', kind: 'execute' } });
    expect(run.permissions).toHaveLength(0);
    expect(run.terminals).toBe(0);
    expect(run.history).toContain('hub says no');
  }, 30_000);

  it('an unreadable answer denies the tool', async () => {
    const run = await runBash(() => ({ nonsense: true }));
    expect(run.permissions).toHaveLength(0);
    expect(run.terminals).toBe(0);
  }, 30_000);

  it('an allow only continues: the user is still asked', async () => {
    const run = await runBash(() => ({ outcome: 'allow' }));
    expect(run.asked).toHaveLength(1);
    expect(run.permissions).toHaveLength(1);
    expect(run.terminals).toBe(1);
  }, 30_000);

  it('pushes _drgnx/context after a turn and answers a compaction preview', async () => {
    const { c } = await boot(true);
    scripted!.mockNextText('hello');
    const sessionId = await newSession(c);
    await c.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    await c.waitForSessionUpdate('usage_update', 10_000);
    const deadline = Date.now() + 5_000;
    let pushed = c.received.find((m) => m.method === '_drgnx/context');
    while (pushed === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      pushed = c.received.find((m) => m.method === '_drgnx/context');
    }
    const params = pushed?.params as {
      sessionId: string;
      used: number;
      size: number;
      parts: { kind: string; tokens: number }[];
    };
    expect(params.sessionId).toBe(sessionId);
    expect(params.size).toBe(8192);
    expect(params.used).toBeGreaterThan(0);
    expect(params.parts.map((p) => p.kind)).toContain('system');

    const preview = (await c.send('_drgnx/compact/preview', { sessionId })) as {
      frees: number;
      kept: unknown[];
      summarised: unknown[];
      note: string;
    };
    expect(preview.kept.length + preview.summarised.length).toBeGreaterThan(0);
    expect(typeof preview.note).toBe('string');
  }, 30_000);

  it('refuses a preview when the client did not ask for the extension', async () => {
    const { c } = await boot(false);
    const sessionId = await newSession(c);
    await expect(c.send('_drgnx/compact/preview', { sessionId })).rejects.toThrow();
  }, 30_000);
});
