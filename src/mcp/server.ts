import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TdbClient } from "../client/tdbClient.js";
import { loadConfig } from "../config.js";
import { VERSION } from "../version.js";
import { registerTools } from "./tools.js";

/**
 * MCP 服务端入口。配置在进程启动时读一次，
 * Claude Code 里用 --env 传的那组变量就靠这一步生效。
 */
export function buildServer(client: TdbClient = new TdbClient(loadConfig())): McpServer {
  const server = new McpServer({ name: "tdb-ai-bridge", version: VERSION });
  registerTools(server, client);
  return server;
}
