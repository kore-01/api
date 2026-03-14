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

    // Return models that OpenCode/Claude Code expects
    // The actual model will be overridden by the provider's model_id anyway
    const models = [
      {
        id: 'claude-sonnet-4-6[1m]',
        object: 'model',
        owned_by: 'anthropic',
        created: 1234567890,
      },
      {
        id: 'claude-sonnet-4-6',
        object: 'model',
        owned_by: 'anthropic',
        created: 1234567890,
      },
      {
        id: 'claude-opus-4-6[1m]',
        object: 'model',
        owned_by: 'anthropic',
        created: 1234567890,
      },
      {
        id: 'claude-opus-4-6',
        object: 'model',
        owned_by: 'anthropic',
        created: 1234567890,
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        owned_by: 'anthropic',
        created: 1234567890,
      },
      {
        id: 'claude-3-5-haiku-20241022',
        object: 'model',
        owned_by: 'anthropic',
        created: 1234567890,
      },
    ];

    return { object: 'list', data: models };
  });
}
