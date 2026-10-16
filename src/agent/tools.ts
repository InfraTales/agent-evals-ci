import { z } from 'zod';

// The order-support agent has three tools. Each input schema is the single source of truth:
// the model sees it as JSON Schema, the agent validates calls against it, and the evaluator
// checks recorded calls against it.

export const ORDER_ID = z.string().regex(/^A-\d{4}$/, 'order IDs look like A-1001');

export const toolInputSchemas = {
  lookup_order: z.strictObject({ orderId: ORDER_ID }),
  issue_refund: z.strictObject({
    orderId: ORDER_ID,
    amount: z.number().positive().multipleOf(0.01),
    reason: z.string().min(3).max(200),
  }),
  escalate_to_human: z.strictObject({
    orderId: ORDER_ID.optional(),
    summary: z.string().min(10).max(500),
  }),
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export const TOOL_NAMES = Object.keys(toolInputSchemas) as ToolName[];

export const toolDescriptions: Record<ToolName, string> = {
  lookup_order: 'Look up an order by ID. Returns status, total and the amount already refunded.',
  issue_refund: 'Refund part or all of a delivered order. Call lookup_order first.',
  escalate_to_human: 'Hand the conversation to a human agent with a short summary.',
};

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolInputSchemas, name);
}

export interface Order {
  orderId: string;
  status: 'processing' | 'shipped' | 'delivered' | 'cancelled';
  total: number;
  refunded: number;
}

/** In-memory orders. Each agent run gets a fresh copy, so trials never affect each other. */
export const SEED_ORDERS: readonly Order[] = [
  { orderId: 'A-1001', status: 'delivered', total: 42.5, refunded: 0 },
  { orderId: 'A-1002', status: 'shipped', total: 120, refunded: 0 },
  { orderId: 'A-1003', status: 'delivered', total: 19.99, refunded: 19.99 },
  { orderId: 'A-1004', status: 'delivered', total: 300, refunded: 0 },
];

export class OrderStore {
  private readonly orders = new Map<string, Order>();
  private nextRefund = 1;

  constructor(seed: readonly Order[] = SEED_ORDERS) {
    for (const o of seed) this.orders.set(o.orderId, { ...o });
  }

  get(orderId: string): Order | undefined {
    const o = this.orders.get(orderId);
    return o ? { ...o } : undefined;
  }

  /** The tool enforces the money rules itself. Evals catch bad decisions; this stops bad writes. */
  refund(orderId: string, amount: number): { refundId: string } {
    const o = this.orders.get(orderId);
    if (!o) throw new ToolError(`order ${orderId} not found`);
    if (o.status !== 'delivered') throw new ToolError(`order ${orderId} is ${o.status}, not delivered`);
    const left = Math.round((o.total - o.refunded) * 100) / 100;
    if (amount > left) throw new ToolError(`refund ${amount} is more than the ${left} left on ${orderId}`);
    o.refunded = Math.round((o.refunded + amount) * 100) / 100;
    return { refundId: `R-${String(this.nextRefund++).padStart(4, '0')}` };
  }
}

/** An error the agent should see as a tool result, not a crash. */
export class ToolError extends Error {}

export function executeTool(store: OrderStore, name: ToolName, input: unknown): unknown {
  switch (name) {
    case 'lookup_order': {
      const { orderId } = toolInputSchemas.lookup_order.parse(input);
      const order = store.get(orderId);
      if (!order) throw new ToolError(`order ${orderId} not found`);
      return order;
    }
    case 'issue_refund': {
      const { orderId, amount } = toolInputSchemas.issue_refund.parse(input);
      return store.refund(orderId, amount);
    }
    case 'escalate_to_human': {
      toolInputSchemas.escalate_to_human.parse(input);
      return { ticketId: 'T-0001', status: 'queued' };
    }
  }
}
