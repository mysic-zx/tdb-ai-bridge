# 听读宝 AI Bridge

用外部 AI（Claude Code、Cursor、Codex 等）直接操作听读宝，批量制作听力文件。

这个仓库是**客户端示例**：提供命令行工具、MCP 服务端，以及一份本地假服务端。它不含听读宝 App 的实现，只演示怎么调用 App 开放的 HTTP 接口。

> 协议处于 `0.x` 阶段，字段可能调整。连上设备后先看 `tdb ping` 返回的 `apiVersion`。

## 它是什么

- 一个 CLI：`tdb files`、`tdb set-repeats`、`tdb make`
- 一个 MCP 服务端：`tdb mcp`，给 Claude Code / Cursor / Codex 直接调用
- 一个 mock 服务端：`tdb mock`，没有手机也能跑通完整流程

## 它不是什么

- 不是 SDK，不包含听读宝的业务逻辑
- 不是云服务，所有请求都在局域网内完成
- 不收集任何数据，token 只存在你本机

## 快速开始

### 没有听读宝 App

```bash
npm install
npm run build

# 终端 1：起假服务端
node dist/index.js mock

# 终端 2：指向假服务端
node dist/index.js config set --host 127.0.0.1:8799 --token mock
node dist/index.js ping
node dist/index.js files
```

### 有听读宝 App

1. 手机打开「设置 → 实验室 → AI 开放接口」并开启
2. 记下页面上的地址和令牌，或直接复制配对串
3. 在电脑上：

```bash
npx github:mysic-zx/tdb-ai-bridge config from-url "tdb://pair?host=192.168.1.23&port=8765&token=xxx"
npx github:mysic-zx/tdb-ai-bridge ping
```

手机需要保持在这个界面，并且和电脑在同一个 WiFi 下。

## 三种用法

### CLI

```bash
tdb files --keyword EnglishPod
tdb repeats <fileId>
tdb set-repeats <fileId> --file examples/repeats.sample.json --mode replace
tdb make <fileId> --count 2 --interval auto --rate 0.9
tdb wait <taskId>
```

### MCP

```bash
claude mcp add tdb \
  --env TDB_HOST=192.168.1.23:8765 \
  --env TDB_TOKEN=xxx \
  -- npx github:mysic-zx/tdb-ai-bridge mcp
```

可用的工具：

| 工具 | 作用 |
| --- | --- |
| `tdb_capabilities` | 能力探测 |
| `tdb_list_files` | 列文件 |
| `tdb_get_repeats` | 读复读点 |
| `tdb_set_repeats` | 批量写复读点 |
| `tdb_make_audio` | 触发合成，可等待完成 |
| `tdb_get_task` | 查任务 |
| `tdb_cancel_task` | 取消任务 |

### mock

```bash
tdb mock --port 8799
```

返回固定假数据：2 个文件夹、5 个音频、每个 20 条复读点，合成任务 3 秒后完成。CI 和贡献者开发都用它。

## 协议

完整协议见 [docs/protocol.md](docs/protocol.md)。

Base URL 形如 `http://192.168.1.23:8765/api/ai`，请求头：

```
Authorization: Bearer <token>
Content-Type: application/json
```

## 提示词

`prompts/listening-maker.md` 里有一段可以直接粘给 Claude 的提示词，描述怎么读文件、切句、写复读点、触发合成。

## 给 AI 装 Skill

比提示词更省事的办法是把仓库自带的 skill 装进 Claude Code，AI 会自动知道什么时候该用 tdb、怎么用：

```bash
git clone https://github.com/mysic-zx/tdb-ai-bridge.git
mkdir -p ~/.claude/skills
cp -r tdb-ai-bridge/skills/tdb-listening-maker ~/.claude/skills/
```

装完重启 Claude Code，直接说「帮我把 EnglishPod 第 12 期做成听力文件」就行。Cursor / Codex 等支持 Agent Skills 的工具同样适用，把目录放到它们各自的 skills 路径下即可。

## 常见问题

**连不上**：确认手机和电脑在同一 WiFi、App 停在 AI 接口页面、地址和令牌没写错。先跑 `tdb ping`。

**为什么必须同一局域网**：接口是 App 内置的本地 HTTP 服务，不经过云端。这样音频不需要上传。

**手机上能跑吗**：不能。手机是服务端，电脑是客户端。

**合成要多久**：取决于音频长度和片段数量，接口是异步的，用 `tdb wait` 或轮询。

## License

MIT
