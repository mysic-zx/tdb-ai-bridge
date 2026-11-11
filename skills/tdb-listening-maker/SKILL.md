---
name: tdb-listening-maker
description: 通过听读宝的 tdb 命令行工具制作听力文件。当用户想"用听读宝做听力文件""把某个音频做成一句一停的复读材料""给英语文件加复读点再合成"时使用。需要手机上的听读宝 App 已在「设置 → 实验室 → AI 开放接口」开启服务。
---

# 听读宝听力文件制作

用 `tdb` 命令行操作用户手机上的听读宝：列文件、写复读点、触发合成。

## 听读宝开放了哪些能力

App 通过 `capabilities.abilities` 声明能力，当前一共六项。每项都有 CLI 和 MCP 两种调用方式，效果相同：

| 能力 | 能做什么 | CLI | MCP 工具 |
|---|---|---|---|
| `files.read` | 列出音频库：文件名、路径、时长、文件夹，支持关键词搜索 | `tdb files` | `tdb_list_files` |
| `files.upload` | 把电脑上的音频传到听读宝（≤200MB，音视频白名单，同名不覆盖） | `tdb upload <文件>` | `tdb_upload_file` |
| `files.delete` | 删除音频文件（连同复读点和歌词），**不可恢复** | `tdb delete <fileId>` | `tdb_delete_file` |
| `repeats.read` | 读某个文件现有的全部复读点（起止时间、原文、翻译） | `tdb repeats` | `tdb_get_repeats` |
| `repeats.write` | 批量写入复读点，replace 覆盖全部或 append 追加 | `tdb set-repeats` | `tdb_set_repeats` |
| `make.audio` | 用复读点合成听力文件（每句重复 N 次 + 间隔 + 语速，附带歌词），异步任务可查询、等待、取消 | `tdb make` / `task` / `wait` / `cancel` | `tdb_make_audio` / `tdb_get_task` / `tdb_cancel_task` |

配对与探测不算独立能力，但每次连接都会用到：`tdb ping`（MCP `tdb_capabilities`）确认连通并返回 App 版本、接口版本、能力清单、单次复读点上限（500 条）、并发任务数（1）和单文件上传上限（200MB）。

**删除是唯一不可恢复的操作**，规则如下：

- 删除前必须把文件名报给用户并征得明确同意，用户没点头就不要调
- MCP 的 `tdb_delete_file` 要求带 `confirmedByUser: true`；CLI 的 `tdb delete` 不带 `--yes` 会要求人工输入确认
- 电脑上准备素材的完整闭环：`tdb upload 音频` → 拿到 fileId → `tdb set-repeats` 写分句 → 可选 `tdb make` 合成

**仍然没有开放的能力**，用户问起时如实告知，不要用其它命令硬凑：

- 播放控制（播放、暂停、跳转、切歌）
- 文件的移动、重命名；文件夹的创建和删除
- 词本 / 生词 / Coach 教练数据的读写
- 订阅、IAP、云盘、WiFi 传输
- 任何云端接口，全部操作只在局域网内

如果这些能力确实有必要，让用户到听读宝的反馈渠道提需求，协议以后可能扩。

## 第 0 步：确认能连上

先跑一次探测，失败就停下告诉用户，不要反复重试：

```bash
npx github:mysic-zx/tdb-ai-bridge ping
```

- 报 `NO_HOST`：用户还没配置，引导配对，两种方式：
  1. **扫码配对**：让用户在电脑上跑 `tdb pair`，终端会出二维码；用户在听读宝「设置 → 实验室 → AI 开放接口」页点「扫描电脑二维码」扫码，配对自动完成。跑完再 `tdb ping` 确认。
  2. **手动复制**：扫码不行（比如电脑防火墙拦了、或听读宝跑在 Mac 上没摄像头）时，让用户在听读宝页面点「复制配对串」，把串（形如 `tdb://pair?host=192.168.1.23&port=8765&token=xxx`）发给你，你执行：

```bash
npx github:mysic-zx/tdb-ai-bridge config from-url "配对串"
```

- 报 `TIMEOUT` / `NETWORK`：检查手机是否停在那个页面、是否和电脑在同一 WiFi。

后续所有命令都支持 `--json`，拿 JSON 比解析表格稳。建议每条都带上。

## 制作流程

按这个顺序走，不要跳步：

### 1. 找文件

```bash
tdb files --json                       # 根目录
tdb files --keyword EnglishPod --json  # 按名字模糊搜
tdb files --folder /BBC --json         # 指定文件夹
```

把候选列表给用户看。用户没说清是哪个文件时，先问，不要自己猜。记住 `fileId`，后面都用它。

### 2. 看现有复读点

```bash
tdb repeats <fileId> --json
```

- `repeatCount > 0` 且用户没说重做：先展示数量和前几条，问用户保留还是覆盖。
- 空的、或者用户明确要重来：继续。

### 3. 切句并写入

按语义切句，不要按固定秒数硬切。每段 2~8 秒为宜，超过 12 秒通常该拆；拿不到波形时按语义估，并明确告诉用户时间点是估算的，需要听一遍确认。

```bash
# 先把切好的句子存成 JSON（见 examples/repeats.sample.json 的格式），然后：
tdb set-repeats <fileId> --file repeats.json --mode replace --json
```

规则：
- `mode` 默认用 `replace`，幂等，重试安全。
- `append` 会追加，**重试会写重复**，除非用户明确要求追加才用。
- 每条写 `start`、`end`、`text`（原文照抄，不要润色）、`translation`（中文翻译）。
- `end` 必须大于 `start`，不能超过文件时长；一次最多 500 条。

### 4. 触发合成

三个参数问用户（或从他的原始需求里拿），不要替他拍板：每句重复几次（默认 2）、间隔（`auto` 或具体秒数）、语速（0.5~2.0，复习可更慢）。

```bash
tdb make <fileId> --count 2 --interval auto --rate 0.9 --wait --json
```

`--wait` 会轮询到任务结束再返回，合成大文件可能要几分钟，耐心等。

- 返回 `succeeded`：把 `output.audioPath` 和时长报给用户，手机 App 里就能看到新文件。
- 返回 `failed`：把 `error.code` 和 `error.message` 原样转述，别自己解释成网络问题。
- 报 `TASK_RUNNING`：App 里已有任务在跑，body 里带 `taskId`，问用户等还是 `tdb cancel <taskId>`。

## 硬性约束

- 一个 App 同时只能跑一个合成任务。
- 不要为了"更完整"擅自补句子，不要改用户给的文本。
- 时间是估的时候必须说出来。
- `fileId` 是字符串，原样传，不要截断。
- 配置的优先级是环境变量 `TDB_HOST`/`TDB_TOKEN` > `~/.tdb/config.json`，装了 MCP 的话两边共用同一份配置。

## 协议细节

完整接口文档在仓库的 `docs/protocol.md`。需要更多背景时再读它，一般用不到。
