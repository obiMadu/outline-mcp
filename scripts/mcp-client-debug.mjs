import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_MCP_URL = "http://localhost:3000/mcp";

const requireValue = (value, message) => {
  if (!value) {
    throw new Error(message);
  }
  return value;
};

const parseArgs = () => {
  const [, , toolNameArg, argsJsonArg] = process.argv;
  return {
    toolName: toolNameArg ?? "outline_collections_list",
    args: argsJsonArg ? JSON.parse(argsJsonArg) : {}
  };
};

const main = async () => {
  const mcpUrl = process.env.MCP_SERVER_URL ?? DEFAULT_MCP_URL;
  const outlineApiKey = requireValue(
    process.env.OUTLINE_API_KEY,
    "OUTLINE_API_KEY is required"
  );
  const outlineBaseUrl = process.env.OUTLINE_BASE_URL ?? "https://app.getoutline.com";

  const { toolName, args } = parseArgs();

  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${outlineApiKey}`,
        "X-Server-Url": outlineBaseUrl
      }
    }
  });

  const client = new Client({
    name: "outline-mcp-debug-client",
    version: "0.1.0"
  });

  await client.connect(transport);

  const toolsResult = await client.request(
    { method: "tools/list", params: {} },
    ListToolsResultSchema
  );

  const toolNames = toolsResult.tools.map((tool) => tool.name).sort();
  console.log("Tools:", toolNames);

  console.log(`Calling ${toolName} with args:`, args);
  const result = await client.request(
    {
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args
      }
    },
    CallToolResultSchema
  );

  console.log("Tool result:");
  console.log(JSON.stringify(result, null, 2));

  await transport.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
