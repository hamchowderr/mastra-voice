import { describe, expect, it } from 'vitest';

import { evaluateMath } from './math';

// The tools declare `execute: async ({ ... }) => ...`, so input is passed
// straight through. Narrowed here rather than reaching for `any` at each call.
const run = <T>(tool: { execute?: unknown }, input: unknown): Promise<T> =>
  (tool.execute as (i: unknown) => Promise<T>)(input);

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
  ])('rejects unsafe expression %j', async (expression) => {
    await expect(run(evaluateMath, { expression })).rejects.toThrow(/Unsafe math expression/);
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

  it('rejects an expression that overflows to Infinity', async () => {
    await expect(run(evaluateMath, { expression: '9**9**9' })).rejects.toThrow(/finite number/);
  });

  it('rejects a division that does not produce a finite number', async () => {
    await expect(run(evaluateMath, { expression: '1/0' })).rejects.toThrow(/finite number/);
  });
});
