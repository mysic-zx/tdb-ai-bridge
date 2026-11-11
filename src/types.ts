/**
 * 协议类型，与听读宝 AI Bridge 的 HTTP 接口一一对应。
 * 这是协议的唯一类型来源，CLI 和 MCP 都从这里引用。
 */

export interface Capabilities {
  app: string;
  version: string;
  apiVersion: number;
  abilities: string[];
  limits: {
    maxRepeatsPerRequest: number;
    maxConcurrentTasks: number;
  };
}

export type FileKind = "audio" | "video" | "folder";

export interface FileItem {
  fileId: string;
  name: string;
  path: string;
  duration: number;
  type: FileKind;
  hasLrc: boolean;
  repeatCount: number;
  size: number;
}

export interface FileListResponse {
  folder: string;
  items: FileItem[];
}

export interface RepeatItem {
  repeatId?: string;
  index?: number;
  start: number;
  end: number;
  text?: string;
  translation?: string;
}

export interface RepeatsResponse {
  fileId: string;
  name: string;
  duration: number;
  items: RepeatItem[];
}

export interface RepeatInput {
  start: number;
  end: number;
  text?: string;
  translation?: string;
}

export type WriteMode = "replace" | "append";

export interface WriteRepeatsRequest {
  mode: WriteMode;
  items: RepeatInput[];
}

export interface WriteRepeatsResponse {
  fileId: string;
  mode: WriteMode;
  written: number;
  total: number;
}

export type Quality = "high" | "medium" | "low";

export interface MakeRequest {
  fileId: string;
  repeatCount?: number;
  /** 秒数字符串（如 "1"、"1.5"）或 "auto" */
  interval?: string;
  rate?: number;
  quality?: Quality;
  outputName?: string;
}

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type TaskStage =
  | "preparing"
  | "generating_segments"
  | "merging"
  | "writing_lrc"
  | "done";

export interface TaskOutput {
  fileName: string;
  audioPath: string;
  lrcPath?: string;
  duration: number;
}

export interface TaskError {
  code: string;
  message: string;
}

export interface Task {
  taskId: string;
  type: "make_audio";
  fileId: string;
  status: TaskStatus;
  stage: TaskStage;
  progress: number;
  createdAt: number;
  finishedAt: number | null;
  output: TaskOutput | null;
  error: TaskError | null;
}

export interface MakeResponse {
  taskId: string;
  status: TaskStatus;
}

export interface CancelResponse {
  taskId: string;
  status: TaskStatus;
}

export interface ApiErrorBody {
  error: TaskError;
}
