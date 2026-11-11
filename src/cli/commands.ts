import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { TdbApiError, TdbClient, type DownloadedOutput } from "../client/tdbClient.js";
import { configPath, loadConfig, parsePairUrl, saveConfig, type TdbConfig } from "../config.js";
import { runPair } from "./pair.js";
import type { FileListResponse, MakeRequest, Quality, RepeatsResponse, RepeatInput, Task, WriteMode } from "../types.js";
import { VERSION } from "../version.js";
import {
  STATUS_LABEL,
  formatDuration,
  formatTable,
  formatTaskLine,
  formatTimecode,
  maskToken,
} from "./format.js";

/** 参数用法错误，跟接口错误分开，退出码也不同。 */
class UsageError extends Error {}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, true);
    }
  }

  return { positional, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} 后面缺少数值`);
  return value;
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} 要是数字，收到 ${raw}`);
  return value;
}

function requireFileId(positional: string[]): string {
  const fileId = positional[0];
  if (!fileId) throw new UsageError("缺少 fileId，可以先用 tdb files 查");
  return fileId;
}

function helpText(): string {
  return `听读宝 AI Bridge ${VERSION}

用法: tdb <命令> [参数]

命令:
  ping                          检查设备地址和令牌是否可用
  pair [--ip 本机IP]            显示二维码，听读宝扫码自动完成配对
  files [--folder 路径] [--keyword 关键词] [--recursive] [--json]
                                列出音频文件
  upload <本地文件> [--json]    把电脑上的音频传到听读宝（≤200MB）
  delete <fileId> [--yes] [--json]
                                删除听读宝里的音频文件，危险操作
  repeats <fileId> [--json]     读取复读点
  set-repeats <fileId> --file 文件.json [--mode replace|append] [--json]
                                批量写入复读点
  make <fileId> [选项]          触发听力文件合成
  task <taskId> [--json]        查看任务状态
  wait <taskId> [--json]        轮询直到任务结束
  download <taskId> [--kind audio|lrc] [--out 路径] [--json]
                                把合成产物下载到电脑
  cancel <taskId>               取消任务
  config show|set|from-url      管理连接配置
  mcp                           以 MCP 服务端运行，给 Claude/Cursor 调用

make 选项:
  --count 2         每句重复次数（不含原句）
  --interval auto   间隔秒数或 auto
  --rate 0.9        语速，0.5 ~ 2.0
  --quality high    high | medium | low
  --name 文件名     输出文件名
  --wait            提交后等合成完成
  --download 目录   合成完自动把音频和歌词下载到该目录（需配合 --wait）
  --json            JSON 输出

配置优先级: 环境变量 TDB_HOST / TDB_TOKEN > ${configPath()}
`;
}

function reportError(error: unknown): number {
  if (error instanceof UsageError) {
    console.error(error.message);
    return 2;
  }
  if (error instanceof TdbApiError) {
    console.error(`错误 [${error.code}] ${error.message}`);
    const details = error.details as { taskId?: unknown } | undefined;
    if (typeof details?.taskId === "string") {
      console.error(`当前有任务在跑: ${details.taskId}，可以 tdb wait 它或 tdb cancel 它`);
    }
    return 1;
  }
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
}

function printFiles(result: FileListResponse): void {
  console.log(`文件夹 ${result.folder || "/"}，共 ${result.items.length} 个文件`);
  if (result.items.length === 0) {
    console.log("（空）");
    return;
  }
  console.log("");
  console.log(
    formatTable(
      ["fileId", "名称", "时长", "复读", "歌词"],
      result.items.map((item) => [
        item.fileId,
        item.name,
        formatDuration(item.duration),
        String(item.repeatCount),
        item.hasLrc ? "有" : "-",
      ]),
    ),
  );
}

function printRepeats(result: RepeatsResponse): void {
  console.log(`${result.name}  时长 ${formatDuration(result.duration)}  共 ${result.items.length} 条复读点`);
  if (result.items.length === 0) {
    console.log("（空）");
    return;
  }
  console.log("");
  console.log(
    formatTable(
      ["#", "起始", "结束", "原文", "翻译"],
      result.items.map((item, index) => [
        String(item.index ?? index + 1),
        formatTimecode(item.start),
        formatTimecode(item.end),
        item.text ?? "",
        item.translation ?? "",
      ]),
    ),
  );
}

function parseRepeatsPayload(raw: unknown, modeFlag?: string): { mode: WriteMode; items: RepeatInput[] } {
  const body = Array.isArray(raw) ? { items: raw } : (raw as { mode?: unknown; items?: unknown } | null);
  if (!body || typeof body !== "object") {
    throw new UsageError("复读点文件应该是一个数组，或者带 items 数组的对象");
  }

  const mode = (modeFlag ?? body.mode ?? "replace") as WriteMode;
  if (mode !== "replace" && mode !== "append") {
    throw new UsageError(`mode 只能是 replace 或 append，收到 ${String(mode)}`);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new UsageError("复读点文件里没有 items");
  }

  const items = body.items.map((entry, index) => {
    const row = entry as Record<string, unknown>;
    if (typeof row.start !== "number" || typeof row.end !== "number") {
      throw new UsageError(`第 ${index + 1} 条缺少数值型的 start / end`);
    }
    return {
      start: row.start,
      end: row.end,
      ...(typeof row.text === "string" ? { text: row.text } : {}),
      ...(typeof row.translation === "string" ? { translation: row.translation } : {}),
    };
  });

  return { mode, items };
}

async function runPing(json: boolean): Promise<number> {
  const capabilities = await new TdbClient(loadConfig()).capabilities();
  if (json) {
    console.log(JSON.stringify(capabilities, null, 2));
    return 0;
  }
  console.log(`${capabilities.app} ${capabilities.version}`);
  console.log(`接口版本 ${capabilities.apiVersion}`);
  console.log(`能力 ${capabilities.abilities.join(", ") || "(无)"}`);
  console.log(
    `限制 单次最多 ${capabilities.limits.maxRepeatsPerRequest} 条复读点，同时 ${capabilities.limits.maxConcurrentTasks} 个合成任务`,
  );
  return 0;
}

async function runFiles(flags: Map<string, string | true>, json: boolean): Promise<number> {
  const client = new TdbClient(loadConfig());
  const result = await client.listFiles({
    folder: stringFlag(flags, "folder"),
    keyword: stringFlag(flags, "keyword"),
    recursive: flags.has("recursive"),
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  printFiles(result);
  return 0;
}

async function runUpload(positional: string[], json: boolean): Promise<number> {
  const localPath = positional[0];
  if (!localPath) throw new UsageError("缺少本地文件路径，例: tdb upload ~/Music/lesson.mp3");
  if (!existsSync(localPath)) throw new UsageError(`文件不存在：${localPath}`);
  const size = statSync(localPath).size;
  if (size === 0) throw new UsageError("文件是空的");

  const client = new TdbClient(loadConfig());
  if (!json) {
    console.log(`正在上传 ${localPath}（${(size / 1024 / 1024).toFixed(1)}MB），大文件需要等一会…`);
  }
  const result = await client.uploadFile(localPath);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.existed) {
    console.log(`听读宝里已有同名文件，没有重复上传：${result.name}`);
  } else {
    console.log(`上传完成：${result.name}（${(result.size / 1024 / 1024).toFixed(1)}MB）`);
  }
  console.log(`fileId: ${result.fileId}`);
  console.log(`下一步: tdb set-repeats ${result.fileId} --file repeats.json`);
  return 0;
}

/** CLI 是人直接敲的，删除必须二次确认；AI 走 --json 时也不允许跳过确认。 */
async function runDelete(positional: string[], flags: Map<string, string | true>, json: boolean): Promise<number> {
  const fileId = requireFileId(positional);
  const client = new TdbClient(loadConfig());

  if (json && !flags.has("yes")) {
    throw new UsageError("AI 不允许直接删除：先把要删的文件报给用户，征得同意后由用户手动执行这条命令");
  }
  if (!flags.has("yes")) {
    const repeats = await client.getRepeats(fileId).catch(() => null);
    const line = repeats
      ? `将删除「${repeats.name}」及其 ${repeats.items.length} 条复读点，此操作不可恢复`
      : `将删除文件 ${fileId}，此操作不可恢复`;
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question(`${line}，确认请输入 y：`);
    readline.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("已取消");
      return 1;
    }
  }

  const result = await client.deleteFile(fileId);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`已删除 ${result.fileId}`);
  return 0;
}

async function runRepeats(positional: string[], json: boolean): Promise<number> {
  const fileId = requireFileId(positional);
  const result = await new TdbClient(loadConfig()).getRepeats(fileId);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  printRepeats(result);
  return 0;
}

async function runSetRepeats(
  positional: string[],
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const fileId = requireFileId(positional);
  const file = stringFlag(flags, "file");
  if (!file) throw new UsageError("需要 --file <json> 指定复读点文件，格式见 examples/repeats.sample.json");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`读不了 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }

  const body = parseRepeatsPayload(raw, stringFlag(flags, "mode"));
  const result = await new TdbClient(loadConfig()).setRepeats(fileId, body);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`已写入 ${result.written} 条（${result.mode}），文件现在共 ${result.total} 条复读点`);
  return 0;
}

function lrcFileName(audioFileName: string): string {
  const name = basename(audioFileName);
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.lrc`;
}

async function downloadOutputs(client: TdbClient, task: Task, outDir: string): Promise<DownloadedOutput[]> {
  if (!task.output) return [];
  const audioName = basename(task.output.fileName) || `${task.taskId}.m4a`;
  const targets: Array<{ kind: "audio" | "lrc"; name: string }> = [{ kind: "audio", name: audioName }];
  if (task.output.lrcPath) {
    targets.push({ kind: "lrc", name: lrcFileName(audioName) });
  }
  const results: DownloadedOutput[] = [];
  for (const target of targets) {
    results.push(await client.downloadOutput(task.taskId, target.kind, join(outDir, target.name)));
  }
  return results;
}

function printDownloads(downloads: DownloadedOutput[]): void {
  for (const item of downloads) {
    console.log(`已保存 ${item.path}（${(item.size / 1024 / 1024).toFixed(1)}MB）`);
  }
}

async function waitTask(client: TdbClient, taskId: string, json: boolean, downloadDir?: string): Promise<number> {
  if (json) {
    const task = await client.waitForTask(taskId);
    if (downloadDir && task.status === "succeeded") {
      const downloads = await downloadOutputs(client, task, downloadDir);
      console.log(JSON.stringify({ task, downloads }, null, 2));
    } else {
      console.log(JSON.stringify(task, null, 2));
    }
    return task.status === "succeeded" ? 0 : 1;
  }

  let lastLine = "";
  const task = await client.waitForTask(taskId, {
    onProgress: (current) => {
      const line = formatTaskLine(current);
      if (line !== lastLine) {
        console.log(line);
        lastLine = line;
      }
    },
  });

  if (task.status === "succeeded" && task.output) {
    console.log(`合成完成 ${task.output.audioPath}`);
    if (task.output.lrcPath) console.log(`歌词文件 ${task.output.lrcPath}`);
    console.log(`时长 ${formatDuration(task.output.duration)}`);
    if (downloadDir) {
      printDownloads(await downloadOutputs(client, task, downloadDir));
    }
    return 0;
  }
  if (task.status === "cancelled") {
    console.log("任务已取消");
    return 1;
  }
  console.error(`合成失败 [${task.error?.code ?? "UNKNOWN"}] ${task.error?.message ?? "没有错误详情"}`);
  return 1;
}

async function runMake(positional: string[], flags: Map<string, string | true>, json: boolean): Promise<number> {
  const fileId = requireFileId(positional);
  const body: MakeRequest = { fileId };

  const count = numberFlag(flags, "count");
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 0) throw new UsageError("--count 要是 >= 0 的整数");
    body.repeatCount = count;
  }

  const interval = stringFlag(flags, "interval");
  if (interval !== undefined) body.interval = interval;

  const rate = numberFlag(flags, "rate");
  if (rate !== undefined) {
    if (rate < 0.5 || rate > 2) throw new UsageError("--rate 要在 0.5 ~ 2.0 之间");
    body.rate = rate;
  }

  const quality = stringFlag(flags, "quality");
  if (quality !== undefined) {
    if (quality !== "high" && quality !== "medium" && quality !== "low") {
      throw new UsageError("--quality 只能是 high / medium / low");
    }
    body.quality = quality as Quality;
  }

  const outputName = stringFlag(flags, "name");
  if (outputName !== undefined) body.outputName = outputName;

  const downloadDir = stringFlag(flags, "download");
  if (downloadDir !== undefined && !flags.has("wait")) {
    throw new UsageError("--download 要和 --wait 一起用，否则任务还没结束");
  }

  const client = new TdbClient(loadConfig());
  const created = await client.make(body);

  if (flags.has("wait")) {
    if (!json) console.log(`任务已创建 ${created.taskId}`);
    return await waitTask(client, created.taskId, json, downloadDir);
  }

  if (json) {
    console.log(JSON.stringify(created, null, 2));
    return 0;
  }
  console.log(`任务已创建 ${created.taskId}`);
  console.log(`等待完成 tdb wait ${created.taskId}`);
  return 0;
}

async function runTask(positional: string[], json: boolean): Promise<number> {
  const taskId = positional[0];
  if (!taskId) throw new UsageError("缺少 taskId");
  const task = await new TdbClient(loadConfig()).getTask(taskId);

  if (json) {
    console.log(JSON.stringify(task, null, 2));
    return 0;
  }

  console.log(`${task.taskId}  ${STATUS_LABEL[task.status]}  ${formatTaskLine(task)}`);
  if (task.output) {
    console.log(`输出 ${task.output.audioPath}`);
    if (task.output.lrcPath) console.log(`歌词 ${task.output.lrcPath}`);
  }
  if (task.error) console.log(`错误 [${task.error.code}] ${task.error.message}`);
  return 0;
}

async function runCancel(positional: string[], json: boolean): Promise<number> {
  const taskId = positional[0];
  if (!taskId) throw new UsageError("缺少 taskId");
  const result = await new TdbClient(loadConfig()).cancelTask(taskId);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`任务 ${result.taskId} 现在是 ${STATUS_LABEL[result.status]}`);
  return 0;
}

async function runDownload(
  positional: string[],
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const taskId = positional[0];
  if (!taskId) throw new UsageError("缺少 taskId，可以先用 tdb task <taskId> 确认合成完成");

  const kindFlag = stringFlag(flags, "kind") ?? "audio";
  if (kindFlag !== "audio" && kindFlag !== "lrc") {
    throw new UsageError("--kind 只能是 audio 或 lrc");
  }
  const kind = kindFlag as "audio" | "lrc";

  const client = new TdbClient(loadConfig());
  const task = await client.getTask(taskId);
  if (task.status !== "succeeded" || !task.output) {
    throw new UsageError(`任务 ${taskId} 还没成功（当前 ${task.status}），等它结束再来下载`);
  }
  if (kind === "lrc" && !task.output.lrcPath) {
    throw new UsageError("这个任务没有歌词文件");
  }

  const fileName = kind === "audio" ? basename(task.output.fileName) : lrcFileName(task.output.fileName);
  const outPath =
    stringFlag(flags, "out") ??
    join(process.cwd(), fileName || `${taskId}.${kind === "audio" ? "m4a" : "lrc"}`);
  const result = await client.downloadOutput(taskId, kind, outPath);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`已保存 ${result.path}（${(result.size / 1024 / 1024).toFixed(1)}MB）`);
  return 0;
}

function runConfig(positional: string[], flags: Map<string, string | true>): number {
  const action = positional[0] ?? "show";

  if (action === "show") {
    const config = loadConfig();
    console.log(`配置文件 ${configPath()}`);
    console.log(`host ${config.host || "(未设置)"}`);
    console.log(`token ${maskToken(config.token)}`);
    console.log(`timeout ${config.timeout}ms`);
    console.log(`pollInterval ${config.pollInterval}ms`);
    return 0;
  }

  if (action === "set") {
    const patch: Partial<TdbConfig> = {};
    const host = stringFlag(flags, "host");
    if (host !== undefined) patch.host = host.trim();
    const token = stringFlag(flags, "token");
    if (token !== undefined) patch.token = token.trim();
    const timeout = numberFlag(flags, "timeout");
    if (timeout !== undefined) {
      if (timeout <= 0) throw new UsageError("--timeout 要大于 0");
      patch.timeout = timeout;
    }
    const pollInterval = numberFlag(flags, "poll-interval");
    if (pollInterval !== undefined) {
      if (pollInterval <= 0) throw new UsageError("--poll-interval 要大于 0");
      patch.pollInterval = pollInterval;
    }
    if (Object.keys(patch).length === 0) {
      throw new UsageError("没有要设置的项，例: tdb config set --host 192.168.1.23:8765 --token xxx");
    }

    const saved = saveConfig(patch);
    console.log(`已保存到 ${configPath()}`);
    console.log(`host ${saved.host || "(未设置)"}`);
    console.log(`token ${maskToken(saved.token)}`);
    return 0;
  }

  if (action === "from-url") {
    const raw = positional[1];
    if (!raw) throw new UsageError('用法: tdb config from-url "tdb://pair?host=192.168.1.23&port=8765&token=xxx"');
    const pair = parsePairUrl(raw);
    const saved = saveConfig(pair);
    console.log(`已保存到 ${configPath()}`);
    console.log(`host ${saved.host}`);
    console.log(`token ${maskToken(saved.token)}`);
    console.log("下一步: tdb ping");
    return 0;
  }

  throw new UsageError(`不认识的 config 子命令：${action}，可用 show / set / from-url`);
}

export async function runCli(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift() ?? "help";
  const json = flags.has("json");

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(helpText());
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return 0;
  }

  try {
    switch (command) {
      case "ping":
        return await runPing(json);
      case "pair":
        return await runPair(flags);
      case "files":
        return await runFiles(flags, json);
      case "upload":
        return await runUpload(positional, json);
      case "delete":
        return await runDelete(positional, flags, json);
      case "repeats":
        return await runRepeats(positional, json);
      case "set-repeats":
        return await runSetRepeats(positional, flags, json);
      case "make":
        return await runMake(positional, flags, json);
      case "task":
        return await runTask(positional, json);
      case "wait": {
        const taskId = positional[0];
        if (!taskId) throw new UsageError("缺少 taskId");
        return await waitTask(new TdbClient(loadConfig()), taskId, json);
      }
      case "download":
        return await runDownload(positional, flags, json);
      case "cancel":
        return await runCancel(positional, json);
      case "config":
        return runConfig(positional, flags);
      default:
        throw new UsageError(`不认识的命令：${command}，执行 tdb --help 看全部命令`);
    }
  } catch (error) {
    return reportError(error);
  }
}
