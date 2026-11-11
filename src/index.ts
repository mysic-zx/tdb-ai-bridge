#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCli } from "./cli/commands.js";
import { buildServer } from "./mcp/server.js";

/**
 * 一个入口分发两种用法：
 *   tdb ...       命令行
 *   tdb mcp       MCP 服务端（stdio），给 Claude Code / Cursor / Codex 调
 */
async function main(argv: string[]): Promise<number> {
  if (argv[0] === "mcp") {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    return 0;
  }
  return runCli(argv);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
