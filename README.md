<p align="center">
  <b>English</b> · <a href="README.pt-BR.md">Português</a>
</p>

# Habblaud OpenClaw

Virtual pixel art office dashboard for OpenClaw autonomous agents, sessions, and workflows.

## Overview

Habblaud OpenClaw is a real-time visualization dashboard and management interface for OpenClaw runtimes. It maps OpenClaw agents, subagents, and sessions to characters in an interactive virtual pixel art office. Each active session occupies a desk, navigates between rooms representing project workspaces, and displays real-time activity, thinking states, tool invocations, token metrics, and execution history.

The system is built on a lightweight, zero-runtime-dependency Node.js core that streams state via Server-Sent Events (SSE) to an HTML5 Canvas and TypeScript frontend.

## Architecture

The following diagram illustrates data flow and component boundaries:

```
+-------------------------------------------------------------+
|                      Host Environment                       |
|                                                             |
|  +---------------------------+                              |
|  |     OpenClaw Runtime      |                              |
|  |                           |                              |
|  |  SQLite Databases:        |                              |
|  |  - openclaw-agent.sqlite  |                              |
|  |  - state/openclaw.sqlite  |                              |
|  |  (Tables: session_nodes)  |                              |
|  +-------------+-------------+                              |
|                |                                            |
|                | Read-Only Volume Mount                     |
|                v                                            |
|  +-------------------------------------------------------+  |
|  |              Habblaud Container (Docker)              |  |
|  |                                                       |  |
|  |  +-------------------------------------------------+  |  |
|  |  | Ingestion Layer                                 |  |  |
|  |  | - SQLite Reader (session_nodes / entry_json)    |  |  |
|  |  | - Recursive FS Watcher (state synchronization)  |  |  |
|  |  | - Gateway Client (optional HTTP/WebSocket)      |  |  |
|  |  +------------------------+------------------------+  |  |
|  |                           |                           |  |
|  |  +------------------------v------------------------+  |  |
|  |  | Office Core Engine                              |  |  |
|  |  | - Room assignment and spatial layout            |  |  |
|  |  | - Agent status state machine                    |  |  |
|  |  | - SSE Event Hub (/api/stream, /api/snapshot)    |  |  |
|  |  +------------------------+------------------------+  |  |
|  |                           |                           |  |
|  |  +------------------------v------------------------+  |  |
|  |  | HTTP Server & Edge Guard                        |  |  |
|  |  | - DNS Rebinding & CSRF Protection               |  |  |
|  |  | - Terminal Streamer & Session Inspector         |  |  |
|  |  +-------------------------------------------------+  |  |
|  +---------------------------+---------------------------+  |
+------------------------------|------------------------------+
                               | HTTP / SSE (:4747)
                               v
                     +-------------------+
                     | Web Browser / NPM |
                     | Pixel Art Canvas  |
                     +-------------------+
```

### Core Components

1. Ingestion Layer (`server/sources/openclaw/`):
   - SQLite Reader: Directly reads `openclaw-agent.sqlite` and `openclaw.sqlite` in read-only mode (`node:sqlite`). Supports the current OpenClaw schema (`session_nodes` table with compressed or flat `entry_json` payloads) as well as fallback tables.
   - Filesystem Watcher: Observes changes in the OpenClaw data directory with error isolation to prevent unhandled `EACCES` crashes on restricted files.
   - Gateway Adapter: Connects to the OpenClaw Gateway API (`/api/sessions`) when configured.

2. Office Engine (`server/model/`):
   - Models the office rooms, desks, character avatars, and state machines (`working`, `waiting`, `shell`, `idle`).
   - Tracks token counts (input, output, context), execution durations, and model configurations.

3. Frontend (`client/`):
   - Pixel art rendering engine with automatic room scaling, viewport centering, and character pathfinding.
   - Agent inspection drawer with live logs, tool calls, and model metadata.

## Deployment

### Docker Compose (ZimaOS / Portainer / Docker CLI)

Create a `docker-compose.yml` file:

```yaml
version: "3.8"

services:
  habblaud:
    build: .
    image: habblaud:openclaw
    container_name: habblaud
    restart: unless-stopped
    ports:
      - "4747:4747"
    volumes:
      # Mount the OpenClaw state directory in read-only mode (:ro)
      - /DATA/AppData/openclaw:/openclaw:ro
      - habblaud-data:/data
    environment:
      OPENCLAW_HOME: /openclaw
      OPENCLAW_GATEWAY_URL: ""
      OPENCLAW_GATEWAY_TOKEN: ""
      HABBLAUD_BIND: "0.0.0.0"
      HABBLAUD_PORT: "4747"
      HABBLAUD_ALLOWED_HOSTS: "habblaud.zima.local,localhost,127.0.0.1"
      HABBLAUD_LANG: "pt"
      HABBLAUD_WORLD: "0"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    tmpfs:
      - /tmp:size=64m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    init: true

volumes:
  habblaud-data:
```

### Start the Container

```bash
docker compose up -d --build
```

Access the dashboard at `http://<HOST_IP>:4747` or through your configured domain.

## Reverse Proxy Configuration (Nginx Proxy Manager)

When accessing Habblaud through Nginx Proxy Manager, Traefik, or Caddy:

1. Add your domain (for example, `habblaud.zima.local`) to the `HABBLAUD_ALLOWED_HOSTS` environment variable:
   ```env
   HABBLAUD_ALLOWED_HOSTS=habblaud.zima.local
   ```
2. In Nginx Proxy Manager:
   - Scheme: `http`
   - Forward Hostname / IP: `<ZIMAOS_OR_DOCKER_HOST_IP>`
   - Forward Port: `4747`
   - Enable `Websockets Support` (required for real-time SSE and stream transport).

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OPENCLAW_HOME` | Absolute path to the OpenClaw state directory | `/openclaw` (Docker) or `~/.openclaw` |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway endpoint URL | Unset |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for OpenClaw Gateway authentication | Unset |
| `HABBLAUD_PORT` | HTTP port exposed by the Node server | `4747` |
| `HABBLAUD_BIND` | Bind host address (`0.0.0.0` for all interfaces) | `0.0.0.0` |
| `HABBLAUD_ALLOWED_HOSTS` | Comma-separated domain names for DNS rebinding protection | `localhost` |
| `HABBLAUD_LANG` | UI language (`pt`, `en`, `es`, `fr`) | `pt` |
| `HABBLAUD_DEMO` | Enable simulated test agents | `0` |
| `HABBLAUD_TERMINAL` | Enable agent terminal inspection | `1` |
| `HABBLAUD_WORLD` | Enable Habblaud World community uplink | `0` |

## Troubleshooting and Operations

### Host Not Allowed (403 Forbidden)

If you see:
`Host não permitido: habblaud.zima.local. Abra o Habblaud por http://localhost (ou pelo IP) ou libere o nome em HABBLAUD_ALLOWED_HOSTS.`

- Cause: Habblaud includes DNS Rebinding protection. By default, it accepts only IP addresses and `localhost`. Wildcard values (`*`) are now supported, but explicit domains are recommended.
- Fix: Set `HABBLAUD_ALLOWED_HOSTS=habblaud.zima.local` in `docker-compose.yml`.

### Terminal Unavailable Warning

If the agent drawer displays:
`O terminal só fica disponível quando o Habblaud roda com acesso local (bind 127.0.0.1)`

- Cause: The live session transcript feature contains conversation history and commands. For safety, the engine disables this feature when `HABBLAUD_BIND` is set to a non-loopback network address (`0.0.0.0`).
- Fix: If running locally without a network bridge, bind to `127.0.0.1`. In homelab proxy setups, access the service via localhost port forwarding or review access controls.

### Permissions Crash (EACCES) on Filesystem Watcher

- Cause: Backup or configuration files in the OpenClaw state directory created by root processes (such as `openclaw.json.bak-*` with `600` permissions) cannot be read by the container user. When `fs.watch` encounters permission barriers without an explicit `error` handler, Node.js terminates the process.
- Fix: Ensure files in `OPENCLAW_HOME` are owned by the container user UID (1000:1000). The source watcher now includes isolated error event handlers to prevent container crashes.

### Zero Sessions Detected (`ok: true, sessions: 0`)

- Cause: OpenClaw persists agent nodes and graph executions in the `session_nodes` SQLite table, using compressed JSON payloads (`entry_json`), rather than legacy `sessions` tables.
- Fix: Ensure the OpenClaw SQLite database path is mounted and that the database reader evaluates `session_nodes` with decompression support.

## Local Development

### Prerequisites

- Node.js 22.12 or newer
- npm 10 or newer

### Setup and Build

```bash
# Install dependencies
npm ci

# Run development mode with HMR
OPENCLAW_HOME=~/.openclaw npm run dev

# Run type check and tests
npm run typecheck
npm test

# Build production bundle
npm run build

# Start production server
npm start
```

## License

MIT
