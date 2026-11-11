import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TdbConfig {
  /** 形如 192.168.1.23:8765，也可以带 http:// 前缀 */
  host: string;
  token: string;
  /** 单次请求超时，毫秒 */
  timeout: number;
  /** 轮询任务的间隔，毫秒 */
  pollInterval: number;
}

const DEFAULTS: TdbConfig = {
  host: "",
  token: "",
  timeout: 10000,
  pollInterval: 5000,
};

export function configPath(): string {
  return join(homedir(), ".tdb", "config.json");
}

function readConfigFile(): Partial<TdbConfig> {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<TdbConfig>;
  } catch {
    throw new Error(`${path} 不是合法的 JSON，直接删掉重配即可`);
  }
}

function pickNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 优先级：环境变量 > ~/.tdb/config.json > 默认值。
 * host 和 token 没有默认值，缺失时由调用方给出明确提示。
 */
export function loadConfig(): TdbConfig {
  const file = readConfigFile();
  return {
    host: process.env.TDB_HOST ?? file.host ?? DEFAULTS.host,
    token: process.env.TDB_TOKEN ?? file.token ?? DEFAULTS.token,
    timeout: pickNumber(process.env.TDB_TIMEOUT, file.timeout ?? DEFAULTS.timeout),
    pollInterval: pickNumber(process.env.TDB_POLL_INTERVAL, file.pollInterval ?? DEFAULTS.pollInterval),
  };
}

export function saveConfig(patch: Partial<TdbConfig>): TdbConfig {
  const merged: TdbConfig = { ...DEFAULTS, ...readConfigFile(), ...patch };
  const dir = join(homedir(), ".tdb");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

/**
 * 解析 App 设置页二维码里的配对串。
 * 支持 tdb://pair?host=..&port=..&token=.. 和 http://ip:port 两种形式。
 */
export function parsePairUrl(raw: string): Pick<TdbConfig, "host" | "token"> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("配对串格式不对，应该形如 tdb://pair?host=192.168.1.23&port=8765&token=xxx");
  }

  if (url.protocol === "tdb:") {
    const host = url.searchParams.get("host");
    const port = url.searchParams.get("port") ?? "8765";
    const token = url.searchParams.get("token");
    if (!host || !token) {
      throw new Error("配对串缺少 host 或 token");
    }
    return { host: `${host}:${port}`, token };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    const token = url.searchParams.get("token") ?? "";
    return { host: `${url.hostname}:${url.port || "8765"}`, token };
  }

  throw new Error(`不认识的配对串协议：${url.protocol}`);
}
