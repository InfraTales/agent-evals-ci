// Spans in the OpenTelemetry generative AI shape, and a reader that turns a session's spans
// back into tool calls and a final response. The CI harness and the AgentCore code-based
// evaluator both use this reader, so a check means the same thing in both places.

export interface SpanEvent {
  name: string;
  attributes?: Record<string, unknown>;
}

/** A span, or (in split telemetry) an event record that carries a span's content in `body`. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  scope?: { name?: string };
  startTimeUnixNano?: number | string;
  attributes?: Record<string, unknown>;
  events?: SpanEvent[];
  body?: unknown;
}

export interface ToolCallView {
  spanId: string;
  name: string;
  /** Parsed arguments. Undefined when the telemetry didn't carry them. */
  args?: unknown;
  argsError?: string;
}

export interface TraceView {
  traceId: string;
  toolCalls: ToolCallView[];
  response?: string;
}

const OP = 'gen_ai.operation.name';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asSpanRecord(v: unknown): SpanRecord | undefined {
  if (!isRecord(v) || typeof v.traceId !== 'string' || typeof v.spanId !== 'string') return undefined;
  return v as unknown as SpanRecord;
}

function eventAttr(span: SpanRecord, eventName: string, attr: string): unknown {
  const ev = span.events?.find((e) => e.name === eventName);
  return ev?.attributes?.[attr];
}

/** Split telemetry: body.input.messages[0].content is either a string or { content: string }. */
function bodyMessage(record: SpanRecord | undefined, side: 'input' | 'output', role?: string): unknown {
  if (!record || !isRecord(record.body)) return undefined;
  const part = record.body[side];
  if (!isRecord(part) || !Array.isArray(part.messages)) return undefined;
  const msgs = part.messages as unknown[];
  const msg = role
    ? [...msgs].reverse().find((m) => isRecord(m) && m.role === role)
    : msgs[0];
  if (!isRecord(msg)) return undefined;
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (isRecord(c)) return c.content ?? c.message;
  return undefined;
}

function parseArgs(raw: unknown): { args?: unknown; argsError?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return { args: raw };
  try {
    return { args: JSON.parse(raw) };
  } catch {
    return { argsError: `tool arguments are not JSON: ${raw.slice(0, 60)}` };
  }
}

function startTime(s: SpanRecord): number {
  // Nanosecond timestamps lose precision as JS numbers, but keep their order to within a
  // fraction of a microsecond. Ties fall back to input order (Array.prototype.sort is stable).
  const n = Number(s.startTimeUnixNano ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function readTraces(sessionSpans: readonly unknown[]): Map<string, TraceView> {
  const spans: SpanRecord[] = [];
  const eventRecords = new Map<string, SpanRecord>();
  for (const raw of sessionSpans) {
    const s = asSpanRecord(raw);
    if (!s) continue;
    if (s.attributes === undefined && s.body !== undefined) eventRecords.set(s.spanId, s);
    else spans.push(s);
  }
  spans.sort((a, b) => startTime(a) - startTime(b));

  const traces = new Map<string, TraceView>();
  const view = (traceId: string): TraceView => {
    let t = traces.get(traceId);
    if (!t) {
      t = { traceId, toolCalls: [] };
      traces.set(traceId, t);
    }
    return t;
  };

  for (const s of spans) {
    const attrs = s.attributes ?? {};
    const t = view(s.traceId);
    const op = attrs[OP] ?? attrs['traceloop.span.kind'];
    if (op === 'execute_tool' || op === 'tool') {
      const name = attrs['gen_ai.tool.name'] ?? attrs['traceloop.entity.name'];
      const rawArgs =
        attrs['gen_ai.tool.call.arguments'] ??
        eventAttr(s, 'gen_ai.tool.message', 'content') ??
        bodyMessage(eventRecords.get(s.spanId), 'input') ??
        attrs['traceloop.entity.input'];
      t.toolCalls.push({ spanId: s.spanId, name: typeof name === 'string' ? name : '(unnamed)', ...parseArgs(rawArgs) });
    } else if (op === 'invoke_agent' || op === 'workflow') {
      const out =
        attrs['gen_ai.task.output'] ??
        eventAttr(s, 'gen_ai.choice', 'message') ??
        bodyMessage(eventRecords.get(s.spanId), 'output', 'assistant');
      if (typeof out === 'string') t.response = out;
    }
    const fallback = attrs['agentcore.invocation.agent_response'];
    if (t.response === undefined && typeof fallback === 'string') t.response = fallback;
  }
  return traces;
}

/** Builds spans in the generic OpenTelemetry GenAI convention while the harness runs an agent. */
export class SpanRecorder {
  readonly spans: SpanRecord[] = [];
  private seq = 0;
  private clock = 1_700_000_000_000_000_000;

  constructor(
    readonly traceId: string,
    private readonly rootSpanId = `${traceId}-0`,
  ) {}

  private next(): { spanId: string; startTimeUnixNano: number } {
    this.clock += 1_000_000;
    return { spanId: `${this.traceId}-${++this.seq}`, startTimeUnixNano: this.clock };
  }

  chat(model: string, usage?: { inputTokens?: number; outputTokens?: number }): void {
    this.spans.push({
      traceId: this.traceId,
      ...this.next(),
      parentSpanId: this.rootSpanId,
      name: 'chat',
      attributes: {
        [OP]: 'chat',
        'gen_ai.request.model': model,
        'gen_ai.usage.input_tokens': usage?.inputTokens ?? 0,
        'gen_ai.usage.output_tokens': usage?.outputTokens ?? 0,
      },
    });
  }

  tool(name: string, callId: string, args: unknown, result: unknown, status: 'success' | 'error'): void {
    this.spans.push({
      traceId: this.traceId,
      ...this.next(),
      parentSpanId: this.rootSpanId,
      name: `execute_tool ${name}`,
      attributes: {
        [OP]: 'execute_tool',
        'gen_ai.tool.name': name,
        'gen_ai.tool.call.id': callId,
        'gen_ai.tool.call.arguments': JSON.stringify(args),
        'gen_ai.tool.call.result': JSON.stringify(result),
        'gen_ai.tool.status': status,
      },
    });
  }

  finish(agentName: string, input: string, output: string | undefined): void {
    // The root span opens first, so it gets the earliest timestamp.
    this.spans.unshift({
      traceId: this.traceId,
      spanId: this.rootSpanId,
      startTimeUnixNano: 1_700_000_000_000_000_000,
      name: `invoke_agent ${agentName}`,
      attributes: {
        [OP]: 'invoke_agent',
        'gen_ai.agent.name': agentName,
        'gen_ai.task.input': input,
        ...(output === undefined ? {} : { 'gen_ai.task.output': output }),
      },
    });
  }
}
