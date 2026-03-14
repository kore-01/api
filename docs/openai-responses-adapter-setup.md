# OpenAI Responses Adapter 部署说明

## 📖 概述

**openai-responses-adapter** 是一个轻量级的 Go 代理服务，专门用于将 OpenAI **Responses API** 格式的请求转换为 **Chat Completions API** 格式，使 OpenCode 和 Claude Code 能够与不支持 `/v1/responses` 端点的 API 服务（如 590 API）无缝对接。

## 🎯 解决的问题

- OpenCode/Claude Code 使用 `/v1/responses` 端点
- 590 API 只支持 `/v1/chat/completions` 端点
- **Adapter** 充当翻译层，自动转换请求和响应格式

## 🏗️ 架构说明

```
┌─────────────────────────┐
│ OpenCode/Claude Code    │
│  /v1/responses          │
└───────────┬─────────────┘
            │
            ↓
┌─────────────────────────┐
│ Responses Adapter       │
│  Port: 3061             │
│  格式转换                │
└───────────┬─────────────┘
            │
            ↓ /v1/chat/completions
┌─────────────────────────┐
│ 590 API                 │
│  api.590.net            │
└─────────────────────────┘
```

## 📦 部署步骤

### 1. 准备服务器环境

**服务器要求**：
- 操作系统：Linux（推荐 Ubuntu/CentOS）
- 已安装 Docker
- 服务器位置：与 590 API 同一台服务器（推荐，降低延迟）

### 2. 获取代码

```bash
# 克隆仓库
cd /opt
git clone https://github.com/Kurok1/openai-responses-adapter.git
cd openai-responses-adapter
```

### 3. 构建 Docker 镜像

```bash
# 构建镜像
docker build -t openai-responses-adapter:dev .
```

### 4. 启动服务

```bash
docker run -d \
  --name responses-adapter \
  --restart always \
  -p 3061:3061 \
  -e LISTEN_ADDR=:3061 \
  -e UPSTREAM_BASE_URL=https://api.590.net \
  -e UPSTREAM_CHAT_PATH=/v1/chat/completions \
  -e UPSTREAM_API_KEY=sk-4453974644643322270 \
  -e STORE_MAX_ENTRIES=1000 \
  -e STORE_TTL=1h \
  openai-responses-adapter:dev
```

### 5. 验证服务状态

```bash
# 查看容器状态
docker ps | grep responses-adapter

# 查看启动日志
docker logs responses-adapter

# 测试端点
curl -X POST http://localhost:3061/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-4453974644643322270' \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "input": "你好"
  }'
```

## ⚙️ 环境变量配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `LISTEN_ADDR` | `:8080` | 监听地址和端口 |
| `UPSTREAM_BASE_URL` | `https://api.openai.com` | 上游 API 地址 |
| `UPSTREAM_CHAT_PATH` | `/v1/chat/completions` | 转发路径 |
| `UPSTREAM_API_KEY` | - | 上游 API 密钥 |
| `STORE_MAX_ENTRIES` | `1000` | 内存存储最大条目数 |
| `STORE_TTL` | `1h` | 存储过期时间（Go duration 格式） |
| `MCP_CONFIG_PATH` | - | MCP 工具配置文件路径（可选） |

## 🔧 使用方法

### 在 OpenCode/Claude Code 中配置

1. **打开设置**：找到 API 配置选项
2. **填写配置**：
   ```
   API 地址: http://43.155.130.168:3061/v1/responses
   API 密钥: sk-4453974644643322270
   模型: claude-sonnet-4-20250514
   ```
3. **保存并测试**：发送一条测试消息验证连接

### 请求格式示例

**非流式请求**：
```json
{
  "model": "claude-sonnet-4-20250514",
  "input": [
    {
      "role": "user",
      "content": "介绍一下你自己"
    }
  ],
  "stream": false
}
```

**流式请求**：
```json
{
  "model": "claude-sonnet-4-20250514",
  "input": "写一首关于春天的诗",
  "stream": true
}
```

**带工具调用的请求**：
```json
{
  "model": "claude-sonnet-4-20250514",
  "input": "查询今天的天气",
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "获取指定城市的天气信息",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string",
            "description": "城市名称"
          }
        },
        "required": ["city"]
      }
    }
  ]
}
```

## 🛠️ 服务管理

### 查看日志
```bash
# 实时查看日志
docker logs -f responses-adapter

# 查看最近 100 行日志
docker logs --tail 100 responses-adapter
```

### 重启服务
```bash
docker restart responses-adapter
```

### 停止服务
```bash
docker stop responses-adapter
```

### 更新配置
```bash
# 停止并删除旧容器
docker stop responses-adapter
docker rm responses-adapter

# 使用新配置重新运行
docker run -d \
  --name responses-adapter \
  --restart always \
  -p 3061:3061 \
  -e LISTEN_ADDR=:3061 \
  -e UPSTREAM_BASE_URL=https://api.590.net \
  -e UPSTREAM_CHAT_PATH=/v1/chat/completions \
  -e UPSTREAM_API_KEY=sk-YOUR_NEW_API_KEY \
  openai-responses-adapter:dev
```

### 更新到最新版本
```bash
cd /opt/openai-responses-adapter
git pull
docker build -t openai-responses-adapter:dev .
docker stop responses-adapter && docker rm responses-adapter
# 重新运行 docker run 命令
```

## 🔍 故障排查

### 问题 1：容器无法启动
**检查方法**：
```bash
docker logs responses-adapter
```

**常见原因**：
- 端口被占用：检查 `3061` 端口是否被其他程序占用
- 配置错误：检查环境变量格式是否正确

### 问题 2：返回 404 错误
**原因**：上游路径配置错误

**解决方法**：
确保 `UPSTREAM_BASE_URL` 不包含路径：
```
✅ 正确：UPSTREAM_BASE_URL=https://api.590.net
❌ 错误：UPSTREAM_BASE_URL=https://api.590.net/v1
```

### 问题 3：返回认证错误
**检查项**：
- `UPSTREAM_API_KEY` 是否正确
- API 密钥是否有效
- API 密钥是否有足够的配额

### 问题 4：流式响应中断
**检查网络**：
```bash
# 检查到上游 API 的连接
curl -I https://api.590.net/v1/chat/completions
```

**检查超时设置**：
- 确保 `READ_TIMEOUT` 和 `WRITE_TIMEOUT` 配置合理
- 检查网络稳定性

## 📊 监控和性能

### 性能指标
- **延迟**：< 50ms（与 590 API 同服务器部署）
- **并发**：支持大量并发连接
- **内存占用**：约 50-100MB

### 监控命令
```bash
# 查看容器资源使用
docker stats responses-adapter

# 查看容器详细信息
docker inspect responses-adapter
```

## 🔐 安全建议

1. **API 密钥保护**：
   - 不要在日志中打印完整的 API 密钥
   - 定期轮换 API 密钥

2. **访问控制**：
   - 使用防火墙限制访问来源
   - 考虑添加认证层

3. **网络安全**：
   - 使用 HTTPS（生产环境推荐）
   - 配置适当的 CORS 策略

## 📝 版本信息

- **项目地址**：https://github.com/Kurok1/openai-responses-adapter
- **当前版本**：dev
- **部署日期**：2026-03-15
- **部署位置**：KR 服务器 (43.155.130.168:3061)

## 🤝 技术支持

如有问题，请检查：
1. Docker 日志：`docker logs responses-adapter`
2. 网络连接：确保能访问 api.590.net
3. API 密钥：验证密钥有效性和配额

## 📄 许可证

本项目基于 Apache License 2.0 开源。
