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
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(res.status, { 'Content-Type': 'application/json' });
        reply.raw.end(errBody);
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

    if (isStream && res.body) {
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
      const resBody = JSON.stringify(data);
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
