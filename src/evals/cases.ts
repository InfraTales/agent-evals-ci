import { readFileSync } from 'node:fs';
import { z } from 'zod';

const ScriptTurn = z.union([
  z.strictObject({ tools: z.array(z.strictObject({ name: z.string(), input: z.unknown() })).min(1) }),
  z.strictObject({ final: z.string() }),
  z.strictObject({ finalJson: z.unknown() }),
]);

const Expectations = z.strictObject({
  trajectory: z.strictObject({ mode: z.enum(['exact', 'in_order', 'any_order']), tools: z.array(z.string()) }).optional(),
  forbiddenTools: z.array(z.string()).optional(),
  toolArgs: z.array(z.strictObject({ tool: z.string(), match: z.record(z.string(), z.unknown()) })).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
});

export const EvalCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  input: z.string().min(1),
  /** A critical case must pass every trial. One miss fails the build. */
  critical: z.boolean().default(false),
  expect: Expectations.default({}),
  /** Scripted model turns for stub mode. Trial n replays variant n modulo the number of variants. */
  stub: z.array(z.array(ScriptTurn).min(1)).min(1),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const CasesFile = z.strictObject({ cases: z.array(EvalCase) }).superRefine((f, ctx) => {
  const seen = new Set<string>();
  for (const c of f.cases) {
    if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate case id ${c.id}` });
    seen.add(c.id);
  }
});

export const GateConfig = z.strictObject({
  trials: z.number().int().min(1).max(20),
  /** Share of all trials that must pass. */
  minPassRate: z.number().min(0).max(1),
  /** How far one case's pass rate may fall below its baseline before the build fails. */
  maxCaseDrop: z.number().min(0).max(1),
});
export type GateConfig = z.infer<typeof GateConfig>;

export const Baseline = z.strictObject({
  mode: z.string(),
  model: z.string(),
  passRate: z.number(),
  cases: z.record(z.string(), z.number()),
});
export type Baseline = z.infer<typeof Baseline>;

export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
