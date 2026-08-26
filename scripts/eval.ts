import { readFileSync } from 'fs';
import { resolve } from 'path';

import { mastra } from '../src/mastra/index';
import { env } from '../src/lib/env';
import { answerRelevancyScorer } from '../src/mastra/scorers/_example.scorers';

// ── types ─────────────────────────────────────────────────────────────────────

interface EvalCase {
  name: string;
  input: string;
  expectedTool: string | null;
  expectedKeywords: string[];
}

interface Dataset {
  agentId: string;
  thresholds: Record<string, number>;
  cases: EvalCase[];
}

interface CaseResult {
  name: string;
  pass: boolean;
  errors: string[];
  scores: Record<string, number | null>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// ── main ──────────────────────────────────────────────────────────────────────

const datasetPath = process.argv[2]
  ?? resolve(process.cwd(), 'src/mastra/scorers/datasets/_example.json');

const dataset: Dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));
const agent = mastra.getAgent(dataset.agentId);

if (!agent) {
  console.error(red(`Agent "${dataset.agentId}" not found in Mastra instance.`));
  process.exit(1);
}

console.log(bold(`\n🧪 Eval: ${dataset.agentId} — ${dataset.cases.length} cases\n`));

const results: CaseResult[] = [];
const relevancyScores: number[] = [];

for (const evalCase of dataset.cases) {
  process.stdout.write(`  ${evalCase.name} ... `);

  let responseText = '';
  let toolsCalled: string[] = [];
  let scoringInput: unknown;
  let scoringOutput: unknown;

  try {
    const generateOpts = env.USE_AIMOCK
      ? {}
      : { returnScorerData: true };

    const result = await agent.generate(
      [{ role: 'user', content: evalCase.input }],
      generateOpts as Parameters<typeof agent.generate>[1],
    );

    // A partial memory/vector failure (e.g. Postgres without the pgvector
    // extension) does not throw — generate() RETURNS with empty text and steps
    // while the already-resolved top-level toolCalls survive. Detect that and
    // fail loudly, instead of letting it masquerade as "tool not called".
    if ((result as any).error) {
      throw new Error(`generate returned an error: ${(result as any).error}`);
    }

    responseText = result.text ?? '';

    // Tool calls: read from the authoritative top-level result.toolCalls first;
    // fall back to walking steps for older cores. toolName lives at
    // tc.payload.toolName (newer) or tc.toolName (older).
    const collect = (arr: any[] | undefined) => {
      for (const tc of arr ?? []) {
        const name = tc.payload?.toolName ?? tc.toolName;
        if (name) toolsCalled.push(name);
      }
    };
    collect((result as any).toolCalls);
    if (toolsCalled.length === 0) {
      for (const step of ((result as any).steps ?? [])) collect(step.toolCalls);
    }

    // Degraded-result guard: a healthy generate always sets finishReason. If it's
    // absent AND there's no text AND no tool call, the result came back empty —
    // surface it as a hard failure rather than a confusing assertion miss.
    if ((result as any).finishReason == null && !responseText && toolsCalled.length === 0) {
      throw new Error('generate returned a degraded/empty result (finishReason=undefined) — likely a memory/vector failure');
    }

    scoringInput = (result as any).scoringData?.input;
    scoringOutput = (result as any).scoringData?.output;
  } catch (err) {
    console.log(red('ERROR'));
    console.error(`    ${err}`);
    results.push({ name: evalCase.name, pass: false, errors: [`generate failed: ${err}`], scores: {} });
    continue;
  }

  const errors: string[] = [];

  // Tool call assertion
  if (evalCase.expectedTool !== null) {
    if (!toolsCalled.includes(evalCase.expectedTool)) {
      errors.push(`expected tool "${evalCase.expectedTool}" to be called, got: [${toolsCalled.join(', ') || 'none'}]`);
    }
  } else {
    if (toolsCalled.length > 0) {
      errors.push(`expected no tool calls, got: [${toolsCalled.join(', ')}]`);
    }
  }

  // Keyword assertions
  for (const kw of evalCase.expectedKeywords) {
    if (!responseText.toLowerCase().includes(kw.toLowerCase())) {
      errors.push(`expected keyword "${kw}" in response: "${responseText.slice(0, 120)}..."`);
    }
  }

  // Scorer runs (skip under AIMock)
  const scores: Record<string, number | null> = {};

  if (!env.USE_AIMOCK && scoringInput !== undefined && scoringOutput !== undefined) {
    try {
      const relevResult = await answerRelevancyScorer.run({
        input: scoringInput as any,
        output: scoringOutput as any,
      });
      scores.answerRelevancy = relevResult.score;
      relevancyScores.push(relevResult.score);
    } catch (err) {
      console.error(yellow(`\n    ⚠ scorer error: ${err}`));
    }
  }

  const pass = errors.length === 0;
  results.push({ name: evalCase.name, pass, errors, scores });

  if (pass) {
    console.log(green('PASS'));
  } else {
    console.log(red('FAIL'));
    for (const err of errors) console.log(`    ${red('✗')} ${err}`);
  }

  const scoreStr = Object.entries(scores)
    .map(([k, v]) => `${k}=${v !== null ? v.toFixed(2) : 'n/a'}`)
    .join(' ');
  if (scoreStr) console.log(`    scores: ${scoreStr}`);
}

// ── aggregate summary ─────────────────────────────────────────────────────────

console.log(bold('\n── Aggregate Scores ─────────────────────────────────────────'));

const scorerResults: Record<string, boolean | 'skip'> = {};

const avgRelevancy = relevancyScores.length > 0
  ? relevancyScores.reduce((a, b) => a + b, 0) / relevancyScores.length
  : null;
const relevancyThreshold = dataset.thresholds.answerRelevancy ?? 0.7;
const relevancyPass = avgRelevancy === null ? 'skip' : avgRelevancy >= relevancyThreshold;
scorerResults.answerRelevancy = relevancyPass;

if (avgRelevancy === null) {
  console.log(yellow(`  answerRelevancy: n/a (skipped — AIMock or no scorer data)`));
} else if (relevancyPass) {
  console.log(green(`  answerRelevancy: ${avgRelevancy.toFixed(3)} ≥ ${relevancyThreshold} ✓`));
} else {
  console.log(red(`  answerRelevancy: ${avgRelevancy.toFixed(3)} < ${relevancyThreshold} ✗`));
}

const fieldFailCount = results.filter(r => !r.pass).length;
console.log(bold('\n── Assertion Checks ──────────────────────────────────────────'));
console.log(`  ${results.length - fieldFailCount}/${results.length} cases passed`);

const allScorersPassed = Object.values(scorerResults).every(v => v === true || v === 'skip');
const allCasesPassed = fieldFailCount === 0;
const exitCode = allCasesPassed && allScorersPassed ? 0 : 1;

if (exitCode === 0) {
  console.log(bold(green('\n✅ All checks passed\n')));
} else {
  console.log(bold(red('\n❌ Some checks failed\n')));
}

process.exit(exitCode);
