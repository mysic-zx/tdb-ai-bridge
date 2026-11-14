import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { TdbConfig } from "../config.js";
import type {
  ApiErrorBody,
  CancelResponse,
  Capabilities,
  FileListResponse,
  MakeRequest,
  MakeResponse,
  RepeatsResponse,
  Task,
  WriteRepeatsRequest,
  WriteRepeatsResponse,
} from "../types.js";

export class TdbApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** 服务端返回的原始 body，比如 409 时顺便带回来的 taskId */
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "TdbApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface WaitOptions {
  /** 轮询间隔，毫秒，默认取配置里的 pollInterval */
  pollInterval?: number;
  /** 最长等待时间，毫秒，默认 30 分钟 */
  timeout?: number;
  onProgress?: (task: Task) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UploadResult {
  fileId: string;
  name: string;
  size: number;
  existed: boolean;
  /** 落点文件夹名，空字符串表示 Documents 根目录（老版本 App 不返回这个字段） */
  folder?: string;
}

export interface DeleteResult {
  fileId: string;
  deleted: boolean;
}

export interface CreateFolderResult {
  fileId: string;
  name: string;
  path: string;
  type: "folder";
  created: boolean;
}

export interface RenameResult {
  /** 文件重命名后 md5 不变；文件夹重命名后 fileId 会变，旧 id 作废 */
  fileId: string;
  name: string;
  path: string;
  type: "audio" | "video" | "folder";
  renamed: boolean;
}

export interface DownloadedOutput {
  kind: "audio" | "lrc";
  /** 落到电脑上的路径 */
  path: string;
  size: number;
}

/** 单个上传文件的上限，App 端 limits.maxUploadFileBytes 与此一致 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export class TdbClient {
  constructor(private readonly config: TdbConfig) {}

  get baseUrl(): string {
    const raw = this.config.host.trim();
    if (!raw) {
      throw new TdbApiError(
        "NO_HOST",
        "还没有配置设备地址，先运行 tdb config set --host <ip:port>",
        0,
      );
    }
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    return `${withScheme.replace(/\/+$/, "")}/api/ai`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new TdbApiError("BAD_RESPONSE", `返回的不是 JSON：${text.slice(0, 120)}`, response.status);
        }
      }
      if (!response.ok) {
        const parsed = data as Partial<ApiErrorBody>;
        const code = parsed?.error?.code ?? `HTTP_${response.status}`;
        const message = parsed?.error?.message ?? `请求失败（HTTP ${response.status}）`;
        throw new TdbApiError(code, message, response.status, data);
      }
      return data as T;
    } catch (error) {
      if (error instanceof TdbApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TdbApiError("TIMEOUT", `请求超时（${this.config.timeout}ms），检查手机是否还在前台`, 0);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new TdbApiError("NETWORK", `连不上设备：${message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("GET", "/capabilities");
  }

  listFiles(params: { folder?: string; recursive?: boolean; keyword?: string } = {}): Promise<FileListResponse> {
    const query = new URLSearchParams();
    if (params.folder) query.set("folder", params.folder);
    if (params.recursive) query.set("recursive", "1");
    if (params.keyword) query.set("keyword", params.keyword);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<FileListResponse>("GET", `/files${suffix}`);
  }

  getRepeats(fileId: string): Promise<RepeatsResponse> {
    return this.request<RepeatsResponse>("GET", `/files/${encodeURIComponent(fileId)}/repeats`);
  }

  setRepeats(fileId: string, body: WriteRepeatsRequest): Promise<WriteRepeatsResponse> {
    return this.request<WriteRepeatsResponse>(
      "POST",
      `/files/${encodeURIComponent(fileId)}/repeats`,
      body,
    );
  }

  /**
   * 上传本地音频到听读宝。folder 可选，只能是 Documents 下已存在的一级子目录名，
   * 省略则落在 Documents 根目录。multipart 的超时放宽到 10 分钟，
   * 200MB 文件在普通 WiFi 上要传一会儿。
   */
  async uploadFile(localPath: string, folder?: string): Promise<UploadResult> {
    const stat = statSync(localPath);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new TdbApiError("INVALID_ARGUMENT", `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 200MB 上限`, 0);
    }

    // 手工拼 multipart：undici 的 FormData 在结束 boundary 后不补 CRLF，
    // 听读宝内置的 GCDWebServer 解析器会判成请求未结束，直接回 500。
    const fileName = basename(localPath);
    const boundary = `----tdb-${randomBytes(16).toString("hex")}`;
    const escapedName = fileName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const parts: Buffer[] = [];
    if (folder) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="folder"\r\n` +
            `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
            `${folder}\r\n`,
        ),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${escapedName}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      readFileSync(localPath),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    const body = Buffer.concat(parts);

    // request() 只会发 JSON，multipart 单独走一份，错误处理逻辑保持一致
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.config.timeout, 10 * 60 * 1000));
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;

    try {
      const response = await fetch(`${this.baseUrl}/files`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new TdbApiError("BAD_RESPONSE", `返回的不是 JSON：${text.slice(0, 120)}`, response.status);
        }
      }
      if (!response.ok) {
        const parsed = data as Partial<ApiErrorBody>;
        throw new TdbApiError(
          parsed?.error?.code ?? `HTTP_${response.status}`,
          parsed?.error?.message ?? `上传失败（HTTP ${response.status}）`,
          response.status,
          data,
        );
      }
      return data as UploadResult;
    } catch (error) {
      if (error instanceof TdbApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TdbApiError("TIMEOUT", "上传超时，检查手机是否还在前台", 0);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new TdbApiError("NETWORK", `连不上设备：${message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 把合成产物下载到电脑。audioPath 在 App 沙盒里，电脑上拿不到，
   * 必须走这个接口把字节拉回来。
   */
  async downloadOutput(taskId: string, kind: "audio" | "lrc", outPath: string): Promise<DownloadedOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.config.timeout, 10 * 60 * 1000));
    const headers: Record<string, string> = { Accept: "application/octet-stream" };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;

    try {
      const response = await fetch(
        `${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/output?kind=${kind}`,
        { headers, signal: controller.signal },
      );
      if (!response.ok) {
        const text = await response.text();
        let body: unknown = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = {};
        }
        const parsed = body as Partial<ApiErrorBody>;
        throw new TdbApiError(
          parsed?.error?.code ?? `HTTP_${response.status}`,
          parsed?.error?.message ?? `下载失败（HTTP ${response.status}）`,
          response.status,
          body,
        );
      }
      // 老版本 App 没有 /output 路由，会落到 GET /tasks/{id} 上返回 200 + 任务 JSON
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        throw new TdbApiError(
          "NOT_SUPPORTED",
          "设备端还不支持下载（返回的是任务 JSON），先升级听读宝",
          response.status,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes);
      return { kind, path: outPath, size: bytes.length };
    } catch (error) {
      if (error instanceof TdbApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TdbApiError("TIMEOUT", "下载超时，检查手机是否还在前台", 0);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new TdbApiError("NETWORK", `连不上设备：${message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 删除文件或文件夹。文件夹必须显式带 recursive=true，
   * 否则服务端会拒绝，防止误删整个目录。
   */
  deleteFile(fileId: string, options: { recursive?: boolean } = {}): Promise<DeleteResult> {
    const query = options.recursive ? "?recursive=1" : "";
    return this.request<DeleteResult>("DELETE", `/files/${encodeURIComponent(fileId)}${query}`);
  }

  /**
   * 在 Documents 下新建一级文件夹。名字已存在且是文件夹时返回 created=false，
   * 重复调用不会报错；同名文件已存在时报 INVALID_ARGUMENT。
   */
  createFolder(name: string): Promise<CreateFolderResult> {
    return this.request<CreateFolderResult>("POST", "/folders", { name });
  }

  /**
   * 重命名文件或文件夹，只在原目录改名，不能换目录。
   * 文件不写后缀时沿用原后缀；文件夹改名后返回新的 fileId。
   */
  renameFile(fileId: string, name: string): Promise<RenameResult> {
    return this.request<RenameResult>("POST", `/files/${encodeURIComponent(fileId)}/rename`, { name });
  }

  make(body: MakeRequest): Promise<MakeResponse> {
    return this.request<MakeResponse>("POST", "/makes", body);
  }

  getTask(taskId: string): Promise<Task> {
    return this.request<Task>("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  cancelTask(taskId: string): Promise<CancelResponse> {
    return this.request<CancelResponse>("DELETE", `/tasks/${encodeURIComponent(taskId)}`);
  }

  /**
   * 轮询直到任务结束。合成是异步的，MCP 客户端不适合自己写循环，
   * 所以 waiting 这件事交给客户端统一处理。
   */
  async waitForTask(taskId: string, options: WaitOptions = {}): Promise<Task> {
    const interval = options.pollInterval ?? this.config.pollInterval;
    const deadline = Date.now() + (options.timeout ?? 30 * 60 * 1000);

    for (;;) {
      const task = await this.getTask(taskId);
      options.onProgress?.(task);
      if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
        return task;
      }
      if (Date.now() >= deadline) {
        throw new TdbApiError("WAIT_TIMEOUT", `等任务超时，可以在 App 里看是否还在跑：${taskId}`, 0);
      }
      await sleep(interval);
    }
  }
}
