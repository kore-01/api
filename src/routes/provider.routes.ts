import { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import https from 'https';
import http from 'http';
import { authMiddleware } from '../middleware/auth';
import * as providerService from '../services/provider.service';
import { PROVIDER_PRESETS } from '../utils/constants';

interface TestStep {
  step: string;
  status: 'ok' | 'fail' | 'skip';
  detail?: string;
  lines?: Array<{ label: string; value: string }>;
  model?: string;
  responded?: boolean;
  ms?: number;
  errorRaw?: string;
}

/**
 * Run curl via spawn. If stdinData is provided, it is piped to curl's stdin (for -d @-).
 * This avoids command-line argument issues with JSON in Docker environments.
 */
function runCurl(args: string[], stdinData?: string, timeoutMs: number = 20000): Promise<{
  stdout: string; stderr: string; exitCode: number; elapsed: number;
}> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let done = false;

    const proc = spawn('curl', args, { timeout: timeoutMs });

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (done) return;
      done = true;
      resolve({ stdout, stderr, exitCode: code ?? 1, elapsed: Date.now() - start });
    });

    proc.on('error', (err) => {
      if (done) return;
      done = true;
      resolve({ stdout, stderr: err.message, exitCode: 1, elapsed: Date.now() - start });
    });

    // Pipe body to stdin if provided
    if (stdinData) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }
  });
}

/**
 * Test API using Node.js native https/http module (more reliable than curl)
 */
function testApiWithNode(provider: any, apiUrl: string, requestBody: any, proxyUrl: string, timeoutMs: number = 20000): Promise<{
  responseBody: string; httpCode: number; elapsed: number; error?: string;
}> {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = new URL(apiUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

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

    const options: any = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    };

    // Handle proxy
    if (proxyUrl) {
      const proxyParsed = new URL(proxyUrl);
      options.hostname = proxyParsed.hostname;
      options.port = proxyParsed.port || (proxyUrl.startsWith('https') ? 443 : 80);
      options.path = apiUrl;
      options.headers['Host'] = url.hostname;
    }

    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          responseBody: body,
          httpCode: res.statusCode || 0,
          elapsed: Date.now() - start,
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        responseBody: '',
        httpCode: 0,
        elapsed: Date.now() - start,
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        responseBody: '',
        httpCode: 0,
        elapsed: Date.now() - start,
        error: 'Request timeout',
      });
    });

    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/providers', async () => providerService.listProviders());
  app.get('/api/providers/presets', async () => PROVIDER_PRESETS);

  app.post('/api/providers', async (request, reply) => {
    const body = request.body as any;
    if (!body.name || !body.base_url || !body.api_key || !body.model_id)
      return reply.code(400).send({ error: 'Missing required fields' });
    const provider = providerService.createProvider(body);
    return { ...provider, api_key: '***masked***' };
  });

  app.put('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as any;
    const provider = providerService.updateProvider(id, request.body as any);
    if (!provider) return reply.code(404).send({ error: 'Provider not found' });
    return { ...provider, api_key: '***masked***' };
  });

  app.delete('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as any;
    const result = providerService.deleteProvider(id);
    if (!result.success) return reply.code(409).send({ error: result.error });
    return { success: true };
  });

  // Duplicate provider
  app.post('/api/providers/:id/duplicate', async (request, reply) => {
    const { id } = request.params as any;
    let source: providerService.Provider | null;
    try { source = providerService.getProviderById(id); }
    catch (err) { return reply.code(500).send({ error: (err as Error).message }); }
    if (!source) return reply.code(404).send({ error: 'Provider not found' });

    const copy = providerService.createProvider({
      name: `${source.name} - Copy`,
      base_url: source.base_url,
      api_key: source.api_key,
      api_type: source.api_type,
      model_id: source.model_id,
      proxy_url: source.proxy_url || '',
      custom_headers: source.custom_headers || '',
      prompt_token_limit: source.prompt_token_limit,
      completion_token_limit: source.completion_token_limit,
    });
    return { ...copy, api_key: '***masked***' };
  });

  // Test provider connectivity
  app.post('/api/providers/:id/test', async (request, reply) => {
    const { id } = request.params as any;
    let provider: providerService.Provider | null;
    try { provider = providerService.getProviderById(id); }
    catch (err) { return reply.code(500).send({ success: false, steps: [{ step: 'error', status: 'fail', errorRaw: (err as Error).message }] }); }
    if (!provider) return reply.code(404).send({ success: false, steps: [{ step: 'error', status: 'fail', errorRaw: 'Not found' }] });

    const steps: TestStep[] = [];
    const proxyUrl = provider.proxy_url || '';

    try {
      // Step 1: Proxy test
      if (proxyUrl) {
        const proxyResult = await runCurl([
          '--proxy', proxyUrl, '--max-time', '10', '-s',
          'http://ip-api.com/json/?fields=query,isp,org,status',
        ]);

        if (proxyResult.exitCode === 0 && proxyResult.stdout.trim()) {
          try {
            const data = JSON.parse(proxyResult.stdout.trim());
            if (data.status === 'success') {
              steps.push({
                step: 'proxy_test', status: 'ok',
                lines: [
                  { label: 'ip', value: data.query || 'unknown' },
                  { label: 'isp', value: data.isp || data.org || 'unknown' },
                ],
                ms: proxyResult.elapsed,
              });
            } else {
              steps.push({ step: 'proxy_test', status: 'fail', errorRaw: proxyResult.stdout.substring(0, 200), ms: proxyResult.elapsed });
              return { success: false, steps };
            }
          } catch {
            const exitIp = proxyResult.stdout.trim().split('\n')[0].trim();
            steps.push({ step: 'proxy_test', status: 'ok', lines: [{ label: 'ip', value: exitIp }], ms: proxyResult.elapsed });
          }
        } else {
          steps.push({ step: 'proxy_test', status: 'fail', errorRaw: proxyResult.stderr.substring(0, 300) || 'curl exit ' + proxyResult.exitCode, ms: proxyResult.elapsed });
          return { success: false, steps };
        }
      } else {
        steps.push({ step: 'proxy_test', status: 'skip' });
      }

      // Step 2: API test — use Node.js native http/https module for better DNS handling
      // Use different endpoint based on api_type
      let apiPath = '/chat/completions';
      let requestBody: any;

      if (provider.api_type === 'anthropic-messages') {
        // Anthropic兼容端点: /anthropic/v1/messages
        apiPath = '/v1/messages';
        // Anthropic需要数组格式的content和max_completion_tokens
        requestBody = {
          model: provider.model_id,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Say 1' }] }],
          max_completion_tokens: 10
        };
      } else {
        requestBody = { model: provider.model_id, messages: [{ role: 'user', content: 'Say 1' }], max_tokens: 10, stream: false };
      }
      const apiUrl = `${provider.base_url}${apiPath}`;

      // Try Node.js native method first (better DNS handling)
      let apiResult: any;
      try {
        apiResult = await testApiWithNode(provider, apiUrl, requestBody, proxyUrl);
      } catch (err) {
        // Fallback to curl if Node.js method fails
        const curlArgs: string[] = [];
        if (proxyUrl) curlArgs.push('--proxy', proxyUrl);
        curlArgs.push(
          '--max-time', '20',
          '-s',
          '-w', '\n__HTTP_CODE__%{http_code}',
          '-X', 'POST',
          '-H', `Authorization: Bearer ${provider.api_key}`,
          '-H', 'Content-Type: application/json',
          '-d', '@-',
          apiUrl,
        );
        apiResult = await runCurl(curlArgs, JSON.stringify(requestBody));
        const outputLines = apiResult.stdout.split('__HTTP_CODE__');
        apiResult = {
          responseBody: outputLines[0].trim(),
          httpCode: parseInt(outputLines[1]?.trim() || '0', 10),
          elapsed: apiResult.elapsed,
          error: apiResult.exitCode !== 0 ? (apiResult.stderr || 'curl error') : undefined,
        };
      }

      const responseBody = apiResult.responseBody || '';
      const httpCode = apiResult.httpCode || 0;

      if ((httpCode === 0 || !httpCode) && apiResult.error) {
        let errorDetail = apiResult.error;
        if (errorDetail.includes('ENOTFOUND') || errorDetail.includes('getaddrinfo')) {
          errorDetail = `DNS resolve failed for ${provider.base_url}. Check network/proxy settings.`;
        } else if (errorDetail.includes('ECONNREFUSED')) {
          errorDetail = `Connection refused to ${provider.base_url}. Check firewall/proxy.`;
        }
        steps.push({ step: 'api_test', status: 'fail', errorRaw: errorDetail.substring(0, 300), ms: apiResult.elapsed });
        return { success: false, steps };
      }

      if (httpCode >= 200 && httpCode < 300) {
        let model = provider.model_id;
        let responded = false;
        try {
          const data = JSON.parse(responseBody);
          model = data.model || provider.model_id;
          responded = !!(data.choices?.[0]?.message?.content);
        } catch {}
        steps.push({ step: 'api_test', status: 'ok', model, responded, ms: apiResult.elapsed });
        return { success: true, steps };
      } else {
        steps.push({ step: 'api_test', status: 'fail', errorRaw: `HTTP ${httpCode}: ${responseBody.substring(0, 300)}`, ms: apiResult.elapsed });
        return { success: false, steps };
      }
    } catch (err) {
      steps.push({ step: 'error', status: 'fail', errorRaw: (err as Error).message });
      return { success: false, steps };
    }
  });

  app.post('/api/providers/:id/reset-usage', async (request, reply) => {
    const { id } = request.params as any;
    providerService.resetProviderUsage(id);
    return { success: true };
  });

  // Reset provider status (recover from fault/throttled)
  app.post('/api/providers/:id/reset-status', async (request, reply) => {
    const { id } = request.params as any;
    providerService.updateProviderStatus(id, 'normal');
    return { success: true };
  });
}
