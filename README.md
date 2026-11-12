<p align="center">
  <img src="client/public/assets/brand/logo-mark@4x.png" width="96" alt="Habblaud logo: pixel art building" />
</p>

# Habblaud OpenClaw

Virtual pixel art office dashboard for OpenClaw autonomous agents, sessions, and workflows.

<p align="center">
  <img src="docs/screenshots/office.gif" width="820" alt="Animation of Habblaud office: agents typing at desks, subagents moving between rooms and activity bubbles" />
</p>

## Overview

Habblaud OpenClaw is a real-time visualization dashboard and operational office for OpenClaw runtimes. It maps autonomous OpenClaw agents, subagents, and sessions to characters in an interactive virtual pixel art building.

Each active session occupies an assigned desk, navigates between rooms representing project workspaces, and displays real-time activity, thinking states, tool invocations, token metrics, and execution history.

The system is built on a zero-runtime-dependency Node.js core that streams state via Server-Sent Events (SSE) to an HTML5 Canvas and TypeScript frontend.

## Visual Tour

### Building Overview

The building includes a reception lobby with working elevators, restrooms, a kitchen breakroom, a recreational lounge, and modular project rooms along the hallway. At the top, session and token counters display resource usage. On the left, the drawer lists rooms and agents. At the bottom, a live event feed streams actions.

![Habblaud overview: building with lobby, kitchen, restrooms, lounge and project rooms](docs/screenshots/overview.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/agent-details.png" alt="Details drawer of an agent with tasks, subagents, timeline and stats" /></td>
    <td width="50%"><img src="docs/screenshots/night.png" alt="The office at night, with streetlights on and lit rooms" /></td>
  </tr>
  <tr>
    <td><b>Agent Details:</b> Inspect running status, model specifications, subagent trees, token consumption, and execution history.</td>
    <td><b>Day and Night Cycle:</b> Office lighting, window sky colors, and outdoor street lamps adjust dynamically to local time.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="42%"><img src="docs/screenshots/collab.png" alt="Subagent delivering results to the main agent" /></td>
    <td width="58%">
      <b>Collaboration in Plain Sight.</b> When OpenClaw spawns child sessions (subagents), coworkers arrive by elevator with distinct names and badges. They navigate to the project desk, process tasks, and walk over to the parent agent to deliver results before leaving.<br /><br />
      <b>Interactive Inquiries.</b> When an agent requires user input or approval, it moves to its desk and raises an alert banner. Notifications can be configured with browser prompts and audio cues.
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="58%">
      <b>Long-Running Shell Execution.</b> When an agent launches long-running builds, test suites, or background processes, it remains at its desk with progress indicators and command labels. As execution proceeds, visual animations adapt based on elapsed time.
    </td>
    <td width="42%"><img src="docs/screenshots/shell-wait.png" alt="Agent waiting at desk with execution progress bubble" /></td>
  </tr>
</table>

### Dynamic Room Lifecycle

Rooms are generated dynamically as OpenClaw sessions are spawned across workspace directories. When all sessions in a project conclude, the room transitions cleanly through its lifecycle:

| 1. Room setup | 2. Active work | 3. Last session completes | 4. Lot converted to garden |
| --- | --- | --- | --- |
| ![Room being set up with furniture](docs/screenshots/lifecycle-1.png) | ![Lit room with agents working](docs/screenshots/lifecycle-2.png) | ![Lights off after agents leave](docs/screenshots/lifecycle-3.png) | ![Lot transformed into garden](docs/screenshots/lifecycle-4.png) |

<table>
  <tr>
    <td width="34%"><img src="docs/screenshots/mobile.png" alt="Habblaud responsive interface on mobile" /></td>
    <td>
      <b>Mobile and Tablet Ready.</b> The interface adapts responsively to mobile and tablet screens. Resource metrics remain accessible at the top, the room directory collapses into a slide-out drawer, and agent detail sheets expand smoothly from the bottom.
    </td>
  </tr>
</table>

## Key Features

### Office Themes

The office supports seasonal and custom visual styles, accessible in Settings -> Appearance:

- **Automatic:** Follows calendar seasons based on local time.
- **Original:** Classic corporate pixel art palette.
- **Christmas:** Holiday decorations, seasonal rugs, and festive character hats.
- **Halloween:** Jack-o-lanterns, decorative cobwebs, and themed costumes.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/seasonal-christmas.png" alt="Office with Christmas holiday theme" /></td>
    <td width="50%"><img src="docs/screenshots/seasonal-halloween.png" alt="Office with Halloween holiday theme" /></td>
  </tr>
</table>

### GitHub Workflows in the Office

When OpenClaw agents execute git commands, pull requests, or CI checks, the room reflects deployment events in real time:

- **PR Created or Merged:** Confetti celebration and announcement banner in the project room.
- **CI Failure:** Flashing warning beacons and alert indicators over the responsible agent.
- **Branch Push:** Live status notices and stream entries.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/github-party.png" alt="Room celebration on PR merge" /></td>
    <td width="50%"><img src="docs/screenshots/github-alarm.png" alt="Room alert on CI failure" /></td>
  </tr>
</table>

### Office Social Life and Break Areas

When agents are idle or waiting between execution cycles, they gather in common areas based on randomized personality traits:

<p align="center">
  <img src="docs/screenshots/social-lounge.gif" width="816" alt="Lounge activities: arcade machine, sofa TV, and table tennis" />
</p>

- **Lounge TV and Arcade:** Characters watch sports, play split-screen games, or challenge each other at arcade cabinets.
- **Table Tennis:** Interactive ping-pong matches with score tracking.
- **Kitchen and Coffee Station:** Informal breaks with dialogue bubbles referencing project activity.
- **Coin Minigames:** Rock-paper-scissors challenges with coin transfers and leaderboards.
- **Restroom Mirrors:** Characters freshen up with reflected avatar sprites.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/social-rps.png" alt="Rock paper scissors challenge in the lobby" /></td>
    <td width="50%"><img src="docs/screenshots/social-kitchen.png" alt="Agents conversing in the kitchen" /></td>
  </tr>
  <tr>
    <td><b>Mini Challenges:</b> Wagers scaled to agent personality traits.</td>
    <td><b>Kitchen Conversations:</b> Idle dialogues reflecting work events.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/social-mirror.png" alt="Agents at the restroom mirror" /></td>
    <td><img src="docs/screenshots/social-drawer.png" alt="Social profile and stats in the agent drawer" /></td>
  </tr>
  <tr>
    <td><b>Restroom Mirrors:</b> Interactive reflections and vanity animations.</td>
    <td><b>Social Profile:</b> Track records, wallet balance, and peer relationships.</td>
  </tr>
</table>

### Core Components

1. **Ingestion Layer (`server/sources/openclaw/`):**
   - **SQLite Reader:** Directly inspects `openclaw-agent.sqlite` and `openclaw.sqlite` in read-only mode using `node:sqlite`. Extracts rows from `session_nodes` (with decompression of `entry_json` and direct extraction of the `label` column) and handles fallback schemas.
   - **Immutable URI Fallback:** When reading databases mounted read-only (`:ro`) in Docker, automatically switches to `file:... ?immutable=1` to avoid SQLite WAL `-shm` write lock failures.
   - **Filesystem Watcher:** Observes directory changes with error containment to prevent unhandled `EACCES` crashes on restricted files.

2. **Office Engine (`server/model/`):**
   - Manages room coordinates, furniture slots, avatar assignments, and activity states (`working`, `waiting`, `shell`, `idle`).
   - Automatically cleans up deleted sessions using `closeMain()` and `completeSub()` with grace periods, preventing orphaned ghost agents.
   - Tracks token counts, execution durations, and model configurations.

3. **Frontend (`client/`):**
   - Canvas-based isometric pixel engine with dynamic camera framing, pathfinding, and sprite caching.
   - Detailed inspection drawer with live transcripts, task checklists, and model metadata.

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
      HABBLAUD_ALLOWED_HOSTS: "*"
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
    name: habblaud-data
```

### Start the Container

```bash
docker compose up -d --build
```

Access the dashboard at `http://<HOST_IP>:4747` or through your local domain name.

## Reverse Proxy Configuration (Nginx Proxy Manager)

When accessing Habblaud through Nginx Proxy Manager, Traefik, or Caddy:

1. In your proxy configuration:
   - Scheme: `http`
   - Forward Hostname / IP: `<HOST_IP>`
   - Forward Port: `4747`
   - Enable **Websockets Support** (required for real-time SSE stream transport).
2. The server guard automatically trusts local domains (`.local`, `.lan`, `.internal`, `.home`). For external public domains, specify them in `HABBLAUD_ALLOWED_HOSTS`.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OPENCLAW_HOME` | Absolute path to the OpenClaw state directory | `/openclaw` (Docker) or `~/.openclaw` |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway endpoint URL | Unset |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for OpenClaw Gateway authentication | Unset |
| `HABBLAUD_PORT` | HTTP port exposed by the Node server | `4747` |
| `HABBLAUD_BIND` | Bind host address (`0.0.0.0` for all interfaces) | `0.0.0.0` |
| `HABBLAUD_ALLOWED_HOSTS` | Accepted host headers (`*` allowed in Docker) | `*` in Docker, `localhost` outside |
| `HABBLAUD_LANG` | UI language (`pt`, `en`, `es`, `fr`) | `pt` |
| `HABBLAUD_DEMO` | Enable simulated demo agents | `0` |
| `HABBLAUD_TERMINAL` | Enable agent terminal inspection | `1` |
| `HABBLAUD_TRUST_PROXY` | Enable terminal and messages when behind a trusted local reverse proxy | Unset |
| `HABBLAUD_WORLD` | Enable Habblaud World community uplink | `0` |

## Troubleshooting and Operations

### Host Not Allowed (403 Forbidden)

If you see:
`Host não permitido: <domain>. Abra o Habblaud por http://localhost ou libere o nome em HABBLAUD_ALLOWED_HOSTS.`

- **Cause:** Habblaud includes DNS Rebinding protection.
- **Fix:** Set `HABBLAUD_ALLOWED_HOSTS=*` or specify your domain (e.g. `habblaud.zima.local`) in the environment variables. The server automatically permits `.local` and `.lan` domains by default.

### SQLite WAL Mode on Read-Only Mount (`unable to open database file`)

- **Cause:** In Docker, mounting the state volume with `:ro` prevents SQLite in WAL mode from writing to the `-shm` lockfile.
- **Fix:** The OpenClaw reader automatically falls back to URI mode (`file:... ?immutable=1`), allowing reads without shared memory file locks.

### Task Label Falling Back to `Tarefa (dashboard)`

- **Cause:** OpenClaw stores session labels in the `session_nodes.label` column rather than inside the JSON payload.
- **Fix:** The database extractor checks both the database column and payload fields, ensuring labels display properly.

### Stale Ghost Agents Remaining Offline

- **Cause:** Calling only `setStatus('offline')` does not arm the garbage collection timestamp (`removeAt`).
- **Fix:** When sessions are deleted from SQLite or the state index, `closeMain()` and `completeSub()` are called to schedule clean removal after the grace period.

### Terminal and Messages Disabled in Docker (P2-1)

By default, Habblaud only enables the terminal and direct messaging features when it detects
that the port is not exposed on the LAN. With `HABBLAUD_BIND=0.0.0.0` (the Docker default),
those features are blocked because the port is reachable from any device on your network.

**Recommended setup: bind locally and put Nginx (or Caddy/Traefik) in front.**

```yaml
# docker-compose.yml excerpt
services:
  habblaud:
    image: node:22-alpine
    # Do NOT publish the port directly on the host LAN.
    # Let the reverse proxy handle external access.
    # ports:
    #   - "4747:4747"
    environment:
      HABBLAUD_BIND: "127.0.0.1"   # listen only on the loopback inside the container
      HABBLAUD_TRUST_PROXY: "1"    # tells Habblaud "a trusted proxy is in front, enable terminal"
      HABBLAUD_ALLOWED_HOSTS: "habblaud.yourdomain.local"
```

Then configure your reverse proxy (running on the host or in another container on the same
Docker network) to forward requests from `habblaud.yourdomain.local` to `http://habblaud:4747`.

> **Important:** Only set `HABBLAUD_TRUST_PROXY=1` when the Habblaud port is not directly
> reachable from outside the host. If you expose the port with `ports: ["4747:4747"]` and also
> set `HABBLAUD_TRUST_PROXY=1`, the terminal and messages will be accessible to anyone on your
> network who can reach the container port.

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
