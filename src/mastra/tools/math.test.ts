import { describe, expect, it } from 'vitest';

import { evaluateMath } from './math';

// The tools declare `execute: async ({ ... }) => ...`, so input is passed
// straight through. Narrowed here rather than reaching for `any` at each call.
const run = <T>(tool: { execute?: unknown }, input: unknown): Promise<T> =>
  (tool.execute as (i: unknown) => Promise<T>)(input);

/** A refused evaluation: no value, and a message meant to be read aloud. */
type Refused = { result: number | null; refusal: string | null };

describe('evaluateMath', () => {
  it('evaluates arithmetic with correct precedence', async () => {
    await expect(run<{ result: number }>(evaluateMath, { expression: '2 + 2 * 5' })).resolves.toMatchObject({
      expression: '2 + 2 * 5',
      result: 12,
    });
  });

  it('honours parentheses', async () => {
    const out = await run<{ result: number }>(evaluateMath, { expression: '(2 + 2) * 5' });
    expect(out.result).toBe(20);
  });

  // The tool builds a `new Function` from the input, so the character allowlist
  // is the only thing between a caller and arbitrary code execution. These are
  // the cases that must never reach the evaluator.
  it.each([
    ['process.exit(1)'],
    ['require("fs")'],
    ['globalThis'],
    ['1;process.exit(1)'],
    ['fetch("http://evil")'],
    ['[].constructor'],
  ])('refuses unsafe expression %j without evaluating it', async (expression) => {
    const out = await run<Refused>(evaluateMath, { expression });
    expect(out.result).toBeNull();
    expect(out.refusal).toMatch(/only work out arithmetic/);
  });

  // The refusal is spoken to whoever is on the call, so it must not describe the
  // filter it tripped. A caller probing for an injection should learn nothing
  // about which characters the allowlist objects to.
  it('does not echo the rejected expression or name the guard', async () => {
    const out = await run<Refused>(evaluateMath, { expression: 'process.exit(1)' });
    expect(out.refusal).not.toMatch(/process\.exit|allowlist|regex|unsafe/i);
  });

  // `**` is built from allowlisted characters, so exponentiation passes the
  // guard. That is not an injection vector, but it does let a caller ask for a
  // value past Number.MAX_SAFE_INTEGER, which comes back imprecise rather than
  // rejected. Pinned so a future tightening of the allowlist is a deliberate choice.
  it('allows exponentiation, returning an imprecise result past MAX_SAFE_INTEGER', async () => {
    const out = await run<{ result: number }>(evaluateMath, { expression: '2 ** 64' });
    expect(out.result).toBe(2 ** 64);
    expect(Number.isSafeInteger(out.result)).toBe(false);
  });

  it.each([
    ['9**9**9', 'overflows to Infinity'],
    ['1/0', 'divides by zero'],
  ])('refuses %j, which %s', async (expression) => {
    const out = await run<Refused>(evaluateMath, { expression });
    expect(out.result).toBeNull();
    expect(out.refusal).toMatch(/come out to a number/);
  });

  // Allowlisted characters still form invalid JavaScript, which on a call is
  // usually a transcription artefact rather than an attack.
  it.each([['2 + )'], ['((']])('asks for a repeat of malformed input %j', async (expression) => {
    const out = await run<Refused>(evaluateMath, { expression });
    expect(out.result).toBeNull();
    expect(out.refusal).toMatch(/say it again/);
  });

  // The point of voice-4sh: LiveKit replaces a THROWN tool error with "An
  // internal error occurred" before the model sees it, so a refusal the caller
  // should hear has to come back as an ordinary result. Nothing here may throw.
  it.each([['process.exit(1)'], ['1/0'], ['2 + )']])(
    'returns rather than throws for %j, so the message survives to the model',
    async (expression) => {
      await expect(run(evaluateMath, { expression })).resolves.toBeDefined();
    },
  );
});
