import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  Capabilities,
  FileItem,
  MakeRequest,
  RepeatItem,
  Task,
  TaskStage,
  WriteRepeatsRequest,
} from "../types.js";

export interface MockServer {
  port: number;
  close: () => Promise<void>;
}

const FOLDERS = ["", "/EnglishPod", "/BBC"];

const FILE_SEEDS: Array<Pick<FileItem, "fileId" | "name" | "path" | "duration" | "size">> = [
  {
    fileId: "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
    name: "EnglishPod_012.mp3",
    path: "/EnglishPod/EnglishPod_012.mp3",
    duration: 1832.5,
    size: 29384756,
  },
  {
    fileId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    name: "EnglishPod_013.mp3",
    path: "/EnglishPod/EnglishPod_013.mp3",
    duration: 1745.0,
    size: 27934816,
  },
  {
    fileId: "f0e1d2c3b4a5968778695a4b3c2d1e0f",
    name: "BBC_6Minute_001.mp3",
    path: "/BBC/BBC_6Minute_001.mp3",
    duration: 367.2,
    size: 5876224,
  },
  {
    fileId: "00aa11bb22cc33dd44ee55ff66778899",
    name: "BBC_6Minute_002.mp3",
    path: "/BBC/BBC_6Minute_002.mp3",
    duration: 371.8,
    size: 5949440,
  },
  {
    fileId: "abcdef0123456789abcdef0123456789",
    name: "日常口语_01.mp3",
    path: "/日常口语_01.mp3",
    duration: 602.4,
    size: 9641984,
  },
];

interface MockState {
  files: FileItem[];
  repeats: Map<string, RepeatItem[]>;
  tasks: Map<string, Task>;
  timers: Map<string, NodeJS.Timeout[]>;
}

function createState(): MockState {
  const repeats = new Map<string, RepeatItem[]>();
  const files: FileItem[] = FILE_SEEDS.map((seed, fileIndex) => {
    const items: RepeatItem[] = [];
    const step = seed.duration / 21;
    for (let i = 0; i < 20; i += 1) {
      items.push({
        repeatId: `${(fileIndex + 1).toString(16)}${(i + 1).toString(16).padStart(3, "0")}`,
        index: i + 1,
        start: Number((i * step).toFixed(2)),
        end: Number(((i + 1) * step - 0.4).toFixed(2)),
        text: `Mock sentence ${i + 1} of ${seed.name}`,
        translation: `示例翻译 ${i + 1}`,
      });
    }
    repeats.set(seed.fileId, items);
    return {
      ...seed,
      type: "audio",
      hasLrc: true,
      repeatCount: items.length,
    };
  });
  return { files, repeats, tasks: new Map(), timers: new Map() };
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { error: { code, message } });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("请求体超过 2MB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function isWriteRepeatsRequest(value: unknown): value is WriteRepeatsRequest {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<WriteRepeatsRequest>;
  if (body.mode !== "replace" && body.mode !== "append") return false;
  if (!Array.isArray(body.items)) return false;
  return body.items.every((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as unknown as Record<string, unknown>;
    return (
      typeof row.start === "number" &&
      typeof row.end === "number" &&
      row.start >= 0 &&
      row.end > row.start
    );
  });
}

function newTaskId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `t_${stamp}_${Math.random().toString(16).slice(2, 8)}`;
}

function scheduleTask(state: MockState, task: Task): void {
  const timers: NodeJS.Timeout[] = [];
  const set = (delay: number, fn: () => void) => {
    timers.push(setTimeout(fn, delay));
  };

  set(60, () => {
    if (task.status !== "pending") return;
    task.status = "running";
    task.stage = "preparing";
    task.progress = 0.1;
  });
  set(900, () => {
    if (task.status !== "running") return;
    task.stage = "generating_segments";
    task.progress = 0.35;
  });
  set(2000, () => {
    if (task.status !== "running") return;
    task.stage = "merging";
    task.progress = 0.9;
  });
  set(3000, () => {
    if (task.status !== "running") return;
    task.status = "succeeded";
    task.stage = "done";
    task.progress = 1;
    task.finishedAt = Math.floor(Date.now() / 1000);
    const baseName = task.fileId.slice(0, 6);
    task.output = {
      fileName: `${baseName}_听力.m4a`,
      audioPath: `/exports/${baseName}_听力.m4a`,
      lrcPath: `/exports/${baseName}_听力.lrc`,
      duration: 4123.8,
    };
  });
  state.timers.set(task.taskId, timers);
}

function handle(
  state: MockState,
  request: IncomingMessage,
  response: ServerResponse,
  requireToken: boolean,
): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method ?? "GET";

  if (requireToken) {
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) {
      fail(response, 401, "UNAUTHORIZED", "缺少 Authorization: Bearer <token>");
      return;
    }
  }

  if (method === "GET" && (path === "/" || path === "/health")) {
    json(response, 200, { ok: true, mock: true, hint: "接口前缀是 /api/ai" });
    return;
  }

  if (method === "GET" && path === "/api/ai/capabilities") {
    const payload: Capabilities = {
      app: "听读宝（mock）",
      version: "0.1.0",
      apiVersion: 1,
      abilities: ["files.read", "repeats.read", "repeats.write", "make.audio"],
      limits: { maxRepeatsPerRequest: 500, maxConcurrentTasks: 1 },
    };
    json(response, 200, payload);
    return;
  }

  if (method === "GET" && path === "/api/ai/files") {
    const folder = url.searchParams.get("folder") ?? "";
    const keyword = (url.searchParams.get("keyword") ?? "").toLowerCase();
    const items = state.files.filter((file) => {
      const inFolder = folder ? file.path.startsWith(`${folder}/`) : true;
      const matchKeyword = keyword ? file.name.toLowerCase().includes(keyword) : true;
      return inFolder && matchKeyword;
    });
    json(response, 200, { folder, items });
    return;
  }

  const repeatsMatch = path.match(/^\/api\/ai\/files\/([^/]+)\/repeats$/);
  if (repeatsMatch) {
    const fileId = decodeURIComponent(repeatsMatch[1]);
    const file = state.files.find((item) => item.fileId === fileId);
    if (!file) {
      fail(response, 404, "NOT_FOUND", `文件不存在：${fileId}`);
      return;
    }

    if (method === "GET") {
      json(response, 200, {
        fileId,
        name: file.name,
        duration: file.duration,
        items: state.repeats.get(fileId) ?? [],
      });
      return;
    }

    if (method === "POST") {
      void readBody(request)
        .then((body) => {
          if (!isWriteRepeatsRequest(body)) {
            fail(response, 422, "VALIDATION_FAILED", "items 里每条都要有合法的 start / end");
            return;
          }
          if (body.items.length > 500) {
            fail(response, 400, "INVALID_ARGUMENT", "一次最多写 500 条");
            return;
          }
          const existing = body.mode === "append" ? state.repeats.get(fileId) ?? [] : [];
          const baseIndex = existing.length;
          const written: RepeatItem[] = body.items.map((item, offset) => ({
            repeatId: `n${(baseIndex + offset + 1).toString(16).padStart(4, "0")}`,
            index: baseIndex + offset + 1,
            start: item.start,
            end: item.end,
            text: item.text ?? "",
            translation: item.translation ?? "",
          }));
          const next = [...existing, ...written];
          state.repeats.set(fileId, next);
          file.repeatCount = next.length;
          json(response, 200, {
            fileId,
            mode: body.mode,
            written: written.length,
            total: next.length,
          });
        })
        .catch((error: unknown) => {
          fail(response, 400, "INVALID_ARGUMENT", error instanceof Error ? error.message : "请求体不合法");
        });
      return;
    }
  }

  if (method === "POST" && path === "/api/ai/makes") {
    void readBody(request)
      .then((body) => {
        const payload = body as Partial<MakeRequest>;
        if (!payload || typeof payload.fileId !== "string") {
          fail(response, 400, "INVALID_ARGUMENT", "缺少 fileId");
          return;
        }
        const file = state.files.find((item) => item.fileId === payload.fileId);
        if (!file) {
          fail(response, 404, "NOT_FOUND", `文件不存在：${payload.fileId}`);
          return;
        }
        const running = [...state.tasks.values()].find(
          (task) => task.status === "pending" || task.status === "running",
        );
        if (running) {
          json(response, 409, {
            error: { code: "TASK_RUNNING", message: "已有合成任务在跑" },
            taskId: running.taskId,
          });
          return;
        }
        const task: Task = {
          taskId: newTaskId(),
          type: "make_audio",
          fileId: payload.fileId,
          status: "pending",
          stage: "preparing",
          progress: 0,
          createdAt: Math.floor(Date.now() / 1000),
          finishedAt: null,
          output: null,
          error: null,
        };
        state.tasks.set(task.taskId, task);
        scheduleTask(state, task);
        json(response, 202, { taskId: task.taskId, status: task.status });
      })
      .catch((error: unknown) => {
        fail(response, 400, "INVALID_ARGUMENT", error instanceof Error ? error.message : "请求体不合法");
      });
    return;
  }

  const taskMatch = path.match(/^\/api\/ai\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    const task = state.tasks.get(taskId);
    if (!task) {
      fail(response, 404, "NOT_FOUND", `任务不存在：${taskId}`);
      return;
    }
    if (method === "GET") {
      json(response, 200, task);
      return;
    }
    if (method === "DELETE") {
      for (const timer of state.timers.get(taskId) ?? []) clearTimeout(timer);
      state.timers.delete(taskId);
      if (task.status === "pending" || task.status === "running") {
        task.status = "cancelled";
        task.stage = "done";
        task.finishedAt = Math.floor(Date.now() / 1000);
      }
      json(response, 200, { taskId, status: task.status });
      return;
    }
  }

  fail(response, 404, "NOT_FOUND", `没有这个接口：${method} ${path}`);
}

/**
 * 起一个本地假服务端。没有听读宝也能把协议跑一遍，
 * CI 里所有端到端测试都打这个。
 */
export function startMockServer(
  port = 8799,
  options: { requireToken?: boolean } = {},
): Promise<MockServer> {
  const state = createState();
  const requireToken = options.requireToken ?? false;
  const server: Server = createServer((request, response) => {
    try {
      handle(state, request, response, requireToken);
    } catch (error) {
      fail(response, 500, "INTERNAL", error instanceof Error ? error.message : "mock 内部错误");
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((done) => {
            for (const timers of state.timers.values()) {
              for (const timer of timers) clearTimeout(timer);
            }
            server.close(() => done());
          }),
      });
    });
  });
}

export { FOLDERS };
