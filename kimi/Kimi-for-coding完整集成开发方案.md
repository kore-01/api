# 📘 Kimi-for-coding 模型完整集成开发方案

> **版本**: 1.0
> **更新日期**: 2026-01-21
> **适用场景**: 任何需要集成 Kimi-for-coding (Moonshot AI 编程模型) 的客户端软件开发

## 🌟 核心背景

Kimi-for-coding 是 Moonshot AI 推出的针对编程场景优化的模型。与通用 LLM API 不同，它有更严格的访问控制和网络要求。如果不遵循特定的协议，开发者通常会遇到 **403 Forbidden** 或 **解析错误**。

### 关键参数
- **API Endpoint**: `https://api.kimi.com/coding/v1` (注意路径中的 `coding`)
- **Model Name**: `kimi-for-coding` (通常自动映射，但建议显式指定)
- **Authentication**: Bearer Token (API Key)

---

## 🚧 三大拦路虎 (Common Pitfalls)

在集成过程中，你99%会遇到以下三个问题：

1.  **403 Forbidden (`access_terminated_error`)**
    *   **原因**: 服务器通过 HTTP Headers 严格校验客户端身份。
    *   **盲区**: 标准 SDK (如 OpenAI .NET SDK) 或浏览器 `fetch` 可能会忽略、覆盖或无法发送某些受限 Headers (如 `User-Agent`, `x-title`)。

2.  **Gzip 解析错误 (`0x1F is an invalid start...`)**
    *   **原因**: Kimi 服务器可能强制返回 Gzip 压缩数据，不考虑请求中的 `Accept-Encoding`。
    *   **盲区**: 许多 HTTP 客户端默认不开启自动解压。

3.  **流式请求失败 (Streaming Failure)**
    *   **原因**: 浏览器的安全策略 (CORS/Forbidden Headers) 禁止在 `window.fetch` 或 `EventSource` 中设置特定的 Headers。
    *   **盲区**: 仅仅在非流式请求中测试通过，一开流式就报错。

---

## 🛠️ 解决方案 A：.NET / C# 客户端 (基于 Everywhere 实践)

适用于 WPF, WinForms, Avalonia, ASP.NET Core 等后端或桌面应用。

### 1. 攻克 Headers 丢失：使用 SDK Pipeline Policy
不要依赖 `HttpClient.DefaultRequestHeaders`，它在 SDK 内部可能失效。使用 `PipelinePolicy` 注入。

```csharp
// 定义 Policy
internal sealed class KimiHeadersPolicy(Dictionary<string, string> headers) : PipelinePolicy
{
    public override void Process(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        ApplyHeaders(message);
        ProcessNext(message, pipeline, currentIndex);
    }

    public override async ValueTask ProcessAsync(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        ApplyHeaders(message);
        await ProcessNextAsync(message, pipeline, currentIndex);
    }

    private void ApplyHeaders(PipelineMessage message)
    {
        foreach (var (key, value) in headers)
        {
            if (key.Equals("host", StringComparison.OrdinalIgnoreCase)) continue; // Host 由系统管理
            message.Request.Headers.Set(key, value);
        }
    }
}

// 注册 Policy
var clientOptions = new OpenAIClientOptions { Endpoint = new Uri("https://api.kimi.com/coding/v1") };
var customHeaders = new Dictionary<string, string> {
    ["User-Agent"] = "RooCode/3.31.0", // 必须伪装成受支持的客户端
    ["x-title"] = "Roo Code"
};
clientOptions.AddPolicy(new KimiHeadersPolicy(customHeaders), PipelinePosition.PerCall);
```

### 2. 攻克 Gzip 压缩：全局启用自动解压
在创建 `HttpClient` 时强制开启解压。

```csharp
services.AddHttpClient("KimiClient")
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
    {
        // 关键：启用所有解压算法
        AutomaticDecompression = DecompressionMethods.All 
    });
```

---

## 🛠️ 解决方案 B：Hybrid / Tauri 应用 (基于 pot-desktop 实践)

适用于使用 Web 技术栈开发界面，但有 Rust/Go 后端的应用。

### 1. 核心原则：绕过浏览器
**严禁**使用前端的 `window.fetch` 或 `fetch` API 调用 Kimi 接口，因为你无法设置受限的 `User-Agent` 等头，必报 403。

### 2. 后端代理 (Rust 示例)
在 Rust 后端实现一个支持流式的 HTTP 命令。

```rust
// src-tauri/src/cmd.rs
#[tauri::command]
pub async fn stream_fetch(
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    use reqwest::Client;
    let client = Client::new();
    // 1. 构建请求 (Reqwest 不受浏览器限制)
    let mut builder = client.request(method.parse().unwrap(), &url);
    for (k, v) in headers { builder = builder.header(k, v); }
    if let Some(b) = body { builder = builder.body(b); }

    // 2. 发送请求
    let mut response = builder.send().await.map_err(|e| e.to_string())?;

    // 3. 流式读取并向前端发射事件
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        let text = String::from_utf8_lossy(&chunk).to_string();
        window.emit("stream_data", text).unwrap(); // 发射数据块
    }
    window.emit("stream_end", "").unwrap();
    Ok(())
}
```

### 3. 前端调用 (JavaScript)
使用 Tauri 的 `invoke` 和 `listen` 替代 `fetch`。

```javascript
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';

if (stream) {
    // 监听数据流
    const unlisten = await listen('stream_data', (event) => {
        const chunk = event.payload;
        // 处理 SSE 格式数据 (data: {...})
        processSSE(chunk);
    });
    
    // 调用 Rust 后端
    await invoke('stream_fetch', {
        url: "https://api.kimi.com/coding/v1/chat/completions",
        method: "POST",
        headers: {
            "Authorization": "Bearer ...",
            "User-Agent": "RooCode/3.31.0", // 现在可以成功设置了！
            "x-title": "Roo Code"
        },
        body: JSON.stringify({...})
    });
    
    unlisten();
}
```

---

## 📋 完整 Headers 清单 (Copy & Paste)

无论使用哪种方案，确保你的请求包含以下 Headers：

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
  "x-stainless-runtime-version": "v22.19.0"
}
```

## ✅ 验收标准
1.  **非流式测试**：请求成功，状态码 200。
2.  **流式测试**：能够逐步收到 token，且不中断。
3.  **中文测试**：返回内容无乱码（Gzip 解压正常）。
