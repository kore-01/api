import { FastifyRequest, FastifyReply } from 'fastify';
import { Strategy, getStrategyByKey0, isStrategyExceeded, accumulateStrategyUsage } from './strategy.service';
import { Provider, isProviderExceeded, accumulateProviderUsage, updateProviderStatus } from './provider.service';
import { selectProvider, selectNextProvider } from './scheduler.service';
import { addToFaultPool } from './fault-pool.service';
import { insertLog, updateLogCountry } from './log.service';
import { getCountryForIP } from './geo.service';
import { extractClientIP } from '../utils/ip-utils';
import { extractSSELines, parseSSEData } from '../utils/stream-handler';
import { proxyFetch } from '../utils/proxy-fetch';
import { config } from '../config';

/**
 * Transform streaming chunk from chat.completion to responses delta format
 * Chat: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"..."}}]}
 * Responses: {"type":"response.output_text.delta","delta":"...","item_id":"...","output_index":...}
 */
function transformToResponsesDelta(data: any, itemId: string = 'msg_1'): any {
  console.log('[DEBUG] transformToResponsesDelta input:', JSON.stringify(data).substring(0, 300));
  const delta = data.choices?.[0]?.delta;
  console.log('[DEBUG] delta found:', !!delta, 'delta:', JSON.stringify(delta || {}).substring(0, 100));

  // If no delta or delta has no content and no tool_calls, skip this chunk
  if (!delta) return null;
  if (!delta.content && !delta.role && (!delta.tool_calls || delta.tool_calls.length === 0)) {
    return null;
  }

  const result: any = {
    type: 'response.output_text.delta',
    delta: delta.content || '',
    item_id: itemId,
    output_index: 0
  };

  // Handle tool calls in streaming
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    return {
      type: 'response.tool_call.delta',
      delta: {
        tool_calls: delta.tool_calls.map((tc: any) => ({
          id: tc.id || `toolu_${Date.now()}`,
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || ''
        }))
      },
      item_id: itemId,
      output_index: 0
    };
  }

  return result;
}

/**
 * Transform chat.completion response to responses API format
 * Chat: {"choices":[{"message":{"content":"..."}}]}
 * Responses: {"output":[{"type":"output_text","content":[{"type":"output_text","text":"..."}]}]}
 */
function transformToResponsesFormat(data: any): any {
  const message = data.choices?.[0]?.message;
  const content = message?.content || '';
  const toolCalls = message?.tool_calls || [];

  // Generate a unique item_id
  const itemId = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const output: any[] = [];

  // Add text content if present
  if (content) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: content
        }
      ]
    });
  }

  // Add tool calls if present
  if (toolCalls && toolCalls.length > 0) {
    const toolCallsOutput = toolCalls.map((tc: any, index: number) => ({
      type: 'tool_use',
      id: tc.id || `toolu_${Date.now()}_${index}`,
      name: tc.function?.name || '',
      input: typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function?.arguments || {}
    }));

    output.push({
      type: 'message',
      role: 'assistant',
      content: toolCallsOutput
    });
  }

  return {
    id: data.id || `resp_${Date.now()}`,
    object: 'response',
    created: data.created || Math.floor(Date.now() / 1000),
    model: data.model || 'unknown',
    output: output,
    usage: data.usage ? {
      input_tokens: data.usage.prompt_tokens || 0,
      output_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0
    } : undefined
  };
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function estimatePromptTokens(messages: any[]): number {
  if (!messages || !Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    total += 4;
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') total += estimateTokens(part.text);
      }
    }
    total += estimateTokens(msg.role || '');
  }
  total += 2;
  return total;
}

interface ProxyResult {
  success: boolean;
  statusCode?: number;
  providerPromptTokens: number;
  providerCompletionTokens: number;
  providerTotalTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
  latencyMs: number;
  error?: string;
}

/**
 * Convert OpenAI message format to Anthropic format
 * OpenAI: {"role": "user", "content": "text"}
 * Anthropic: {"role": "user", "content": [{"type": "text", "text": "text"}]}
 */
function convertToAnthropicFormat(body: any): any {
  if (!body.messages || !Array.isArray(body.messages)) {
    return body;
  }

  const convertedMessages = body.messages.map((msg: any) => {
    if (typeof msg.content === 'string') {
      // Convert simple string content to Anthropic array format
      return {
        role: msg.role,
        content: [{ type: 'text', text: msg.content }],
      };
    } else if (Array.isArray(msg.content)) {
      // Already array format - check if it needs conversion
      const convertedContent = msg.content.map((part: any) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          return part; // Already in correct format
        } else if (typeof part === 'string') {
          return { type: 'text', text: part };
        }
        return part;
      });
      return { role: msg.role, content: convertedContent };
    }
    return msg;
  });

  // Convert OpenAI parameters to Anthropic format
  let converted = { ...body, messages: convertedMessages };

  // Remove all OpenAI-specific parameters that Anthropic doesn't support
  delete converted.tools;
  delete converted.tool_choice;
  delete converted.function_call;
  delete converted.functions;

  // Also filter out tool-related fields from messages
  convertedMessages.forEach((msg: any) => {
    if (msg.content && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((part: any) => {
        // Remove tool role messages and tool_call related content
        if (msg.role === 'tool' || part.type === 'tool_use' || part.type === 'tool_result' || part.tool_call_id) {
          return false;
        }
        return true;
      });
    }
  });

  // max_tokens -> max_completion_tokens
  if (converted.max_tokens !== undefined) {
    converted.max_completion_tokens = converted.max_tokens;
    delete converted.max_tokens;
  }

  // temperature -> temperature (same)
  // top_p -> top_p (same)
  // stream -> stream (same)

  return converted;
}

async function proxyToProvider(
  provider: Provider,
  body: any,
  requestPath: string,
  reply: FastifyReply,
  isStream: boolean,
): Promise<ProxyResult> {
  const startTime = Date.now();
  console.log('[DEBUG] proxyToProvider called, requestPath:', requestPath);

  // Determine the correct API path based on api_type
  // Anthropic-compatible API uses /v1/messages instead of /chat/completions
  // Responses API needs to be converted to /chat/completions for provider compatibility
  let apiPath = requestPath;
  let useAnthropicFormat = false;
  if (provider.api_type === 'anthropic-messages') {
    // Transform /chat/completions to /v1/messages for Anthropic compatibility
    apiPath = '/v1/messages';
    useAnthropicFormat = true;
  }
  // Convert /v1/responses to /chat/completions for OpenAI-compatible providers
  if (requestPath === '/v1/responses') {
    apiPath = '/chat/completions';
  }

  // ** CRITICAL: Override user's model with provider's model_id **
  let forwardBody = { ...body, model: provider.model_id };

  // Convert /v1/responses format to /chat/completions format
  // OpenCode sends "input" but providers need "messages"
  if (requestPath === '/v1/responses' && forwardBody.input && !forwardBody.messages) {
    forwardBody.messages = forwardBody.input;
    delete forwardBody.input;
    console.log('[DEBUG] Converted responses input to messages:', JSON.stringify(forwardBody.messages));
  }

  // Convert "developer" role to "system" for provider compatibility
  // OpenCode sends "developer" role but many providers don't support it
  if (forwardBody.messages && Array.isArray(forwardBody.messages)) {
    for (const msg of forwardBody.messages) {
      if (msg.role === 'developer') {
        msg.role = 'system';
        console.log('[DEBUG] Converted developer role to system');
      }
    }
  }

  // Debug: Log tools and tool_calls if present
  if (forwardBody.tools) {
    console.log('[DEBUG] Tools present:', JSON.stringify(forwardBody.tools).substring(0, 500));

    // Convert tools format from flat to nested function object
    // OpenCode: {"type":"function","name":"...","description":"...","parameters":{...}}
    // Required: {"type":"function","function":{"name":"...","description":"...","parameters":{...}}}
    for (const tool of forwardBody.tools) {
      if (tool.type === 'function' && !tool.function && tool.name) {
        console.log('[DEBUG] Converting flat tools format to nested function');
        tool.function = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        };
        delete tool.name;
        delete tool.description;
        delete tool.parameters;
      }
    }
  }
  if (forwardBody.tool_calls) {
    console.log('[DEBUG] Tool_calls present:', JSON.stringify(forwardBody.tool_calls).substring(0, 500));

    // Fix: Ensure tool_calls have valid function.name and function.arguments
    for (const tc of forwardBody.tool_calls) {
      if (tc.function) {
        // Ensure function.name is a string
        if (typeof tc.function.name !== 'string' || !tc.function.name) {
          console.log('[DEBUG] Fixing empty function name');
          tc.function.name = tc.function.name || 'unknown_function';
        }
        // Ensure function.arguments is a string
        if (typeof tc.function.arguments === 'object' && tc.function.arguments !== null) {
          console.log('[DEBUG] Converting function.arguments object to string');
          tc.function.arguments = JSON.stringify(tc.function.arguments);
        }
        if (!tc.function.arguments || tc.function.arguments === '{}') {
          console.log('[DEBUG] Fixing empty function.arguments');
          tc.function.arguments = '{}';
        }
      }
    }
  }

  // Convert message format for Anthropic API
  if (useAnthropicFormat) {
    forwardBody = convertToAnthropicFormat(forwardBody);
    console.log('[DEBUG] Anthropic request:', JSON.stringify(forwardBody));
  }

  const estimatedPrompt = estimatePromptTokens(forwardBody.messages);
  const targetUrl = `${provider.base_url}${apiPath}`;
  const controller = new AbortController();
  const timeoutMs = isStream ? config.firstTokenTimeout : config.nonStreamTimeout;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${provider.api_key}`,
      'Content-Type': 'application/json',
    };

    // Add anthropic-version header for Anthropic-compatible API
    if (provider.api_type === 'anthropic-messages') {
      headers['anthropic-version'] = '2023-06-01';
    }

    // Add custom headers for providers like Kimi-for-coding
    if (provider.custom_headers) {
      try {
        const customHeaders = JSON.parse(provider.custom_headers);
        Object.assign(headers, customHeaders);
      } catch (e) {
        console.warn('[WARN] Invalid custom_headers JSON:', provider.custom_headers);
      }
    }

    const res = await proxyFetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(forwardBody),
      signal: controller.signal,
    }, provider.proxy_url || undefined);

    clearTimeout(timeout);

    if (!res.ok && res.status >= 500) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Provider returned ${res.status}: ${errText.substring(0, 200)}`);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // For responses API, still need to transform error response
      if (requestPath === '/v1/responses') {
        // Return error in responses format
        const errorResponse = {
          type: 'error',
          error: {
            type: 'provider_error',
            message: errBody
          }
        };
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(res.status, { 'Content-Type': 'application/json' });
          reply.raw.end(JSON.stringify(errorResponse));
        }
      } else {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(res.status, { 'Content-Type': 'application/json' });
          reply.raw.end(errBody);
        }
      }
      return {
        success: true,
        statusCode: res.status,
        providerPromptTokens: 0, providerCompletionTokens: 0, providerTotalTokens: 0,
        estimatedPromptTokens: estimatedPrompt, estimatedCompletionTokens: 0, estimatedTotalTokens: estimatedPrompt,
        latencyMs: Date.now() - startTime,
        error: `HTTP ${res.status}`,
      };
    }

    // For /v1/responses, always convert to streaming delta format
    // 590 API may return non-streaming even when streaming is requested
    const isResponsesFormat = requestPath === '/v1/responses';

    if (isResponsesFormat) {
      // Always use streaming format for responses API
      console.log('[DEBUG] Entering responses format branch, isStream:', isStream, 'res.body:', !!res.body);
      const itemId = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let completionText = '';
      let providerUsage: any = null;

      if (isStream && res.body) {
        // Provider returned streaming response
        const reader = (res.body as any).getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });

            // Transform chunk to responses format
            console.log('[DEBUG] Processing streaming chunk, raw data:', chunk.substring(0, 200));
            const lines = extractSSELines(chunk);
            console.log('[DEBUG] SSE lines extracted:', lines.length);
            const transformedLines: string[] = [];

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));
                  const transformed = transformToResponsesDelta(data, itemId);
                  console.log('[DEBUG] Transformed delta, result:', transformed ? 'success' : 'null');
                  if (transformed) {
                    transformedLines.push(`data: ${JSON.stringify(transformed)}`);
                  }
                } catch (e) {
                  transformedLines.push(line);
                }
              } else {
                transformedLines.push(line);
              }
            }

            reply.raw.write(transformedLines.join('\n') + '\n');

            // Parse for tracking
            const parsedLines = extractSSELines(chunk);
            for (const line of parsedLines) {
              const parsed = parseSSEData(line);
              if (parsed.delta?.content) completionText += parsed.delta.content;
              if (parsed.usage) providerUsage = parsed.usage;
            }
          }
        } catch (streamErr) {
          console.error('Stream interrupted:', (streamErr as Error).message);
        }
      } else {
        // Provider returned non-streaming response - convert to streaming
        const data = await res.json() as any;
        console.log('[DEBUG] Converting non-streaming to streaming, data:', JSON.stringify(data).substring(200));

        const transformed = transformToResponsesDelta(data, itemId);
        if (transformed) {
          reply.raw.write(`data: ${JSON.stringify(transformed)}\n`);
          completionText = transformed.delta || '';
        }

        providerUsage = data.usage;
      }

      reply.raw.write('data: [DONE]\n');
      reply.raw.end();

      const estimatedCompletion = estimateTokens(completionText);
      return {
        success: true, statusCode: 200,
        providerPromptTokens: providerUsage?.prompt_tokens || 0,
        providerCompletionTokens: providerUsage?.completion_tokens || 0,
        providerTotalTokens: providerUsage?.total_tokens || 0,
        estimatedPromptTokens: estimatedPrompt,
        estimatedCompletionTokens: estimatedCompletion,
        estimatedTotalTokens: estimatedPrompt + estimatedCompletion,
        latencyMs: Date.now() - startTime,
      };
    } else if (isStream && res.body) {
      // Non-responses streaming
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let completionText = '';
      let providerUsage: any = null;
      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          reply.raw.write(chunk);

          const lines = extractSSELines(chunk);
          for (const line of lines) {
            const parsed = parseSSEData(line);
            if (parsed.delta?.content) completionText += parsed.delta.content;
            if (parsed.usage) providerUsage = parsed.usage;
          }
        }
      } catch (streamErr) {
        console.error('Stream interrupted:', (streamErr as Error).message);
      }

      reply.raw.end();
      const estimatedCompletion = estimateTokens(completionText);
      return {
        success: true, statusCode: 200,
        providerPromptTokens: providerUsage?.prompt_tokens || 0,
        providerCompletionTokens: providerUsage?.completion_tokens || 0,
        providerTotalTokens: providerUsage?.total_tokens || 0,
        estimatedPromptTokens: estimatedPrompt,
        estimatedCompletionTokens: estimatedCompletion,
        estimatedTotalTokens: estimatedPrompt + estimatedCompletion,
        latencyMs: Date.now() - startTime,
      };
    } else {
      const data = await res.json() as any;

      // Transform response from chat.completion to responses format for OpenCode
      let resBody: string;
      if (requestPath === '/v1/responses') {
        const transformed = transformToResponsesFormat(data);
        resBody = JSON.stringify(transformed);
        console.log('[DEBUG] Transformed response to responses format');
      } else {
        resBody = JSON.stringify(data);
      }

      if (!reply.raw.headersSent) {
        reply.raw.writeHead(200, { 'Content-Type': 'application/json' });
        reply.raw.end(resBody);
      }
      const usage = data.usage;
      const completionText = data.choices?.[0]?.message?.content || '';
      const estimatedCompletion = estimateTokens(completionText);
      return {
        success: true, statusCode: 200,
        providerPromptTokens: usage?.prompt_tokens || 0,
        providerCompletionTokens: usage?.completion_tokens || 0,
        providerTotalTokens: usage?.total_tokens || 0,
        estimatedPromptTokens: estimatedPrompt,
        estimatedCompletionTokens: estimatedCompletion,
        estimatedTotalTokens: estimatedPrompt + estimatedCompletion,
        latencyMs: Date.now() - startTime,
      };
    }
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export async function handleProxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  requestPath: string,
): Promise<void> {
  const clientIP = extractClientIP(request);
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: { message: 'Missing or invalid Authorization header', type: 'auth_error' } });
    return;
  }

  const key0 = authHeader.substring(7);
  const strategy = getStrategyByKey0(key0);
  if (!strategy) {
    reply.code(401).send({ error: { message: 'Invalid API key', type: 'auth_error' } });
    return;
  }

  if (isStrategyExceeded(strategy)) {
    reply.code(429).send({
      error: {
        message: 'Strategy quota exceeded', type: 'quota_exceeded',
        detail: { prompt: `${strategy.prompt_tokens_used}/${strategy.prompt_token_limit}`, completion: `${strategy.completion_tokens_used}/${strategy.completion_token_limit}` },
      },
    });
    return;
  }

  const body = request.body as any || {};
  const isStream = body.stream === true;
  console.log('[DEBUG] Request info - requestPath:', requestPath, 'isStream:', isStream, 'body.stream:', body.stream);
  const apiKeyId = (strategy as any).api_key_id || '';

  const triedProviderIds: string[] = [];

  while (true) {
    const scheduleResult = triedProviderIds.length === 0
      ? selectProvider(strategy)
      : selectNextProvider(strategy, triedProviderIds);

    if (!scheduleResult) {
      if (!reply.raw.headersSent) {
        const faultCount = (strategy.providers || []).filter(p => p.status === 'fault').length;
        const throttledCount = (strategy.providers || []).filter(p => p.status === 'throttled').length;
        reply.code(503).send({
          error: { message: 'All providers unavailable', type: 'service_unavailable', detail: `${faultCount} fault, ${throttledCount} throttled` },
        });
      }
      return;
    }

    const { provider, isFallback } = scheduleResult;
    triedProviderIds.push(provider.id);

    if (isProviderExceeded(provider)) {
      updateProviderStatus(provider.id, 'throttled');
      continue;
    }

    try {
      const result = await proxyToProvider(provider, body, requestPath, reply, isStream);

      // Log with PROVIDER's model_id (not user's model param)
      const logId = insertLog({
        strategy_id: strategy.id,
        provider_id: provider.id,
        api_key_id: apiKeyId,
        model: provider.model_id,
        request_path: requestPath,
        status_code: result.statusCode,
        provider_prompt_tokens: result.providerPromptTokens,
        provider_completion_tokens: result.providerCompletionTokens,
        provider_total_tokens: result.providerTotalTokens,
        estimated_prompt_tokens: result.estimatedPromptTokens,
        estimated_completion_tokens: result.estimatedCompletionTokens,
        estimated_total_tokens: result.estimatedTotalTokens,
        client_ip: clientIP,
        latency_ms: result.latencyMs,
        is_fallback: isFallback ? 1 : 0,
        error_message: result.error,
      });

      const promptTokens = result.providerPromptTokens > 0 ? result.providerPromptTokens : result.estimatedPromptTokens;
      const completionTokens = result.providerCompletionTokens > 0 ? result.providerCompletionTokens : result.estimatedCompletionTokens;
      accumulateProviderUsage(provider.id, promptTokens, completionTokens);
      accumulateStrategyUsage(strategy.id, promptTokens, completionTokens);

      getCountryForIP(clientIP).then(geo => {
        if (geo) updateLogCountry(logId, geo.country);
      }).catch(() => {});

      return;
    } catch (err) {
      const lastError = (err as Error).message;
      console.error(`Provider ${provider.name} failed:`, lastError);

      if (!reply.raw.headersSent) {
        addToFaultPool(provider.id);
        insertLog({
          strategy_id: strategy.id, provider_id: provider.id, api_key_id: apiKeyId,
          model: provider.model_id, request_path: requestPath, status_code: 0,
          client_ip: clientIP, latency_ms: Date.now(), is_fallback: isFallback ? 1 : 0, error_message: lastError,
        });
        continue;
      } else {
        addToFaultPool(provider.id);
        return;
      }
    }
  }
}
