# Habblaud OpenClaw

Escritório virtual em pixel art para agentes autônomos e sessões do OpenClaw.

## Visão Geral

O Habblaud conecta-se ao runtime do OpenClaw, monitorando sessões ativas, estados dos agentes, consumo de tokens e delegações de modelos em tempo real. Cada sessão do OpenClaw é exibida como um personagem trabalhando em sua mesa, circulando pelo escritório ou colaborando com agentes superiores.

O servidor opera sem dependências de runtime externas, utilizando módulos nativos do Node.js. A ingestão de dados lê diretamente os bancos SQLite e arquivos de estado do OpenClaw montados em modo somente leitura, com suporte opcional à API do Gateway do OpenClaw.

## Arquitetura

1. Motor Principal: Mantém a máquina de estados do escritório virtual, alocação de salas e transmissão via Server-Sent Events (SSE).
2. Camada de Ingestão:
   - Leitor SQLite: Consulta periodicamente os bancos de agentes do OpenClaw (`openclaw-agent.sqlite`, `openclaw.sqlite`) em modo somente leitura.
   - Observador de Arquivos: Reage a alterações no diretório de estado do OpenClaw.
   - Adaptador de Gateway (Opcional): Consulta o endpoint HTTP/WebSocket do Gateway do OpenClaw quando configurado.
3. Interface: Canvas e interface em pixel art desenvolvidos em TypeScript e compilados com Vite.

## Implantação no ZimaOS / Docker

Para rodar o Habblaud junto ao OpenClaw no ZimaOS:

### 1. Configurar docker-compose.yml

Garanta que o volume aponte para a pasta de dados do OpenClaw no host (por exemplo, `/DATA/AppData/openclaw` ou `~/.openclaw`):

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

### 2. Iniciar o Serviço

```bash
docker compose up -d --build
```

Acesse o painel em `http://<IP_DO_ZIMAOS>:4747`.

## Desenvolvimento Local

### Requisitos

- Node.js 22.12 ou superior
- npm

### Compilação e Execução

```bash
# Instalar dependências
npm ci

# Compilar cliente e servidor
npm run build

# Iniciar servidor de produção
npm start
```

Para desenvolvimento com recarregamento em tempo real:

```bash
OPENCLAW_HOME=~/.openclaw npm run dev
```

## Variáveis de Ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `OPENCLAW_HOME` | Caminho do diretório de estado do OpenClaw (`agents/`, `state/`) | `/openclaw` (Docker) ou `~/.openclaw` (host) |
| `OPENCLAW_GATEWAY_URL` | URL opcional para a API do Gateway OpenClaw | Não definido |
| `OPENCLAW_GATEWAY_TOKEN` | Token de autenticação Bearer para o Gateway | Não definido |
| `HABBLAUD_PORT` | Porta HTTP exposta pelo servidor | `4747` |
| `HABBLAUD_BIND` | Endereço de interface de escuta | `0.0.0.0` |
| `HABBLAUD_LANG` | Idioma da interface (`pt`, `en`, `es`, `fr`) | `pt` |
| `HABBLAUD_DEMO` | Ativa agentes simulados de demonstração | `0` |

## Licença

MIT
