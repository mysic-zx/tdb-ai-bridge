import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TdbApiError, type TdbClient } from "../client/tdbClient.js";

/**
 * MCP 层只做参数转换，业务判断全在 App 端。
 * 协议改字段时，这里和 types.ts 一起改。
 */

interface TextContent {
  type: "text";
  text: string;
}

function jsonResult(payload: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(error: unknown): { isError: true; content: TextContent[] } {
  if (error instanceof TdbApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code: error.code, message: error.message }, details: error.details ?? null }, null, 2),
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code: "CLIENT_ERROR", message } }, null, 2) }],
  };
}

export function registerTools(server: McpServer, client: TdbClient): void {
  server.tool(
    "tdb_capabilities",
    "探测听读宝 AI 接口：应用版本、接口版本、能力清单和限制。连上设备后先调它确认能不能用。",
    {},
    async () => {
      try {
        return jsonResult(await client.capabilities());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_list_files",
    "列出听读宝文件库里的音频文件，返回 fileId、路径、时长、已有复读点数量。后续接口都要用 fileId。",
    {
      folder: z.string().optional().describe("相对文件夹路径，例如 /EnglishPod，不传为根目录"),
      keyword: z.string().optional().describe("按文件名模糊匹配"),
      recursive: z.boolean().optional().describe("是否递归子文件夹，默认 false"),
    },
    async ({ folder, keyword, recursive }) => {
      try {
        return jsonResult(await client.listFiles({ folder, keyword, recursive }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_upload_file",
    "把电脑上的音频文件上传到听读宝（≤200MB，常见音视频格式）。返回 fileId，可直接用于写复读点和合成。文件名同名时不覆盖，existed 为 true 表示已存在。",
    {
      path: z.string().min(1).describe("电脑上的本地文件绝对路径"),
    },
    async ({ path }) => {
      try {
        if (!existsSync(path)) {
          return errorResult(new TdbApiError("INVALID_ARGUMENT", `文件不存在：${path}`, 0));
        }
        if (statSync(path).size === 0) {
          return errorResult(new TdbApiError("INVALID_ARGUMENT", "文件是空的", 0));
        }
        return jsonResult(await client.uploadFile(path));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_delete_file",
    "删除听读宝里的音频文件（连同它的复读点和歌词），不可恢复。调用前必须先把文件名报给用户、征得用户明确同意，用户没点头就不要调这个工具。",
    {
      fileId: z.string().min(1).describe("文件 ID"),
      confirmedByUser: z.boolean().describe("用户是否已明确同意删除这条文件。必须是真实征得同意后的 true"),
    },
    async ({ fileId, confirmedByUser }) => {
      if (!confirmedByUser) {
        return errorResult(
          new TdbApiError("FORBIDDEN", "用户还没有明确同意删除。先列出文件名征求同意，再带 confirmedByUser=true 重调", 0),
        );
      }
      try {
        return jsonResult(await client.deleteFile(fileId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_get_repeats",
    "读取某个文件现有的全部复读点（按时间升序），写之前先用它看看已经有什么，避免重复生成。",
    {
      fileId: z.string().min(1).describe("文件 ID，从 tdb_list_files 拿"),
    },
    async ({ fileId }) => {
      try {
        return jsonResult(await client.getRepeats(fileId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_set_repeats",
    "批量写入复读点。replace 覆盖全部、天然幂等，重试安全；append 追加到末尾，重试会写重复。每条要求 end 大于 start，且不超过文件时长。",
    {
      fileId: z.string().min(1).describe("文件 ID"),
      mode: z
        .enum(["replace", "append"])
        .default("replace")
        .describe("replace 覆盖全部，append 追加。默认 replace"),
      items: z
        .array(
          z.object({
            start: z.number().min(0).describe("起始秒"),
            end: z.number().positive().describe("结束秒，必须大于 start"),
            text: z.string().optional().describe("句子原文"),
            translation: z.string().optional().describe("翻译"),
          }),
        )
        .min(1)
        .max(500)
        .describe("复读点，按时间升序"),
    },
    async ({ fileId, mode, items }) => {
      const invalid = items.find((item) => item.end <= item.start);
      if (invalid) {
        return errorResult(
          new TdbApiError("VALIDATION_FAILED", `有一条复读点的 end(${invalid.end}) 不大于 start(${invalid.start})`, 0),
        );
      }
      try {
        return jsonResult(await client.setRepeats(fileId, { mode, items }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_make_audio",
    "用文件的复读点合成听力音频（每句重复 N 次 + 间隔 + 语速），可选同时生成歌词。异步任务，wait 为 true 时等到结束再返回。",
    {
      fileId: z.string().min(1).describe("文件 ID"),
      repeatCount: z.number().int().min(0).max(10).optional().describe("每句重复次数，不含原句，默认 1"),
      interval: z.string().optional().describe('句间间隔秒数字符串，如 "1"、"1.5"，或 "auto"'),
      rate: z.number().min(0.5).max(2).optional().describe("语速，默认 1.0"),
      quality: z.enum(["high", "medium", "low"]).optional().describe("输出音质，默认 high"),
      outputName: z.string().optional().describe("输出文件名，非法字符会被过滤"),
      wait: z.boolean().default(true).describe("是否等合成完成再返回，默认 true"),
      timeoutSeconds: z.number().int().min(10).max(7200).default(1800).describe("wait 的最长等待秒数，默认 1800"),
    },
    async ({ fileId, repeatCount, interval, rate, quality, outputName, wait, timeoutSeconds }) => {
      try {
        const created = await client.make({ fileId, repeatCount, interval, rate, quality, outputName });
        if (!wait) return jsonResult(created);
        const task = await client.waitForTask(created.taskId, { timeout: timeoutSeconds * 1000 });
        return jsonResult(task);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_download_output",
    "把合成任务的产物下载到电脑。听读宝的产物在手机沙盒里，电脑上直接拿不到，必须用这个工具把字节拉回来。任务必须已经成功。",
    {
      taskId: z.string().min(1).describe("合成任务 ID"),
      kind: z.enum(["audio", "lrc"]).default("audio").describe("下载音频还是歌词，默认 audio"),
      outDir: z.string().min(1).describe("保存到电脑上的目录，不存在会自动创建"),
    },
    async ({ taskId, kind, outDir }) => {
      try {
        const task = await client.getTask(taskId);
        if (task.status !== "succeeded" || !task.output) {
          return errorResult(
            new TdbApiError("TASK_NOT_DONE", `任务还没成功（当前 ${task.status}），等它结束再下载`, 0),
          );
        }
        if (kind === "lrc" && !task.output.lrcPath) {
          return errorResult(new TdbApiError("NOT_FOUND", "这个任务没有歌词文件", 0));
        }
        const audioName = basename(task.output.fileName) || `${taskId}.m4a`;
        const fileName = kind === "audio" ? audioName : `${audioName.replace(/\.[^.]*$/, "")}.lrc`;
        return jsonResult(await client.downloadOutput(taskId, kind, join(outDir, fileName)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_get_task",
    "查看合成任务状态、阶段和进度。任务卡住或者想确认结果时用。",
    {
      taskId: z.string().min(1).describe("任务 ID"),
    },
    async ({ taskId }) => {
      try {
        return jsonResult(await client.getTask(taskId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "tdb_cancel_task",
    "取消还没结束的合成任务。已经完成或失败的任务不受影响。",
    {
      taskId: z.string().min(1).describe("任务 ID"),
    },
    async ({ taskId }) => {
      try {
        return jsonResult(await client.cancelTask(taskId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
