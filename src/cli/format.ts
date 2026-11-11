import type { Task, TaskStage, TaskStatus } from "../types.js";

/** 中文和全角符号在终端里占两格，直接 padEnd 表格会歪。 */
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

function padRight(text: string, width: number): string {
  const gap = width - textWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    rows.reduce((max, row) => Math.max(max, textWidth(row[column] ?? "")), textWidth(header)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, column) => padRight(cell, widths[column])).join("  ").trimEnd();
  return [renderRow(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(renderRow)].join("\n");
}

/** 秒数转 mm:ss，超过一小时补上小时。 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(rest).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 复读点用 mm:ss.SS，字幕习惯，精确到百分秒。 */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

export const STAGE_LABEL: Record<TaskStage, string> = {
  preparing: "准备中",
  generating_segments: "生成片段",
  merging: "合并音频",
  writing_lrc: "写入歌词",
  done: "完成",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function formatTaskLine(task: Task): string {
  const percent = `${Math.round(task.progress * 100)}%`.padStart(4);
  return `${STAGE_LABEL[task.stage] ?? task.stage} ${percent}`;
}

export function maskToken(token: string): string {
  if (!token) return "(未设置)";
  if (token.length <= 6) return `${token.slice(0, 1)}***`;
  return `${token.slice(0, 4)}***${token.slice(-2)}`;
}
