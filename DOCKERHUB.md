# kore — AI API Proxy

Self-hosted AI API gateway / reverse proxy with provider failover, load balancing, usage quotas, and a modern web dashboard.

## Quick Start

```bash
mkdir kore && cd kore
curl -fsSL https://raw.githubusercontent.com/kore-01/api/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

Visit `http://your-server:3060` to create your admin account. That's it.

Encryption keys are auto-generated on first run and persisted in the data volume.

## Features

- **OpenAI-compatible API** — `/v1/chat/completions`, works with any app supporting custom OpenAI endpoints
- **SSE Streaming** — Full streaming support
- **Smart Failover** — Priority or Round Robin with automatic fault detection and recovery
- **Usage Quotas** — Token limits per provider and per strategy
- **Proxy Support** — HTTP/SOCKS5 per provider
- **GeoIP Logging** — Client IP country with local caching
- **Multi-language** — English & Chinese
- **Secure** — AES-256-GCM encrypted API key storage, keys auto-generated and persisted

## Docker Compose

```yaml
services:
  kore:
    image: kore01/api:latest
    container_name: kore
    restart: unless-stopped
    ports:
      - "3060:3060"
    volumes:
      - kore-data:/app/data

volumes:
  kore-data:
```

## Environment Variables

All optional. Keys are auto-generated if not provided.

| Variable | Default | Description |
|----------|---------|-------------|
| `KORE_ENCRYPTION_KEY` | *(auto)* | AES-256 key for encrypting API keys |
| `JWT_SECRET` | *(auto)* | JWT signing secret |
| `PORT` | `3060` | Server port |
| `IPINFO_TOKEN` | — | ipinfo.io token for GeoIP fallback |
| `FIRST_TOKEN_TIMEOUT` | `15000` | Streaming first-token timeout (ms) |
| `NON_STREAM_TIMEOUT` | `30000` | Non-streaming timeout (ms) |

## Data Persistence

Database and auto-generated keys are stored at `/app/data/` inside the container. Mount a volume to persist:

```yaml
volumes:
  - kore-data:/app/data    # Named volume (recommended)
  - ./data:/app/data        # Or bind mount
```

## Commands

```bash
docker compose up -d                              # Start
docker compose logs -f kore                       # Logs
docker compose down                                # Stop
docker compose pull && docker compose up -d        # Update
```

## Links

- **GitHub:** [github.com/kore-01/api](https://github.com/kore-01/api)
- **Issues:** [github.com/kore-01/api/issues](https://github.com/kore-01/api/issues)
