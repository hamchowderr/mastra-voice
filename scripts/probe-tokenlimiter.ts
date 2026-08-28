/**
 * A/B probe for TokenLimiter in `outputProcessors` (voice-9jm.27.1).
 *
 * TokenLimiter was removed from `defaultOutputProcessors` because on core
 * 1.47–1.55 it implemented only `processInputStep` — it had no valid output
 * hook, and instead of being ignored it wiped `result.text` and `result.steps`
 * on every non-streaming `generate()`. Core 1.56 gave it `processOutputStream`
 * and `processOutputResult`.
 *
 * The types say it is fixed. This checks the behaviour, because the types said
 * nothing useful last time either. Two agents, identical but for the processor,
 * run over the same fixtures on both paths:
 *
 *   generate()  — must keep text AND tool calls
 *   stream()    — must keep text AND tool calls, and must not hang
 *
 * Run with AIMock so it costs nothing and is deterministic:
 *   npx -y -p @copilotkit/aimock aimock -c aimock.json      # terminal 1
 *   USE_AIMOCK=true node --env-file=.env --import tsx/esm scripts/probe-tokenlimiter.ts
 */

import { env } from '../src/lib/env';
import { configureAIMock } from '../src/mastra/lib/aimock';

// Boot order matters here exactly as it does in src/mastra/index.ts: AIMock must
// rewrite the provider base URLs before any AI SDK client is constructed.
configureAIMock();

const { Agent } = await import('@mastra/core/agent');
const { TokenLimiter } = await import('@mastra/core/processors');
const { evaluateMath } = await import('../src/mastra/tools/math');
const { voiceModel } = await import('../src/mastra/lib/model');

const INSTRUCTIONS =
  'You are a terse assistant. Use evaluateMath for arithmetic.';

const build = (withLimiter: boolean) =>
  new Agent({
    id: withLimiter ? 'probe-with-limiter' : 'probe-without-limiter',
    name: withLimiter ? 'probe-with-limiter' : 'probe-without-limiter',
    instructions: INSTRUCTIONS,
    model: voiceModel,
    tools: { evaluateMath },
    outputProcessors: withLimiter ? [new TokenLimiter({ limit: 2000, strategy: 'truncate' })] : [],
  });

// Exact strings from fixtures/voice-assistant.json — AIMock matches on
// userMessage verbatim, so anything else returns "No fixture matched" and the
// probe measures nothing. First two drive a tool call; the third is plain text.
const CASES = ['What time is it right now?', '47 times 23', 'Hi, how are you?'];

type Row = {
  input: string;
  path: 'generate' | 'stream';
  limiter: boolean;
  textLen: number;
  steps: number;
  toolCalls: string[];
  ms: number;
  error?: string;
};

const rows: Row[] = [];

async function runGenerate(withLimiter: boolean, input: string): Promise<Row> {
  const t0 = Date.now();
  const base = { input, path: 'generate' as const, limiter: withLimiter };
  try {
    const r: any = await build(withLimiter).generate(input);
    const steps = r?.steps ?? [];
    return {
      ...base,
      textLen: (r?.text ?? '').length,
      steps: steps.length,
      toolCalls: steps.flatMap((s: any) => (s.toolCalls ?? []).map((c: any) => c.toolName ?? c.payload?.toolName)).filter(Boolean),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ...base, textLen: -1, steps: -1, toolCalls: [], ms: Date.now() - t0, error: (e as Error).message };
  }
}

async function runStream(withLimiter: boolean, input: string): Promise<Row> {
  const t0 = Date.now();
  const base = { input, path: 'stream' as const, limiter: withLimiter };
  try {
    const r: any = await build(withLimiter).stream(input);
    let text = '';
    const toolCalls: string[] = [];
    // A hang here is the failure mode worth catching — the voice path streams.
    const guard = setTimeout(() => {
      throw new Error('stream did not settle within 60s');
    }, 60_000);
    for await (const chunk of r.fullStream ?? r) {
      const type = chunk?.type;
      if (type === 'text-delta') text += chunk.textDelta ?? chunk.payload?.text ?? '';
      if (type === 'tool-call') toolCalls.push(chunk.toolName ?? chunk.payload?.toolName);
    }
    clearTimeout(guard);
    return { ...base, textLen: text.length, steps: -1, toolCalls: toolCalls.filter(Boolean), ms: Date.now() - t0 };
  } catch (e) {
    return { ...base, textLen: -1, steps: -1, toolCalls: [], ms: Date.now() - t0, error: (e as Error).message };
  }
}

console.log(`USE_AIMOCK=${env.USE_AIMOCK} AIMOCK_URL=${env.AIMOCK_URL}\n`);

for (const input of CASES) {
  for (const limiter of [false, true]) {
    rows.push(await runGenerate(limiter, input));
    rows.push(await runStream(limiter, input));
  }
}

console.log('path      limiter  textLen  steps  toolCalls              ms     input');
for (const r of rows) {
  console.log(
    `${r.path.padEnd(9)} ${String(r.limiter).padEnd(7)} ${String(r.textLen).padStart(7)} ${String(r.steps).padStart(6)}  ${r.toolCalls.join(',').padEnd(22)} ${String(r.ms).padStart(5)}  ${r.input}${r.error ? '  ERROR: ' + r.error : ''}`,
  );
}

// Verdict: the limiter must not empty the response or drop tool calls on either path.
let failed = false;
for (const input of CASES) {
  for (const path of ['generate', 'stream'] as const) {
    const off = rows.find((r) => r.input === input && r.path === path && !r.limiter)!;
    const on = rows.find((r) => r.input === input && r.path === path && r.limiter)!;
    const problems: string[] = [];
    if (on.error) problems.push(`errored: ${on.error}`);
    if (off.textLen > 0 && on.textLen <= 0) problems.push('limiter emptied the text');
    if (off.steps > 0 && on.steps === 0) problems.push('limiter emptied result.steps');
    if (off.toolCalls.length > 0 && on.toolCalls.length === 0) problems.push('limiter dropped tool calls');
    if (problems.length) {
      failed = true;
      console.log(`\nFAIL  ${path} / "${input}": ${problems.join('; ')}`);
    }
  }
}

console.log(failed ? '\nVERDICT: do NOT enable TokenLimiter' : '\nVERDICT: safe to enable TokenLimiter');
process.exit(failed ? 1 : 0);
