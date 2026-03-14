# 功能：Kimi-for-coding 模型集成

## 📅 更新日志
- **2026-01-29**: 财经新闻系统完成多模型配置与自定义请求头支持（Python/Flask + 前端UI）
- **2026-01-21**: 修复 Kimi 403 错误（通过 CustomHeadersPolicy 和 AutomaticDecompression）
- **2026-01-20**: 初始实现 Kimi-for-coding 集成

## 🚀 集成方案

### 1. 核心问题与解决方案

在将 Kimi-for-coding 模型集成到 Everywhere 项目中时，遇到了顽固的 403 错误 (`access_terminated_error`)。
报错信息暗示需要特定的客户端标识（如 `Roo Code`）。

#### 问题 A：Custom Headers 未正确传递
- **现象**：即使配置了 headers，OpenAI SDK 似乎忽略了它们。
- **原因**：OpenAI .NET SDK 在流式请求 (`GetStreamingResponseAsync`) 中可能不完全使用 `HttpClient.DefaultRequestHeaders`，或者某些头被覆盖。
- **修复**：使用 **SDK Pipeline Policy** 直接在底层管道注入 headers。
  - 创建 `CustomHeadersPolicy : PipelinePolicy`
  - 使用 `OpenAIClientOptions.AddPolicy(new CustomHeadersPolicy(...), PipelinePosition.PerCall)` 注入。

#### 问题 B：Gzip 压缩导致 0x1F 错误
- **现象**：请求头生效后，出现 `'0x1F' is an invalid start of a value` 错误。
- **原因**：服务器返回了 gzip 压缩的数据，但 `HttpClient` 默认未启用自动解压。
- **修复**：配置 `HttpClientHandler.AutomaticDecompression = DecompressionMethods.All`。
  - 在 `NetworkInitializer.cs` 的 `ConfigureNetwork` 方法中全局设置。

### 2. 代码实现详情

#### KernelMixinFactory.cs
负责创建 `OptimizedOpenAIApiClient`，并配置 Pipeline Policy。

```csharp
// 在 OpenAIKernelMixin.cs 中
var clientOptions = new OpenAIClientOptions
{
    Endpoint = new Uri(Endpoint, UriKind.Absolute),
    Transport = new HttpClientPipelineTransport(httpClient, true, loggerFactory)
};

// 关键：添加自定义 headers policy
if (customAssistant.CustomHeaders is { Count: > 0 } customHeaders)
{
    clientOptions.AddPolicy(new CustomHeadersPolicy(customHeaders), PipelinePosition.PerCall);
}
```

#### CustomHeadersPolicy.cs (内部类)
```csharp
private sealed class CustomHeadersPolicy(Dictionary<string, string> headers) : PipelinePolicy
{
    // ... Process 和 ProcessAsync 实现 ...
    private void ApplyHeaders(PipelineMessage message)
    {
        foreach (var (key, value) in headers)
        {
            // 跳过 host，由系统自动管理
            if (key.Equals("host", StringComparison.OrdinalIgnoreCase)) continue;
            message.Request.Headers.Set(key, value);
        }
    }
}
```

#### NetworkInitializer.cs
确保 `HttpClient` 能处理压缩响应。

```csharp
.ConfigurePrimaryHttpMessageHandler(serviceProvider =>
    new HttpClientHandler
    {
        // ... 其他配置 ...
        AutomaticDecompression = DecompressionMethods.All // 关键修复
    });
```

### 3. Kimi for Coding 预设配置
- **API Endpoint**: `https://api.kimi.com/coding/v1`
- **必需 Headers**:
  - `user-agent`: `RooCode/3.31.0` (或其他受支持的客户端 ID)
  - `x-title`: `Roo Code`
  - 其他如 `x-stainless-*` 等模拟头

---

## 🐍 Python / Flask 集成方案

财经新闻系统采用前后端分离架构：
- **后端**: Python Flask + `ai_model_config.py` 配置管理器
- **前端**: Bootstrap 5 + 原生 JavaScript
- **配置存储**: `ai_model_settings.json`

### 核心实现要点

#### 1. 配置管理 (ai_model_config.py)
```python
@dataclass
class AIModelConfig:
    id: str
    display_name: str
    provider: str
    api_key: str = ""
    endpoint: str = ""
    model_id: str = ""
    schema: str = "openai"  # openai, anthropic
    custom_headers: Dict[str, str] = field(default_factory=dict)  # 关键字段
```

#### 2. AI处理器关键代码
```python
def _build_headers(self) -> dict:
    api_key = self._get_api_key()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}

    if self.model_config:
        if self.model_config.schema == "anthropic":
            headers["x-api-key"] = api_key
        else:
            headers["Authorization"] = f"Bearer {api_key}"

        # 关键：优先使用配置中的 custom_headers
        if self.model_config.custom_headers:
            headers.update(self.model_config.custom_headers)

    return headers
```

#### 3. 前端一键填入请求头
```javascript
function applyKimiHeaders() {
    const kimiHeaders = {
        "accept": "application/json",
        "accept-language": "*",
        "http-referer": "https://github.com/RooVetGit/Roo-Cline",
        "sec-fetch-mode": "cors",
        "user-agent": "RooCode/3.31.0",
        "x-stainless-arch": "x64",
        "x-stainless-lang": "js",
        "x-stainless-os": "Windows",
        "x-stainless-package-version": "5.12.2",
        "x-stainless-retry-count": "0",
        "x-stainless-runtime": "node",
        "x-stainless-runtime-version": "v22.19.0",
        "x-title": "Roo Code"
    };
    document.getElementById("editCustomHeaders").value =
        JSON.stringify(kimiHeaders, null, 2);
}
```

### 关键经验
| 问题 | 现象 | 解决方案 |
|------|------|----------|
| 模型测试通过但翻译失败 | 测试OK，实际翻译403 | 测试代码使用了custom_headers，但翻译代码使用hardcoded headers |
| 配置未生效 | 修改配置后行为不变 | 检查处理器是否正确初始化并读取配置 |

---

## 📋 必需 Headers 清单

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

---

## ✅ 验收标准
1. 模型测试通过: 点击"测试"按钮，返回成功响应
2. 单条翻译正常: 点击新闻卡片"AI翻译"，正常返回中文
3. 批量翻译正常: 点击"全部翻译"，所有国际新闻都被翻译
4. 配置持久化: 修改配置后重启服务，配置依然有效

---

## NOTE

### .NET 开发者注意
- 使用 `PipelinePolicy` 注入 Headers（比 `HttpClient.DefaultRequestHeaders` 更可靠）
- 启用 `AutomaticDecompression`（许多 AI 服务强制 Gzip）

### Python 开发者注意
- 使用 `requests` 库时，headers 通过 `headers=` 参数传递
- 确保处理器代码**动态读取**配置，不要使用 hardcoded headers
- 配置文件使用 UTF-8 编码，避免中文乱码

### 前端开发者注意
- 浏览器前端**无法设置**受限 Headers（如 `User-Agent`）
- 所有 AI 请求必须通过**后端代理**，不要直接从前端调用
