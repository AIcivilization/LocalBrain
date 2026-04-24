import type {
  BrainToolCall,
  BrainToolDefinition,
  BrainToolExecutionContext,
  BrainToolResult,
} from './types.ts';

export class BrainToolBridge {
  private readonly maxToolCalls: number;

  constructor(maxToolCalls = 4) {
    this.maxToolCalls = maxToolCalls;
  }

  async executeToolCalls(
    calls: BrainToolCall[],
    tools: BrainToolDefinition[],
    context: BrainToolExecutionContext,
  ): Promise<BrainToolResult[]> {
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const selectedCalls = calls.slice(0, this.maxToolCalls);
    const results: BrainToolResult[] = [];

    for (const call of selectedCalls) {
      const tool = toolMap.get(call.name);
      if (!tool?.execute) {
        results.push({
          callId: call.id,
          name: call.name,
          ok: false,
          content: `tool ${call.name} is not registered with an executor`,
        });
        continue;
      }

      try {
        const result = await tool.execute(call.arguments, context);
        results.push({
          ...result,
          callId: call.id,
          name: call.name,
        });
      } catch (error: unknown) {
        results.push({
          callId: call.id,
          name: call.name,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}
