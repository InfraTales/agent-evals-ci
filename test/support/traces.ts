import type { TraceView } from '../../src/evals/spans';

export const GOOD_RESPONSE = JSON.stringify({ action: 'refunded', orderId: 'A-1001', refundAmount: 42.5, reply: 'Refunded 42.50.' });

/** A trace view built by hand, for checks that don't care how the spans looked. */
// Pass null for "no response". (A default parameter would swallow undefined.)
export function trace(calls: [string, unknown][], response: string | null = GOOD_RESPONSE): TraceView {
  return {
    traceId: 't',
    toolCalls: calls.map(([name, args], i) => ({ spanId: `s${i}`, name, args })),
    response: response ?? undefined,
  };
}

export const lookup = (orderId = 'A-1001'): [string, unknown] => ['lookup_order', { orderId }];
export const refund = (orderId = 'A-1001', amount = 42.5): [string, unknown] => ['issue_refund', { orderId, amount, reason: 'broken' }];
