# Outline MCP Server

This is an MCP (Model Context Protocol) server for the Outline knowledge base.
It exposes Outline's API as MCP tools so clients can read and manage data in Outline.

- Outline website: https://www.getoutline.com/
- Outline GitHub: https://github.com/outline/outline

## What it does

- Provides MCP tools generated from the Outline OpenAPI spec.
- Supports Streamable HTTP (stateless JSON) and stdio transport.
- Uses `Authorization` and `X-Server-Url` headers for HTTP requests.

## Requirements

- Node.js
- An Outline API key

## Run

Build:

```bash
npm run build
```

Start:

```bash
node dist/index.js
```

## CLI flags

- `--stdio` (default when `MCP_PORT` is not set)
- `--http`
- `--port <number>` (HTTP only)
- `-h`, `--help`

Examples:

```bash
npx @obimadu/outline-mcp --stdio
npx @obimadu/outline-mcp --http --port 3000
```

## Configuration

HTTP transport expects:

- `Authorization: Bearer <OUTLINE_API_KEY>`
- `X-Server-Url: https://your-outline-instance`

For stdio, set:

- `OUTLINE_API_KEY`
- `OUTLINE_BASE_URL`
