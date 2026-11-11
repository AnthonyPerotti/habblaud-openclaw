# Habblaud OpenClaw

Virtual pixel art office dashboard for OpenClaw autonomous agents and sessions.

## Overview

Habblaud connects to an OpenClaw runtime, monitoring active sessions, agent status, token consumption, and model delegations in real time. Each OpenClaw session is displayed as a character working at a desk, navigating the office, or collaborating with parent agents.

The server operates without runtime dependencies beyond standard Node.js built-ins. Data ingestion reads directly from local OpenClaw SQLite databases and state files mounted in read-only mode, with optional support for the OpenClaw Gateway API.

## Architecture

1. Core Engine: Maintains the virtual office state machine, room assignment, and Server-Sent Events (SSE) stream.
2. Ingestion Layer:
   - SQLite Reader: Periodically queries OpenClaw agent databases (`openclaw-agent.sqlite`, `openclaw.sqlite`) using read-only access.
   - Filesystem Watcher: Reacts immediately to changes in the OpenClaw state directory.
   - Gateway Adapter (Optional): Queries the OpenClaw Gateway HTTP/WebSocket endpoint when configured.
3. Frontend: Lightweight pixel art canvas and UI written in TypeScript and compiled via Vite.

## Deployment on ZimaOS / Docker

To deploy Habblaud alongside OpenClaw in ZimaOS:

### 1. Configure docker-compose.yml

Ensure the volume points to your OpenClaw state directory on the host (for example, `/DATA/AppData/openclaw` or `~/.openclaw`):

```yaml
version: "3.8"

services:
  habblaud:
    build: .
    image: habblaud:openclaw
    container_name: habblaud
    restart: unless-stopped
    ports:
      - "0.0.0.0:4747:4747"
    volumes:
      - /DATA/AppData/openclaw:/openclaw:ro
      - habblaud-data:/data
    environment:
      OPENCLAW_HOME: /openclaw
      OPENCLAW_GATEWAY_URL: "http://openclaw:18789"
      OPENCLAW_GATEWAY_TOKEN: ""
      HABBLAUD_BIND: "0.0.0.0"
      HABBLAUD_LANG: "pt"
      HABBLAUD_WORLD: "0"

volumes:
  habblaud-data:
```

### 2. Start the Service

```bash
docker compose up -d --build
```

Access the dashboard at `http://<ZIMAOS_IP>:4747`.

## Local Development

### Requirements

- Node.js 22.12 or newer
- npm

### Build and Run

```bash
# Install dependencies
npm ci

# Compile client and server
npm run build

# Start production server
npm start
```

For hot-reload development:

```bash
OPENCLAW_HOME=~/.openclaw npm run dev
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OPENCLAW_HOME` | Path to the OpenClaw state directory (`agents/`, `state/`) | `/openclaw` (Docker) or `~/.openclaw` (host) |
| `OPENCLAW_GATEWAY_URL` | Optional URL to the OpenClaw Gateway HTTP endpoint | Unset |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for OpenClaw Gateway authentication | Unset |
| `HABBLAUD_PORT` | HTTP port exposed by the server | `4747` |
| `HABBLAUD_BIND` | Bind host address | `0.0.0.0` |
| `HABBLAUD_LANG` | UI language (`pt`, `en`, `es`, `fr`) | `pt` |
| `HABBLAUD_DEMO` | Enable simulated demo agents | `0` |

## License

MIT
