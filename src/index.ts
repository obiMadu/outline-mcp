#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { outlineTools } from "./generated/outlineTools.js";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://app.getoutline.com/api";
const DEFAULT_PORT = 3000;

type CliOptions = {
  transportMode?: "http" | "stdio";
  port?: number;
  showHelp?: boolean;
};

const getHelpText = (): string =>
  [
    "Outline MCP Server",
    "",
    "Usage:",
    "  outline-mcp [--stdio] [--http] [--port <number>]",
    "",
    "Options:",
    "  --stdio        Run with stdio transport (default when MCP_PORT is not set)",
    "  --http         Run with Streamable HTTP transport",
    "  --port <n>     Port for HTTP mode (0 = random)",
    "  -h, --help     Show this help message",
    "",
    "Environment:",
    "  MCP_TRANSPORT  Overrides transport mode (http or stdio)",
    "  MCP_PORT       Port for HTTP mode",
    "  OUTLINE_API_KEY",
    "  OUTLINE_BASE_URL",
    ""
  ].join("\n");

const parsePort = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port value: ${value}`);
  }
  return parsed;
};

const parseCliOptions = (argv: string[]): CliOptions => {
  const options: CliOptions = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--http") {
      options.transportMode = "http";
      continue;
    }
    if (arg === "--stdio") {
      options.transportMode = "stdio";
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.showHelp = true;
      continue;
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--port requires a value");
      }
      options.port = parsePort(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length);
      if (!value) {
        throw new Error("--port requires a value");
      }
      options.port = parsePort(value);
      continue;
    }
  }
  return options;
};

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const callOutline = async (
  baseUrl: string,
  apiKey: string,
  methodName: string,
  payload: Record<string, unknown>
): Promise<unknown> => {
  console.log(`Outline API request: ${methodName}`);
  const url = new URL(methodName, normalizeBaseUrl(baseUrl));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    redirect: "manual"
  });

  if (response.status === 302) {
    return {
      ok: true,
      status: response.status,
      location: response.headers.get("location")
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const errorMessage =
      typeof body === "object" && body && "error" in body
        ? (body as { error: string }).error
        : `Request failed with status ${response.status}`;

    let guidance = "";
    if (response.status === 401 || response.status === 403) {
      guidance =
        " Check OUTLINE_API_KEY and make sure it has the required scopes.";
    } else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      guidance = retryAfter
        ? ` Retry after ${retryAfter} seconds.`
        : " Slow down requests and retry later.";
    } else if (response.status === 400) {
      guidance = " Validate your request payload against the tool schema.";
    }

    const fullMessage = `Outline API error: ${errorMessage}.${guidance}`;
    console.error(fullMessage);
    throw new Error(fullMessage);
  }

  return body;
};

const normalizeHeaderValue = (
  value: string | string[] | undefined
): string | undefined => {
  if (!value) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
};

const getHeaderValue = (
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | undefined => {
  const direct = headers[key];
  if (direct) {
    return normalizeHeaderValue(direct);
  }
  const lower = headers[key.toLowerCase()];
  if (lower) {
    return normalizeHeaderValue(lower);
  }
  const match = Object.entries(headers).find(
    ([headerKey]) => headerKey.toLowerCase() === key.toLowerCase()
  );
  return match ? normalizeHeaderValue(match[1]) : undefined;
};

const extractApiKey = (authorization: string | undefined): string | undefined => {
  if (!authorization) {
    return undefined;
  }
  const trimmed = authorization.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
};

const normalizeBaseUrlFromHeader = (serverUrl: string): string => {
  const trimmed = serverUrl.trim();
  if (!trimmed) {
    throw new Error("X-Server-Url header is empty");
  }

  const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (normalized.endsWith("/api")) {
    return normalized;
  }

  return `${normalized}/api`;
};

const resolveRequestConfig = (
  transportMode: string,
  envBaseUrl: string | undefined,
  envApiKey: string | undefined,
  headers: Record<string, string | string[] | undefined>
): { baseUrl: string; apiKey: string } => {
  if (transportMode === "stdio") {
    if (!envApiKey) {
      throw new Error("OUTLINE_API_KEY is required for stdio mode");
    }
    return { baseUrl: envBaseUrl ?? DEFAULT_BASE_URL, apiKey: envApiKey };
  }

  const serverUrlHeader = getHeaderValue(headers, "x-server-url");
  const authorizationHeader = getHeaderValue(headers, "authorization");
  const apiKey = extractApiKey(authorizationHeader);

  if (!apiKey) {
    throw new Error("Missing Authorization header for Outline API key");
  }
  if (!serverUrlHeader) {
    const fallbackBaseUrl = envBaseUrl ?? DEFAULT_BASE_URL;
    return { baseUrl: fallbackBaseUrl, apiKey };
  }

  return { baseUrl: normalizeBaseUrlFromHeader(serverUrlHeader), apiKey };
};

const registerTools = (
  server: McpServer,
  transportMode: string,
  envBaseUrl: string | undefined,
  envApiKey: string | undefined
): void => {
  for (const tool of outlineTools) {
    const outputSchema = tool.outputSchema;
    const inputSchema = tool.inputSchema ?? z.any();

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        outputSchema,
        annotations: tool.annotations
      },
      async (
        args: unknown,
        extra: { requestInfo?: { headers: Record<string, string | string[] | undefined> } }
      ) => {
        const payload =
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {};
        const headers = extra.requestInfo?.headers ?? {};
        const { baseUrl, apiKey } = resolveRequestConfig(
          transportMode,
          envBaseUrl,
          envApiKey,
          headers
        );

        console.log("Outline tool request", {
          tool: tool.name,
          method: tool.methodName,
          payload
        });

        const response = await callOutline(baseUrl, apiKey, tool.methodName, payload);

        const structuredContent =
          response && typeof response === "object"
            ? (response as Record<string, unknown>)
            : { value: response };

        console.log("Outline tool response", {
          tool: tool.name,
          method: tool.methodName,
          response
        });

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          structuredContent
        };
      }
    );
  }
};

const main = async (): Promise<void> => {
  const cliOptions = parseCliOptions(process.argv);
  if (cliOptions.showHelp) {
    console.log(getHelpText());
    return;
  }
  const envApiKey = process.env.OUTLINE_API_KEY;
  const envBaseUrl = process.env.OUTLINE_BASE_URL;
  const serverName = "outline";
  const serverVersion = "0.1.0";

  const server = new McpServer({
    name: serverName,
    version: serverVersion
  });

  const transportMode =
    cliOptions.transportMode ??
    process.env.MCP_TRANSPORT ??
    (process.env.MCP_PORT || cliOptions.port ? "http" : "stdio");
  registerTools(server, transportMode, envBaseUrl, envApiKey);

  server.registerResource(
    "outline-config",
    "outline://config",
    {
      title: "Outline MCP Configuration",
      description: "Current Outline API base URL and transport mode.",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            baseUrl: envBaseUrl ?? DEFAULT_BASE_URL,
            transport: transportMode,
            authHeader: "Authorization",
            baseUrlHeader: "X-Server-Url"
          })
        }
      ]
    })
  );

  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("MCP server running in stdio mode");
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  await server.connect(transport);

  const envPortValue = process.env.MCP_PORT;
  const envPort = envPortValue ? parsePort(envPortValue) : undefined;
  const port = cliOptions.port ?? envPort ?? 0;

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    console.log(`MCP request: ${req.method ?? "UNKNOWN"} ${req.url}`);

    let parsedBody: unknown;
    if (req.method === "POST") {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const contentType = req.headers["content-type"] ?? "";
      if (rawBody && contentType.includes("application/json")) {
        parsedBody = JSON.parse(rawBody);
      }
    }

    try {
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    }
  });

  httpServer.listen(port, "0.0.0.0", () => {
    const addressInfo = httpServer.address();
    const resolvedPort =
      addressInfo && typeof addressInfo === "object" ? addressInfo.port : port;
    console.log(`MCP server listening on http://0.0.0.0:${resolvedPort}/mcp`);
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
