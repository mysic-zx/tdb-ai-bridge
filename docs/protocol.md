# 听读宝 AI 接口协议

> 版本 1 · 2026-11-11 · 这份文档是 `tdb-ai-bridge` 唯一依赖的外部约定

听读宝 App 里跑一个局域网 HTTP 服务，外部 AI 通过它读文件、写复读点、触发听力合成。所有请求都在局域网内完成，音频不上云。

## 连接

- Base URL：`http://<iPhone-IP>:<port>/api/ai`
- 请求头：

```
Authorization: Bearer <token>
Content-Type: application/json
```

也接受 `X-TDB-Token: <token>`。

`port` 和 `token` 在 App 的「设置 → 实验室 → AI 开放接口」页面里给出，也可以扫页面上的二维码拿到配对串：

```
tdb://pair?host=192.168.1.23&port=8765&token=xxx
```

## 通用错误

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "文件不存在"
  }
}
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | 参数缺失或非法 |
| 401 | `UNAUTHORIZED` | token 错误或缺失 |
| 403 | `FORBIDDEN` | 非局域网来源 |
| 404 | `NOT_FOUND` | 文件或任务不存在 |
| 409 | `TASK_RUNNING` | 已有合成任务在跑 |
| 409 | `TASK_NOT_DONE` | 任务失败或已取消，没有可用产物 |
| 422 | `VALIDATION_FAILED` | 复读点时间非法（end <= start） |
| 500 | `INTERNAL` | 未预期异常 |

## GET /capabilities

确认连上了、能做什么。参数没有。

```json
{
  "app": "听读宝",
  "version": "3.8.2",
  "apiVersion": 1,
  "abilities": ["files.read", "files.upload", "files.rename", "files.delete", "files.mkdir", "repeats.read", "repeats.write", "make.audio", "make.download"],
  "limits": {
    "maxRepeatsPerRequest": 500,
    "maxConcurrentTasks": 1,
    "maxUploadFileBytes": 209715200
  }
}
```

## GET /files

查文件库。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `folder` | string | 否 | 相对文件夹路径，不传为根目录 |
| `recursive` | bool | 否 | 默认 false |
| `keyword` | string | 否 | 按文件名模糊匹配 |

```json
{
  "folder": "",
  "items": [
    {
      "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
      "name": "EnglishPod_012.mp3",
      "path": "/EnglishPod/EnglishPod_012.mp3",
      "duration": 1832.5,
      "type": "audio",
      "hasLrc": true,
      "repeatCount": 128,
      "size": 29384756
    }
  ]
}
```

`repeatCount` 是已有的复读点数量。写之前先看这个值，能避免重复生成。

## POST /files

把电脑上的音频传到听读宝。`multipart/form-data`，文件字段 `file`，可选文本字段 `folder`。

限制：常见音视频格式（mp3 / m4a / aac / wav / flac / ape / ogg / wma / opus / mp4 / m4v / mov / mkv / avi / webm），单文件 ≤ `limits.maxUploadFileBytes`（当前 200MB）。

不传 `folder` 时落到 App 的 Documents 根目录。传了 `folder` 时只能是 Documents 下**已存在的一级子目录名**：不能带 `/`、不能是 `.` 或 `..`、不能是隐藏目录。目录不存在返回 `NOT_FOUND`，可以先调 `POST /folders` 建好再传。

文件名已存在时不覆盖，直接返回已有文件的信息，重试安全。

响应 `201`（新文件）或 `200`（已存在）：

```json
{
  "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
  "name": "lesson.mp3",
  "size": 29384756,
  "existed": false,
  "folder": "听力"
}
```

`folder` 是实际落点文件夹名，根目录时为空字符串。

`fileId` 就是该文件的 MD5，后续接口都用它。

## POST /folders

在 Documents 下新建一级文件夹。

```json
{ "name": "听力" }
```

规则：

- 只能在 Documents 根下建，不支持嵌套（和上传的 `folder` 限制一致）。
- 名字不能带 `/`、`\`、`:`，不能以 `.` 开头，不能是 `.` 或 `..`。
- 不能和系统目录重名（`Inbox` 以及 App 隐藏的转换/转写目录），会返回 `INVALID_ARGUMENT`。
- 同名文件夹已存在时返回 `created: false`，可重复调用；同名是文件则返回 `INVALID_ARGUMENT`。

响应 `201`（新建）或 `200`（已存在）：

```json
{
  "fileId": "dir_5d41402abc4b2a76b9719d911017c592",
  "name": "听力",
  "path": "/听力",
  "type": "folder",
  "created": true
}
```

## DELETE /files/{fileId}

删除一个音频/视频文件，连同它的复读点和歌词一起清掉。**不可恢复**，协议约定 AI 必须先征得用户同意才能调。

删除文件夹（`fileId` 以 `dir_` 开头）必须加 `?recursive=1`：会把文件夹、里面所有文件和各自的复读点一起删掉。不带这个参数返回 `INVALID_ARGUMENT`，防止误删整个目录。

响应：

```json
{ "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b", "deleted": true }
```

## POST /files/{fileId}/rename

重命名文件或文件夹，**只在原目录改名**，不能换文件夹（要移动另行设计）。

```json
{ "name": "第01课" }
```

规则：

- 文件不写后缀时沿用原后缀（`第01课` → `第01课.mp3`）；写了后缀就必须是常见音视频格式。
- 名字里不能有 `/`、`\`、`:`，不能以 `.` 开头，不能是 `.` 或 `..`。
- 音频改名时，旁边同名的 `.lrc` / `.srt` 歌词会一起改名，不影响歌词。
- 目标名字已存在返回 `INVALID_ARGUMENT`；名字和原来一样时返回 `renamed: false`，不算失败。
- 文件内容没变，`fileId`（md5）不变，复读点和收藏自动跟着走；文件夹的 `fileId` 按路径算，改名后**会变**，旧 id 作废。

响应：

```json
{
  "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
  "name": "第01课.mp3",
  "path": "/听力/第01课.mp3",
  "type": "audio",
  "renamed": true
}
```

## GET /files/{fileId}/repeats

读某个文件的全部复读点，按 `index` 升序。

```json
{
  "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
  "name": "EnglishPod_012.mp3",
  "duration": 1832.5,
  "items": [
    {
      "repeatId": "a1b2c3",
      "index": 1,
      "start": 0.0,
      "end": 21.4,
      "text": "Welcome to EnglishPod.",
      "translation": "欢迎收听 EnglishPod。"
    }
  ]
}
```

## POST /files/{fileId}/repeats

批量写复读点，最核心的接口。

```json
{
  "mode": "replace",
  "items": [
    {
      "start": 0.0,
      "end": 21.4,
      "text": "Welcome to EnglishPod.",
      "translation": "欢迎收听 EnglishPod。"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | string | 是 | `replace` 覆盖全部；`append` 追加到末尾 |
| `items[].start` | number | 是 | 起始秒，>= 0 |
| `items[].end` | number | 是 | 结束秒，必须大于 start |
| `items[].text` | string | 否 | 句子原文，空字符串合法 |
| `items[].translation` | string | 否 | 翻译，空字符串合法 |

响应：

```json
{
  "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
  "mode": "replace",
  "written": 2,
  "total": 2
}
```

`replace` 天然幂等，重试安全；`append` 重试会写重复。

## POST /makes

触发听力合成，异步返回。

```json
{
  "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
  "repeatCount": 2,
  "interval": "auto",
  "rate": 0.9,
  "quality": "high",
  "outputName": "EnglishPod_012_听力"
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `fileId` | string | 是 | - | 目标文件 |
| `repeatCount` | int | 否 | 1 | 每句重复次数（不含原句） |
| `interval` | string | 否 | `"auto"` | 秒数字符串（`"1"`、`"1.5"`）或 `"auto"` |
| `rate` | number | 否 | 1.0 | 语速，0.5 ~ 2.0 |
| `quality` | string | 否 | `"high"` | `high` / `medium` / `low` |
| `outputName` | string | 否 | 文件名 + 时间戳 | 输出名，非法字符会被过滤 |

响应 `202`：

```json
{
  "taskId": "t_20261111_153012_a1b2c3",
  "status": "pending"
}
```

已有任务在跑时返回 `409 TASK_RUNNING`，body 里带当前 `taskId`，可以等它或者取消它。

## GET /tasks/{taskId}

```json
{
  "taskId": "t_20261111_153012_a1b2c3",
  "type": "make_audio",
  "fileId": "9d1f0c7a2b3e4d5f6a7b8c9d0e1f2a3b",
  "status": "running",
  "stage": "generating_segments",
  "progress": 0.35,
  "createdAt": 1762844412,
  "finishedAt": null,
  "output": null,
  "error": null
}
```

成功后 `output` 填上：

```json
{
  "fileName": "EnglishPod_012_听力.m4a",
  "audioPath": "/var/mobile/Containers/Data/Application/.../tmp/AudioMake/EnglishPod_012_听力.m4a",
  "lrcPath": "/var/mobile/Containers/Data/Application/.../tmp/AudioMake/EnglishPod_012_听力.lrc",
  "duration": 4123.8
}
```

`audioPath` / `lrcPath` 是 App 沙盒里的绝对路径，电脑上访问不到，取文件走下面的下载接口。

## GET /tasks/{taskId}/output

把合成产物下载到电脑。响应是文件字节，不是 JSON。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | string | 否 | `audio`（默认）或 `lrc` |

```bash
curl -H "Authorization: Bearer <token>" \
  "http://192.168.1.23:8765/api/ai/tasks/<taskId>/output?kind=audio" \
  -o "EnglishPod_012_听力.m4a"
```

响应头：

```
Content-Type: audio/x-m4a
Content-Disposition: attachment; filename="EnglishPod_012_听力.m4a"; filename*=UTF-8''EnglishPod_012_%E5%90%AC%E5%8A%9B.m4a
Content-Length: 7340032
```

`kind=lrc` 时 `Content-Type` 是 `text/plain; charset=utf-8`。

| 情况 | HTTP | code |
|---|---|---|
| 任务不存在 | 404 | `NOT_FOUND` |
| 任务还没结束 | 409 | `TASK_RUNNING`（body 带 taskId 和当前 status） |
| 任务失败或取消 | 409 | `TASK_NOT_DONE` |
| 产物已不存在，或该任务没有歌词 | 404 | `NOT_FOUND` |

状态机：

```
pending → running → succeeded
                  ↘ failed
       ↘ cancelled
```

`stage`：`preparing` / `generating_segments` / `merging` / `writing_lrc` / `done`。

`progress` 是粗粒度的，只在阶段切换时更新（0 / 0.1 / 0.35 / 0.9 / 1），不要拿它算剩余时间。

## DELETE /tasks/{taskId}

取消还没结束的任务。`running` 时设取消标记，当前片段生成完就退出。

```json
{ "taskId": "t_20261111_153012_a1b2c3", "status": "cancelled" }
```
