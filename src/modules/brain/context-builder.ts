import type { BrainAppContext, BrainMessage, BrainProductRequest } from './types.ts';

export class BrainContextBuilder {
  build(request: BrainProductRequest): BrainMessage[] {
    const messages: BrainMessage[] = [];

    if (request.systemPrompt) {
      messages.push({
        role: 'system',
        content: request.systemPrompt,
      });
    }

    if (request.appContext) {
      messages.push({
        role: 'system',
        name: 'app-context',
        content: this.serializeAppContext(request.appContext),
      });
    }

    if (request.session?.summary) {
      messages.push({
        role: 'system',
        name: 'session-summary',
        content: request.session.summary,
      });
    }

    messages.push(...(request.session?.messages ?? []));
    messages.push({
      role: 'user',
      content: request.input,
      metadata: request.metadata,
    });

    return messages;
  }

  private serializeAppContext(context: BrainAppContext): string {
    const lines = [
      `product=${context.productName}`,
      `surface=${context.surface}`,
    ];

    if (context.userId) {
      lines.push(`userId=${context.userId}`);
    }

    if (context.locale) {
      lines.push(`locale=${context.locale}`);
    }

    if (context.constraints?.length) {
      lines.push(`constraints=${context.constraints.join(' | ')}`);
    }

    if (context.state) {
      lines.push(`state=${JSON.stringify(context.state)}`);
    }

    return lines.join('\n');
  }
}
