import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import qrcodeTerminal from "qrcode-terminal";
import { loadConfig, saveConfig } from "../config.js";

/** 配对二维码的协议前缀，跟手机展示的 tdb://pair 方向相反：这个是电脑展示、手机来扫。 */
const PAIR_CHANNEL_PREFIX = "tdb://pair-channel?";

interface PairPayload {
  code?: unknown;
  app?: unknown;
  version?: unknown;
  host?: unknown;
  port?: unknown;
  token?: unknown;
}

/** 挑电脑的局域网 IPv4：192.168 优先，其次 10.，再其次 172.16~31。 */
export function localLanIp(preferred?: string): string {
  const candidates: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== "IPv4" || item.internal) continue;
      candidates.push(item.address);
    }
  }

  if (preferred) {
    const hit = candidates.find((ip) => ip === preferred.trim());
    if (hit) return hit;
    throw new Error(`本机网卡里没有 ${preferred}，可用的是：${candidates.join(", ") || "（无）"}`);
  }

  const pick = (prefix: string) => candidates.find((ip) => ip.startsWith(prefix));
  return (
    pick("192.168.") ??
    pick("10.") ??
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ??
    candidates[0] ??
    ""
  );
}

function newPairCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<PairPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((sum, buffer) => sum + buffer.length, 0) > 64 * 1024) {
      throw new Error("配对请求体超过 64KB");
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as PairPayload;
}

function printQr(text: string): void {
  qrcodeTerminal.generate(text, { small: true });
}

/**
 * 反向配对：电脑起一个一次性服务并显示二维码，听读宝扫码后把
 * 自己的地址和令牌 POST 过来，电脑端免手抄完成配置。
 */
export async function runPair(flags: Map<string, string | true>): Promise<number> {
  const ipFlag = flags.get("ip");
  const ip = localLanIp(typeof ipFlag === "string" ? ipFlag : undefined);
  if (!ip) {
    console.error("没找到本机的局域网 IPv4 地址，确认电脑连着 WiFi，或者用 --ip 手动指定");
    return 1;
  }

  const code = newPairCode();
  let resolved = false;

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "POST" || url.pathname !== "/pair") {
        // 浏览器误开这个地址时给一句人话
        sendJson(response, 404, {
          ok: false,
          hint: "这是听读宝配对通道，请在听读宝 App 里扫二维码",
        });
        return;
      }

      if (resolved) {
        sendJson(response, 409, { ok: false, error: "已经配对过了，重新运行 tdb pair 再配" });
        return;
      }

      let payload: PairPayload;
      try {
        payload = await readJson(request);
      } catch {
        sendJson(response, 400, { ok: false, error: "请求体不是合法 JSON" });
        return;
      }

      if (payload.code !== code) {
        sendJson(response, 403, { ok: false, error: "配对码不对" });
        return;
      }
      if (typeof payload.host !== "string" || typeof payload.token !== "string" || !payload.host || !payload.token) {
        sendJson(response, 422, { ok: false, error: "缺少手机端 host 或 token" });
        return;
      }

      resolved = true;
      const port = typeof payload.port === "string" || typeof payload.port === "number" ? String(payload.port) : "8765";
      saveConfig({ host: `${payload.host}:${port}`, token: payload.token });
      sendJson(response, 200, { ok: true, app: payload.app ?? "听读宝" });

      const app = typeof payload.app === "string" && payload.app ? payload.app : "听读宝";
      console.log(`\n收到 ${app} 的配对信息：${payload.host}:${port}`);
      console.log("正在验证连接…");
      const { TdbClient } = await import("../client/tdbClient.js");
      try {
        const client = new TdbClient({ ...loadConfig(), timeout: 8000 });
        const capabilities = await client.capabilities();
        console.log(`配对成功：${capabilities.app} ${capabilities.version}，接口版本 ${capabilities.apiVersion}`);
        console.log("下一步：tdb files");
      } catch (error) {
        console.error(`配置已保存，但验证连接失败：${error instanceof Error ? error.message : String(error)}`);
        console.error("检查手机是否停在 AI 开放接口页面、是否同一 WiFi，然后手动跑 tdb ping");
      }
      server.close();
      process.exitCode = 0;
    })().catch((error: unknown) => {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "配对服务内部错误" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    console.error("配对服务端口分配失败");
    return 1;
  }

  const qrText = `${PAIR_CHANNEL_PREFIX}host=${ip}&port=${port}&code=${code}`;
  console.log("用听读宝扫这个二维码（手机端：设置 → 实验室 → AI 开放接口 → 扫描电脑二维码）：\n");
  printQr(qrText);
  console.log(`\n二维码内容: ${qrText}`);
  console.log(`扫不了码也没关系，手机上点「复制配对串」，然后电脑执行：`);
  console.log(`  tdb config from-url "手机的配对串"`);
  console.log("\n等待扫码中，3 分钟内有效，Ctrl+C 退出…");

  const timeout = setTimeout(() => {
    if (!resolved) {
      console.error("\n等待超时，没有收到扫码。确认手机和电脑在同一 WiFi 后重试。");
    }
    server.close();
  }, 3 * 60 * 1000);

  return await new Promise<number>((resolve) => {
    server.on("close", () => {
      clearTimeout(timeout);
      resolve(resolved ? 0 : 1);
    });
  });
}
