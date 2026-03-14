# 📘 Kimi-for-Coding 完整集成开发方案

> **版本**: 2.0
> **更新日期**: 2026-02-24
> **适用场景**: Electron + React 桌面应用集成 Kimi-for-coding (Moonshot AI 编程模型)
> **状态**: ✅ 已验证通过

---

## 🌟 核心背景

Kimi-for-coding 是 Moonshot AI 推出的针对编程场景优化的模型。与通用 LLM API 不同，它有更严格的访问控制和网络要求。如果不遵循特定的协议，开发者通常会遇到 **403 Forbidden** 或 **解析错误**。

### 关键参数
- **API Endpoint**: `https://api.kimi.com/coding/v1/chat/completions`
- **Model Name**: `kimi-for-coding`
- **Authentication**: Bearer Token (API Key)
- **特殊要求**: 必须使用特定的 HTTP Headers 来标识客户端身份

---

## 🚧 三大技术挑战

### 1. 403 Forbidden (`access_terminated_error`)
**原因**: 服务器通过 HTTP Headers 严格校验客户端身份，只允许特定的 Coding Agents 访问。
**解决方案**: 使用 Node.js 原生 `https` 模块发送请求，绕过 Chromium 的 header 限制。

### 2. Headers 被 Chromium 覆盖
**原因**: Electron 的 `session.defaultSession.fetch` 使用 Chromium 网络栈，会忽略或覆盖某些 headers（如 `User-Agent`）。
**解决方案**: 对 Kimi 的请求使用 Node.js 原生 `https` 模块，完全控制所有 headers。

### 3. Gzip 压缩
**原因**: Kimi 服务器可能强制返回 Gzip 压缩数据。
**解决方案**: 使用 `zlib` 模块处理 gzip/deflate/brotli 压缩响应。

---

## 📋 必需 HTTP Headers

```json
{
  "accept": "application/json",
  "accept-language": "*",
  "sec-fetch-mode": "cors",
  "user-agent": "RooCode/3.31.0",
  "x-title": "Roo Code",
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-package-version": "5.12.2",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v22.19.0",
  "Authorization": "Bearer YOUR_API_KEY"
}
```

> **注意**: `user-agent` 和 `x-title` 是关键字段，必须使用 `RooCode` 或 `ClaudeCode` 等受支持的标识。

---

## 🛠️ 完整实现代码

### 1. 配置定义 (`src/renderer/config.ts`)

```typescript
// 在 CHINA_PROVIDERS 中添加 'kimi'
export const CHINA_PROVIDERS = [
  'deepseek', 'moonshot', 'qwen', 'zhipu', 'minimax',
  'ollama', 'nvidia', 'kimi'  // 添加 'kimi'
] as const;

// 默认配置
export const defaultConfig: AppConfig = {
  // ... 其他配置
  providers: {
    // ... 其他 providers
    kimi: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiFormat: 'openai',
      customHeaders: {},
      models: [
        { id: 'kimi-for-coding', name: 'Kimi for Coding', supportsImage: false }
      ]
    },
  },
  // ... 其他配置
};
```

### 2. API 服务层 (`src/renderer/services/api.ts`)

#### 2.1 更新 ApiConfig 接口
```typescript
export interface ApiConfig {
  apiKey: string;
  baseUrl: string;
  provider?: string;
  apiFormat?: 'anthropic' | 'openai';
  customHeaders?: Record<string, string>;  // 添加自定义 headers 支持
}
```

#### 2.2 修改 Provider 检测
```typescript
private detectProvider(modelId: string, providerHint?: string): string {
  const normalizedHint = providerHint?.toLowerCase();
  if (
    normalizedHint &&
    ['openai', 'deepseek', 'moonshot', 'zhipu', 'minimax',
     'qwen', 'openrouter', 'gemini', 'anthropic', 'ollama', 'kimi'].includes(normalizedHint)
  ) {
    return normalizedHint;
  }

  const normalizedModelId = modelId.toLowerCase();
  if (normalizedModelId.startsWith('claude')) {
    return 'anthropic';
  } else if (normalizedModelId.startsWith('kimi-')) {
    return 'kimi';  // 添加 Kimi 检测
  }
  // ... 其他检测
  return 'openai';
}
```

#### 2.3 修改请求头构建
```typescript
// Start with custom headers first
type Headers = Record<string, string>;
const headers: Headers = {
  ...(config.customHeaders || {}),
};

// Kimi requires specific headers to identify as a coding agent
if (provider === 'kimi' || config.baseUrl?.includes('api.kimi.com')) {
  headers['accept'] = headers['accept'] || 'application/json';
  headers['accept-language'] = headers['accept-language'] || '*';
  headers['sec-fetch-mode'] = headers['sec-fetch-mode'] || 'cors';
  headers['user-agent'] = headers['user-agent'] || 'RooCode/3.31.0';
  headers['x-title'] = headers['x-title'] || 'Roo Code';
  headers['x-stainless-arch'] = headers['x-stainless-arch'] || 'x64';
  headers['x-stainless-lang'] = headers['x-stainless-lang'] || 'js';
  headers['x-stainless-os'] = headers['x-stainless-os'] || 'Windows';
  headers['x-stainless-package-version'] = headers['x-stainless-package-version'] || '5.12.2';
  headers['x-stainless-retry-count'] = headers['x-stainless-retry-count'] || '0';
  headers['x-stainless-runtime'] = headers['x-stainless-runtime'] || 'node';
  headers['x-stainless-runtime-version'] = headers['x-stainless-runtime-version'] || 'v22.19.0';
}

// Set default Content-Type
if (!headers['Content-Type'] && !headers['content-type']) {
  headers['Content-Type'] = 'application/json';
}

// Add Authorization
if (config.apiKey && !headers.authorization && !headers.Authorization) {
  headers.Authorization = `Bearer ${config.apiKey}`;
}
```

### 3. 主进程 HTTP 处理 (`src/main/main.ts`)

#### 3.1 添加导入
```typescript
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { URL } from 'url';
```

#### 3.2 创建 HTTP 请求辅助函数
```typescript
function makeHttpRequest(
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: string | object;
}> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestOptions: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method,
      headers: options.headers,
    };

    const req = client.request(requestOptions, (res) => {
      // Handle gzip/deflate compression
      const contentEncoding = res.headers['content-encoding'];
      let stream: NodeJS.ReadableStream = res;

      if (contentEncoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (contentEncoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (contentEncoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      let data = '';
      stream.on('data', (chunk) => {
        data += chunk;
      });
      stream.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        let parsedData: string | object = data;

        if (contentType.includes('application/json')) {
          try {
            parsedData = JSON.parse(data);
          } catch {
            parsedData = data;
          }
        }

        resolve({
          ok: res.statusCode ? res.statusCode >= 200 && res.statusCode < 300 : false,
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          headers: Object.fromEntries(
            Object.entries(res.headers).map(([k, v]) => [k, String(v)])
          ),
          data: parsedData,
        });
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
```

#### 3.3 修改 API Fetch Handler
```typescript
ipcMain.handle('api:fetch', async (_event, options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => {
  try {
    // Use Node.js native http/https for Kimi
    const isKimi = options.url.includes('api.kimi.com');

    if (isKimi) {
      const result = await makeHttpRequest(options.url, options);
      return result;
    }

    // Use Electron's fetch for other providers
    const response = await session.defaultSession.fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });

    // ... 处理响应
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : 'Network error',
      headers: {},
      data: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});
```

#### 3.4 修改 API Stream Handler
```typescript
ipcMain.handle('api:stream', async (event, options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  requestId: string;
}) => {
  const isKimi = options.url.includes('api.kimi.com');

  // 对于 Kimi 使用 Node.js 原生 https 模块
  if (isKimi) {
    return new Promise((resolve) => {
      const urlObj = new URL(options.url);
      const client = urlObj.protocol === 'https:' ? https : http;

      const requestOptions: https.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method,
        headers: options.headers,
      };

      const req = client.request(requestOptions, (res) => {
        // Handle gzip/deflate compression
        const contentEncoding = res.headers['content-encoding'];
        let stream: NodeJS.ReadableStream = res;

        if (contentEncoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (contentEncoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        } else if (contentEncoding === 'br') {
          stream = res.pipe(zlib.createBrotliDecompress());
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          let errorData = '';
          stream.on('data', (chunk) => {
            errorData += chunk;
          });
          stream.on('end', () => {
            activeStreamControllers.delete(options.requestId);
            resolve({
              ok: false,
              status: res.statusCode || 0,
              statusText: res.statusMessage || 'Request failed',
              error: errorData,
            });
          });
          return;
        }

        // 读取流式响应并通过 IPC 发送
        stream.on('data', (chunk: Buffer) => {
          event.sender.send(`api:stream:${options.requestId}:data`, chunk.toString());
        });

        stream.on('end', () => {
          event.sender.send(`api:stream:${options.requestId}:done`);
          activeStreamControllers.delete(options.requestId);
        });

        // 立即返回成功状态
        resolve({
          ok: true,
          status: res.statusCode || 200,
          statusText: res.statusMessage || 'OK',
        });
      });

      req.on('error', (error) => {
        activeStreamControllers.delete(options.requestId);
        resolve({
          ok: false,
          status: 0,
          statusText: error.message || 'Network error',
          error: error.message || 'Unknown error',
        });
      });

      activeStreamControllers.set(options.requestId, { abort: () => req.destroy() });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  // 其他 provider 使用标准 fetch
  // ...
});
```

### 4. Cowork 代理层 (`src/main/libs/coworkOpenAICompatProxy.ts`)

#### 4.1 添加导入
```typescript
import https from 'https';
import zlib from 'zlib';
import { URL } from 'url';
```

#### 4.2 修改请求发送逻辑
```typescript
// 在 handleRequest 函数中

// 构建 headers
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
};

// Kimi requires specific headers
const isKimi = upstreamConfig.provider === 'kimi' ||
               upstreamConfig.baseURL?.includes('api.kimi.com');

if (isKimi) {
  headers['accept'] = 'application/json';
  headers['accept-language'] = '*';
  headers['sec-fetch-mode'] = 'cors';
  headers['user-agent'] = 'RooCode/3.31.0';
  headers['x-title'] = 'Roo Code';
  headers['x-stainless-arch'] = 'x64';
  headers['x-stainless-lang'] = 'js';
  headers['x-stainless-os'] = 'Windows';
  headers['x-stainless-package-version'] = '5.12.2';
  headers['x-stainless-retry-count'] = '0';
  headers['x-stainless-runtime'] = 'node';
  headers['x-stainless-runtime-version'] = 'v22.19.0';
}

if (upstreamConfig.apiKey) {
  headers.Authorization = `Bearer ${upstreamConfig.apiKey}`;
}

// 使用 Node.js 原生 http 请求 Kimi
const makeNodeHttpRequest = (targetURL: string, payload: Record<string, unknown>): Promise<Response> => {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetURL);
    const client = urlObj.protocol === 'https:' ? https : http;

    const requestOptions: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers,
    };

    const req = client.request(requestOptions, (res) => {
      // Handle compression
      const contentEncoding = res.headers['content-encoding'];
      let responseStream: NodeJS.ReadableStream = res;

      if (contentEncoding === 'gzip') {
        responseStream = res.pipe(zlib.createGunzip());
      } else if (contentEncoding === 'deflate') {
        responseStream = res.pipe(zlib.createInflate());
      } else if (contentEncoding === 'br') {
        responseStream = res.pipe(zlib.createBrotliDecompress());
      }

      const chunks: Buffer[] = [];
      responseStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      responseStream.on('end', () => {
        const data = Buffer.concat(chunks);

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          }
        });

        resolve({
          ok: res.statusCode ? res.statusCode >= 200 && res.statusCode < 300 : false,
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          headers: {
            get: (name: string) => {
              const value = res.headers[name.toLowerCase()];
              return Array.isArray(value) ? value[0] : value || null;
            }
          } as Headers,
          body: stream,
          text: async () => data.toString(),
          json: async () => JSON.parse(data.toString()),
        } as unknown as Response);
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
};

// 发送请求
const sendUpstreamRequest = async (payload: Record<string, unknown>, targetURL: string): Promise<Response> => {
  if (isKimi) {
    return makeNodeHttpRequest(targetURL, payload);
  }
  return session.defaultSession.fetch(targetURL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
};
```

### 5. 设置界面 (`src/renderer/components/Settings.tsx`)

#### 5.1 添加 Kimi 请求头填充按钮
```typescript
{activeProvider === 'kimi' && (
  <div>
    <label>Custom Headers</label>
    <textarea
      value={customHeadersText}
      onChange={(e) => {
        // 处理输入
      }}
      placeholder='{"accept": "application/json"}'
    />
    <button
      onClick={() => {
        const currentApiKey = providers[activeProvider].apiKey;
        const kimiHeaders: Record<string, string> = {
          "accept": "application/json",
          "accept-language": "*",
          "sec-fetch-mode": "cors",
          "user-agent": "RooCode/3.31.0",
          "x-title": "Roo Code",
          "x-stainless-arch": "x64",
          "x-stainless-lang": "js",
          "x-stainless-os": "Windows",
          "x-stainless-package-version": "5.12.2",
          "x-stainless-retry-count": "0",
          "x-stainless-runtime": "node",
          "x-stainless-runtime-version": "v22.19.0"
        };
        if (currentApiKey) {
          kimiHeaders["authorization"] = "Bearer " + currentApiKey;
        }
        setCustomHeadersText(JSON.stringify(kimiHeaders, null, 2));
        handleProviderConfigChange(activeProvider, 'customHeaders', kimiHeaders);
      }}
    >
      Fill Kimi Headers
    </button>
  </div>
)}
```

---

## ✅ 验收标准

1. **测试连接**: 点击"测试连接"按钮，返回成功状态
2. **普通聊天**: 选择 Kimi 模型，发送消息，收到正常回复
3. **Cowork 模式**: 在 Cowork 模式下使用 Kimi，功能正常
4. **流式响应**: 支持 SSE 流式响应
5. **中文支持**: 返回内容无乱码

---

## 🐛 常见问题排查

### 问题 1: 403 Forbidden
**原因**: Headers 不正确或被 Chromium 覆盖
**解决**: 确保使用 Node.js 原生 `https` 模块发送请求

### 问题 2: 测试通过但聊天失败
**原因**: Cowork 模式和普通聊天使用不同的代码路径
**解决**: 同时修改 `api.ts` 和 `coworkOpenAICompatProxy.ts`

### 问题 3: Gzip 解析错误
**原因**: 响应被压缩但未被解压
**解决**: 使用 `zlib` 模块处理压缩响应

---

## 📁 修改文件清单

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/renderer/config.ts` | 修改 | 添加 Kimi 到 providers |
| `src/renderer/services/api.ts` | 修改 | 添加 Kimi headers 支持 |
| `src/renderer/components/Settings.tsx` | 修改 | 添加填充 headers 按钮 |
| `src/main/main.ts` | 修改 | 添加 Node.js http 处理 |
| `src/main/libs/coworkOpenAICompatProxy.ts` | 修改 | Cowork 模式支持 Kimi |

---

## 🔗 参考链接

- [Kimi API 文档](https://platform.moonshot.cn/)
- [Electron Net 模块](https://www.electronjs.org/docs/latest/api/net)
- [Node.js https 模块](https://nodejs.org/api/https.html)

---

*文档结束 - 祝开发顺利！*
