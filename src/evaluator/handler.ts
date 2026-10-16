// An Amazon Bedrock AgentCore code-based evaluator. AgentCore Evaluations invokes this Lambda
// function with a session's spans and expects a label back. It runs the same policy checks
// that CI runs, so production traffic is held to the rule set the pull request was tested on.
import { z } from 'zod';
import { NotEvaluable, policyChecks, type CheckResult } from '../evals/checks';
import { readTraces } from '../evals/spans';

const EvaluatorInput = z.object({
  schemaVersion: z.literal('1.0'),
  evaluatorId: z.string().optional(),
  evaluatorName: z.string().optional(),
  evaluationLevel: z.enum(['TRACE', 'TOOL_CALL', 'SESSION']),
  evaluationInput: z.object({ sessionSpans: z.array(z.unknown()) }),
  evaluationReferenceInputs: z.array(z.unknown()).optional(),
  evaluationTarget: z
    .object({ traceIds: z.array(z.string()).optional(), spanIds: z.array(z.string()).optional() })
    .nullish(),
});

export type EvaluatorResult =
  | { label: 'PASS' | 'FAIL'; value: number; explanation: string }
  | { errorCode: string; errorMessage: string };

function failed(results: CheckResult[]): string[] {
  return results.filter((r) => !r.pass).map((r) => `${r.check}: ${r.detail ?? 'failed'}`);
}

export function evaluate(event: unknown): EvaluatorResult {
  const parsed = EvaluatorInput.safeParse(event);
  if (!parsed.success) {
    return { errorCode: 'INVALID_INPUT', errorMessage: z.prettifyError(parsed.error).slice(0, 500) };
  }
  const input = parsed.data;
  if (input.evaluationLevel === 'TOOL_CALL') {
    return { errorCode: 'UNSUPPORTED_LEVEL', errorMessage: 'These checks need a whole trace. Use level TRACE or SESSION.' };
  }

  const traces = readTraces(input.evaluationInput.sessionSpans);
  const targetIds = input.evaluationTarget?.traceIds?.length ? input.evaluationTarget.traceIds : [...traces.keys()];
  if (targetIds.length === 0) return { errorCode: 'NO_TRACES', errorMessage: 'The session has no spans with a traceId.' };

  const problems: string[] = [];
  let total = 0;
  let passed = 0;
  for (const id of targetIds) {
    const trace = traces.get(id);
    if (!trace) return { errorCode: 'TRACE_NOT_FOUND', errorMessage: `No spans for target trace ${id}.` };
    let results: CheckResult[];
    try {
      results = policyChecks(trace);
    } catch (err) {
      // Missing telemetry is a setup problem. Report it as an error so it doesn't drag the score down.
      if (err instanceof NotEvaluable) return { errorCode: 'NOT_EVALUABLE', errorMessage: `trace ${id}: ${err.message}` };
      throw err;
    }
    total += results.length;
    passed += results.filter((r) => r.pass).length;
    problems.push(...failed(results).map((p) => (targetIds.length > 1 ? `${id} ${p}` : p)));
  }

  const value = Math.round((passed / total) * 100) / 100;
  return problems.length === 0
    ? { label: 'PASS', value, explanation: `All ${total} policy checks passed.` }
    : { label: 'FAIL', value, explanation: problems.join(' | ').slice(0, 1000) };
}

export const handler = async (event: unknown): Promise<EvaluatorResult> => {
  const result = evaluate(event);
  // One structured line per evaluation: label and failed checks, never the conversation itself.
  console.log(JSON.stringify({ level: 'label' in result ? result.label : result.errorCode, ...('label' in result ? { value: result.value } : {}) }));
  return Promise.resolve(result);
};
