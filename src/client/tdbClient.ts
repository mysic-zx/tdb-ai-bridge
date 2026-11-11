import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
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
}

export interface DeleteResult {
  fileId: string;
  deleted: boolean;
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
   * 上传本地音频到听读宝。multipart 的超时放宽到 10 分钟，
   * 200MB 文件在普通 WiFi 上要传一会儿。
   */
  async uploadFile(localPath: string): Promise<UploadResult> {
    const stat = statSync(localPath);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new TdbApiError("INVALID_ARGUMENT", `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 200MB 上限`, 0);
    }

    const form = new FormData();
    const blob = new Blob([readFileSync(localPath)]);
    form.append("file", blob, basename(localPath));

    // request() 只会发 JSON，multipart 单独走一份，错误处理逻辑保持一致
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.config.timeout, 10 * 60 * 1000));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;

    try {
      const response = await fetch(`${this.baseUrl}/files`, {
        method: "POST",
        headers,
        body: form,
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

  deleteFile(fileId: string): Promise<DeleteResult> {
    return this.request<DeleteResult>("DELETE", `/files/${encodeURIComponent(fileId)}`);
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
