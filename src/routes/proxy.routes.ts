import { FastifyInstance } from 'fastify';
import { handleProxyRequest } from '../services/proxy.service';
import { getStrategyByKey0 } from '../services/strategy.service';

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  // Chat completions (main endpoint)
  app.post('/v1/chat/completions', async (request, reply) => {
    await handleProxyRequest(request, reply, '/chat/completions');
  });

  // Responses API (new OpenAI endpoint, used by OpenCode)
  app.post('/v1/responses', async (request, reply) => {
    await handleProxyRequest(request, reply, '/v1/responses');
  });

  // Messages API (Anthropic/Claude Code endpoint)
  app.post('/v1/messages', async (request, reply) => {
    await handleProxyRequest(request, reply, '/chat/completions');
  });

  // Nested /v1/messages under /v1/responses for Claude Code
  app.post('/v1/responses/v1/messages', async (request, reply) => {
    await handleProxyRequest(request, reply, '/chat/completions');
  });

  // Count tokens endpoint
  app.post('/v1/responses/v1/messages/count_tokens', async (request, reply) => {
    await handleProxyRequest(request, reply, '/chat/completions');
  });

  // Text completions
  app.post('/v1/completions', async (request, reply) => {
    await handleProxyRequest(request, reply, '/completions');
  });

  // Models listing
  app.get('/v1/models', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { message: 'Missing Authorization header' } });
    }

    const key0 = authHeader.substring(7);
    const strategy = getStrategyByKey0(key0);
    if (!strategy) {
      return reply.code(401).send({ error: { message: 'Invalid API key' } });
    }

    // Return standard Claude model names
    // Single model for simplicity - 590 API handles real model mapping
    const models = [
      {
        id: 'claude-sonnet-4-6',
        object: 'model',
        created: 1234567890,
        owned_by: 'anthropic',
      },
    ];

    return { object: 'list', data: models };
  });
}
