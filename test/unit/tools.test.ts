import { executeTool, OrderStore, ToolError, toolInputSchemas } from '../../src/agent/tools';

test('a delivered order refunds once up to its total, then refuses', () => {
  const store = new OrderStore();
  expect(executeTool(store, 'issue_refund', { orderId: 'A-1004', amount: 250, reason: 'damaged' })).toEqual({ refundId: 'R-0001' });
  expect(() => executeTool(store, 'issue_refund', { orderId: 'A-1004', amount: 50.01, reason: 'more' })).toThrow('more than the 50 left');
  expect(executeTool(store, 'issue_refund', { orderId: 'A-1004', amount: 50, reason: 'rest' })).toEqual({ refundId: 'R-0002' });
});

test('refunds are refused for orders that are not delivered, already refunded, or unknown', () => {
  const store = new OrderStore();
  expect(() => store.refund('A-1002', 1)).toThrow('is shipped, not delivered');
  expect(() => store.refund('A-1003', 0.01)).toThrow('more than the 0 left');
  expect(() => store.refund('A-9999', 1)).toThrow(ToolError);
});

test('each store starts from the seed, so trials never share state', () => {
  new OrderStore().refund('A-1001', 42.5);
  expect(new OrderStore().get('A-1001')?.refunded).toBe(0);
});

test('tool inputs are strict: cents only, known fields only, well-formed IDs', () => {
  const r = toolInputSchemas.issue_refund;
  expect(r.safeParse({ orderId: 'A-1001', amount: 42.5, reason: 'broken' }).success).toBe(true);
  expect(r.safeParse({ orderId: 'A-1001', amount: 19.99, reason: 'broken' }).success).toBe(true);
  expect(r.safeParse({ orderId: 'A-1001', amount: 1.005, reason: 'broken' }).success).toBe(false);
  expect(r.safeParse({ orderId: 'A-1001', amount: -1, reason: 'broken' }).success).toBe(false);
  expect(r.safeParse({ orderId: '1001', amount: 1, reason: 'broken' }).success).toBe(false);
  expect(r.safeParse({ orderId: 'A-1001', amount: 1, reason: 'broken', force: true }).success).toBe(false);
});
