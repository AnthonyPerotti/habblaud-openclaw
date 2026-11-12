<p align="center">
  <a href="README.md">English</a> · <b>Português</b>
</p>

# Habblaud OpenClaw

Painel de escritório virtual em pixel art para agentes autônomos, sessões e fluxos de trabalho do OpenClaw.

## Visão Geral

O Habblaud OpenClaw é uma interface de monitoramento em tempo real para o runtime do OpenClaw. O sistema mapeia agentes, subagentes e sessões como personagens em um escritório interativo em pixel art. Cada sessão ativa ocupa uma mesa de trabalho, navega entre salas que representam os workspaces dos projetos e apresenta atividade em tempo real, estados de raciocínio, ferramentas acionadas, métricas de consumo de tokens e histórico de execução.

A aplicação utiliza um núcleo em Node.js puro (sem dependências de runtime externas) que transmite o estado do escritório via Server-Sent Events (SSE) para uma interface frontend em HTML5 Canvas e TypeScript.

## Arquitetura

O diagrama abaixo ilustra o fluxo de dados e os limites entre componentes:

```
+-------------------------------------------------------------+
|                      Ambiente Host                          |
|                                                             |
|  +---------------------------+                              |
|  |     Runtime OpenClaw      |                              |
|  |                           |                              |
|  |  Bancos de Dados SQLite:  |                              |
|  |  - openclaw-agent.sqlite  |                              |
|  |  - state/openclaw.sqlite  |                              |
|  |  (Tabelas: session_nodes) |                              |
|  +-------------+-------------+                              |
|                |                                            |
|                | Volume em Modo Somente Leitura             |
|                v                                            |
|  +-------------------------------------------------------+  |
|  |              Container Habblaud (Docker)              |  |
|  |                                                       |  |
|  |  +-------------------------------------------------+  |  |
|  |  | Camada de Ingestão                              |  |  |
|  |  | - Leitor SQLite (session_nodes / entry_json)    |  |  |
|  |  | - FS Watcher Recursivo (sincronização de disco) |  |  |
|  |  | - Cliente Gateway (HTTP/WebSocket opcional)    |  |  |
|  |  +------------------------+------------------------+  |  |
|  |                           |                           |  |
|  |  +------------------------v------------------------+  |  |
|  |  | Motor Principal do Escritório                  |  |  |
|  |  | - Alocação de salas e layout espacial           |  |  |
|  |  | - Máquina de estados (working, waiting, idle)   |  |  |
|  |  | - Hub de Eventos SSE (/api/stream, /snapshot)   |  |  |
|  |  +------------------------+------------------------+  |  |
|  |                           |                           |  |
|  |  +------------------------v------------------------+  |  |
|  |  | Servidor HTTP e Proteção de Borda               |  |  |
|  |  | - Proteção contra DNS Rebinding e CSRF         |  |  |
|  |  | - Streamer de Terminal e Inspeção de Sessões    |  |  |
|  |  +-------------------------------------------------+  |  |
|  +---------------------------+---------------------------+  |
+------------------------------|------------------------------+
                               | HTTP / SSE (:4747)
                               v
                     +-------------------+
                     | Navegador / NPM   |
                     | Canvas Pixel Art  |
                     +-------------------+
```

### Componentes Principais

1. Camada de Ingestão (`server/sources/openclaw/`):
   - Leitor SQLite: Acessa diretamente `openclaw-agent.sqlite` e `openclaw.sqlite` em modo somente leitura (`node:sqlite`). Suporta o esquema atual do OpenClaw (tabela `session_nodes` com payloads comprimidos ou texto em `entry_json`) e esquemas legados.
   - Observador do Sistema de Arquivos: Monitora alterações no diretório de dados do OpenClaw com isolamento de eventos de erro para prevenir travamentos por falha de permissão (`EACCES`).
   - Adaptador Gateway: Realiza consultas na API do OpenClaw Gateway (`/api/sessions`) quando configurado.

2. Motor do Escritório (`server/model/`):
   - Gerencia salas, mesas, avatares e transições de status (`working`, `waiting`, `shell`, `idle`).
   - Monitora métricas de tokens (entrada, saída, contexto), tempo de processamento e modelos de IA associados.

3. Frontend (`client/`):
   - Motor gráfico em pixel art com dimensionamento automático de salas, centralização de câmera e movimentação de personagens.
   - Painel lateral de inspeção com histórico, chamadas de ferramentas e metadados da sessão.

## Implantação

### Docker Compose (ZimaOS / Portainer / Docker CLI)

Crie ou atualize o arquivo `docker-compose.yml`:

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
      # Monta o diretório de dados do OpenClaw em modo somente leitura (:ro)
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

### Inicializar o Serviço

```bash
docker compose up -d --build
```

Acesse o painel em `http://<IP_DO_HOST>:4747` ou através do domínio configurado.

## Configuração em Proxy Reverso (Nginx Proxy Manager)

Para acessar o Habblaud através do Nginx Proxy Manager, Traefik ou Caddy:

1. Inclua seu domínio (exemplo: `habblaud.zima.local`) na variável de ambiente `HABBLAUD_ALLOWED_HOSTS`:
   ```env
   HABBLAUD_ALLOWED_HOSTS=habblaud.zima.local
   ```
2. No Nginx Proxy Manager:
   - Scheme: `http`
   - Forward Hostname / IP: `<IP_DO_ZIMAOS_OU_HOST>`
   - Forward Port: `4747`
   - Ative `Websockets Support` (necessário para o transporte de SSE e streams em tempo real).

## Variáveis de Ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `OPENCLAW_HOME` | Caminho absoluto do diretório de estado do OpenClaw | `/openclaw` (Docker) ou `~/.openclaw` |
| `OPENCLAW_GATEWAY_URL` | URL do endpoint da API Gateway do OpenClaw | Não definido |
| `OPENCLAW_GATEWAY_TOKEN` | Token Bearer para autenticação no Gateway | Não definido |
| `HABBLAUD_PORT` | Porta HTTP exposta pelo servidor | `4747` |
| `HABBLAUD_BIND` | Endereço de interface de escuta (`0.0.0.0` para todas as interfaces) | `0.0.0.0` |
| `HABBLAUD_ALLOWED_HOSTS` | Nomes de domínio permitidos contra DNS Rebinding (separados por vírgula) | `localhost` |
| `HABBLAUD_LANG` | Idioma da interface (`pt`, `en`, `es`, `fr`) | `pt` |
| `HABBLAUD_DEMO` | Ativa agentes simulados de demonstração | `0` |
| `HABBLAUD_TERMINAL` | Habilita visualização do terminal do agente | `1` |
| `HABBLAUD_WORLD` | Habilita integração comunitária com Habblaud World | `0` |

## Solução de Problemas e Operação

### Host não permitido (403 Forbidden)

Se a página exibir:
`Host não permitido: habblaud.zima.local. Abra o Habblaud por http://localhost (ou pelo IP) ou libere o nome em HABBLAUD_ALLOWED_HOSTS.`

- Causa: O Habblaud possui proteção nativa contra DNS Rebinding. Por padrão, ele aceita apenas IPs literais e `localhost`. O suporte a curinga (`*`) foi implementado no guard, mas declarar os domínios explicitamente é a melhor prática.
- Solução: Adicione `HABBLAUD_ALLOWED_HOSTS=habblaud.zima.local` no `docker-compose.yml`.

### Aviso de Terminal Indisponível

Se a gaveta do agente exibir:
`O terminal só fica disponível quando o Habblaud roda com acesso local (bind 127.0.0.1)`

- Causa: O streaming de terminal exibe conversas e comandos em tempo real. Por segurança, o sistema desativa o recurso quando `HABBLAUD_BIND` está configurado para um endereço de rede não-loopback (`0.0.0.0`).
- Solução: Para uso puramente local, configure o bind para `127.0.0.1`. Em redes de homelab com proxy reverso, acesse via encaminhamento de porta local ou restrinja o acesso via rede privada.

### Falha de Permissão (`EACCES`) no Watcher de Arquivos

- Causa: Arquivos de configuração ou backup no diretório do OpenClaw gerados por processos root (como `openclaw.json.bak-*` com permissão `600`) impedem a leitura pelo usuário do container. O evento `error` não tratado no `fs.watch` encerrava o processo Node.
- Solução: Ajuste a posse dos arquivos em `OPENCLAW_HOME` para o UID do container (`1000:1000`). O observador de arquivos agora inclui tratamento isolado de erro para evitar quedas.

### Nenhuma Sessão Encontrada (`ok: true, sessions: 0`)

- Causa: O OpenClaw armazena nós de execução e sessões na tabela `session_nodes` do SQLite, utilizando a coluna comprimida `entry_json`, e não na tabela legada `sessions`.
- Solução: O leitor SQLite foi atualizado para processar `session_nodes` e descompactar os payloads automaticamente.

## Desenvolvimento Local

### Pré-requisitos

- Node.js 22.12 ou superior
- npm 10 ou superior

### Comandos de Build e Execução

```bash
# Instalar dependências
npm ci

# Modo desenvolvimento com recarregamento rápido (HMR)
OPENCLAW_HOME=~/.openclaw npm run dev

# Checagem de tipos e testes
npm run typecheck
npm test

# Compilação para produção
npm run build

# Iniciar servidor compilado
npm start
```

## Licença

MIT
