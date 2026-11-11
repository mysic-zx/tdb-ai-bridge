import { readFileSync } from "node:fs";

/**
 * 版本号直接读 package.json，避免 CLI 帮助和 MCP 握手信息跟发布版本对不上。
 * 编译后 dist/version.js 的上一级就是包根目录。
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
