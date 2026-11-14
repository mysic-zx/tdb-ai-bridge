---
name: tdb-listening-maker
description: 用 tdb 命令行（或 MCP）操作手机上的听读宝，管理音频文件和复读点（AB 点），再据此合成听力文件。用户说「把电脑这段音频传到听读宝」「看看这个文件有哪些 AB 点」「第 5 句往前挪一点」「删掉第 3 句」「重切一遍」「做成一句一停的听力文件」「把做好的音频下载下来」时都用它。需要手机上的听读宝 App 已在「设置 → 实验室 → AI 开放接口」开启服务。
---

# 听读宝：文件管理、AB点管理、听力合成

这份手册覆盖四件事：找文件、传文件（上传 / 下载 / 删除）、管理 AB 点（App 里叫「复读点」）、合成听力文件。合成只是最后一环，前面两件才是日常干得最多的，别一上来就 `make`。

适用于任何**能在用户电脑上执行终端命令**的 AI 助手：Claude Code、Cursor、Codex、豆包桌面版都行。前提是手机上的听读宝已开启 AI 接口，且和电脑在同一 WiFi。

## 命令怎么执行

下文统一写 `tdb`，实际执行时按下面的优先级替换成真实命令：

1. 用户已全局安装（`npm install -g github:mysic-zx/tdb-ai-bridge`）：直接用 `tdb xxx`
2. 否则用 `npx github:mysic-zx/tdb-ai-bridge xxx`
3. **GitHub 拉不动**（国内网络很常见，npx 超时 / clone 失败）：换 Gitee 镜像，两种用法任选：
   ```bash
   # 直接从 Gitee 跑（每次执行都这么写）
   npx git+https://gitee.com/mysic-zx/tdb-ai-bridge.git xxx

   # 或者本地构建一次，之后所有 tdb 都换成 node <clone路径>/dist/index.js xxx
   git clone https://gitee.com/mysic-zx/tdb-ai-bridge.git
   cd tdb-ai-bridge && npm install && npm run build
   ```
   本地构建一次后面就稳了，推荐。
4. 判断该用哪种：先跑 `tdb --version` 或 `npx github:mysic-zx/tdb-ai-bridge --version`，报 command not found / 超时就换下一种，不要卡在一种上反复重试。

Windows 用户注意：配置文件在 `%USERPROFILE%\.tdb\config.json`（Mac/Linux 是 `~/.tdb/`）；示例里的 `~` 在 PowerShell 里换成 `$env:USERPROFILE`。

## 单条命令跑太久怎么办

有三类慢操作，都可能撞上宿主环境的单条命令超时：

| 操作 | 大概要多久 | 撞超时了怎么改 |
|---|---|---|
| `tdb make --wait` 合成 | 几分钟到十几分钟 | 提交 + 轮询（见下） |
| `tdb upload` 大文件 | 200MB 在普通 WiFi 上一两分钟，客户端超时放到 10 分钟 | 先查结果，别急着重传 |
| `tdb download` 产物 | 同上 | 先看本地文件大小，再决定重下 |

合成改成「提交 + 轮询」：

```bash
tdb make <fileId> --count 2 --json        # 提交，立刻拿 taskId
tdb task <taskId> --json                  # 每隔 5~10 秒查一次
```

`task` 返回的 `status` 变成 `succeeded` / `failed` / `cancelled` 就结束了，`succeeded` 时 `output` 里有产物路径。轮询间隔别小于 3 秒。也可以用 `tdb wait <taskId>` 让它自己轮询到底。

上传和下载**都没有断点续传**：命令被中断时先确认结果，再决定要不要重来。上传先 `tdb files --keyword 文件名` 看有没有落地（同名不覆盖，重传也安全）；下载先看本地文件在不在、大小对不对。

## 听读宝开放了哪些能力

App 通过 `capabilities.abilities` 声明能力，当前一共九项。每项都有 CLI 和 MCP 两种调用方式，效果相同：

| 能力 | 能做什么 | CLI | MCP 工具 |
|---|---|---|---|
| `files.read` | 列出音频库：文件名、路径、时长、大小、文件夹，支持关键词搜索 | `tdb files` | `tdb_list_files` |
| `files.upload` | 把电脑上的音频传到听读宝（≤200MB，音视频白名单，同名不覆盖，可指定已存在的一级子目录） | `tdb upload <文件> [--folder 目录]` | `tdb_upload_file` |
| `files.rename` | 重命名音频/视频文件或文件夹，只在原目录改名，歌词跟着走 | `tdb rename <fileId> <新名字>` | `tdb_rename_file` |
| `files.delete` | 删除文件（连同复读点和歌词）或递归删除文件夹，**不可恢复** | `tdb delete <fileId> [--recursive]` | `tdb_delete_file` |
| `files.mkdir` | 在 Documents 下新建一级文件夹，已存在时幂等返回 | `tdb mkdir <文件夹名>` | `tdb_create_folder` |
| `repeats.read` | 读某个文件现有的全部复读点（起止时间、原文、翻译） | `tdb repeats` | `tdb_get_repeats` |
| `repeats.write` | 批量写入复读点，replace 覆盖全部或 append 追加 | `tdb set-repeats` | `tdb_set_repeats` |
| `make.audio` | 用复读点合成听力文件（每句重复 N 次 + 间隔 + 语速，附带歌词），异步任务可查询、等待、取消 | `tdb make` / `task` / `wait` / `cancel` | `tdb_make_audio` / `tdb_get_task` / `tdb_cancel_task` |
| `make.download` | 把合成产物（音频 / 歌词）下载到电脑 | `tdb download` | `tdb_download_output` |

配对与探测不算独立能力，但每次连接都会用到：`tdb ping`（MCP `tdb_capabilities`）确认连通并返回 App 版本、接口版本、能力清单、单次复读点上限（500 条）、并发任务数（1）和单文件上传上限（200MB）。

**没开放的**（用户问起如实说，别用别的命令硬凑）：播放控制、文件跨文件夹移动、多层嵌套文件夹（只能建一级，上传也只能落进一级）、从手机下载原始音频、词本 / 生词 / Coach、订阅 / IAP / 云盘 / WiFi 传输、任何云端接口（全部操作只在局域网内）。确实需要就建议用户走听读宝的反馈渠道，协议以后可能扩。

### 想走 MCP 而不是命令行

上面这些能力也有一套 MCP 工具（表格最后一列），适合已经在 Claude Code / Cursor / Codex 里配过 MCP 的用户。启动方式：

```bash
claude mcp add tdb \
  --env TDB_HOST=192.168.1.23:8765 \
  --env TDB_TOKEN=xxx \
  -- npx github:mysic-zx/tdb-ai-bridge mcp
```

MCP 的配置在进程启动时读一次，改了 host 或 token 要重启客户端才生效。和命令行的差异只有三处：写复读点传 `items` 数组（不走 `--file`）、下载用 `outDir` 传目录、`tdb_make_audio` 的等待上限用 `timeoutSeconds`（默认 1800 秒）。其余语义完全一样，下文都用命令行讲，MCP 照参数名对应。

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
- 想手动改配置：`tdb config set --host 192.168.1.23:8765 --token <令牌>`（令牌就是 App 页面上显示的那串），核对用 `tdb config show`，token 会打码。

后续所有命令都支持 `--json`，拿 JSON 比解析表格稳。建议每条都带上。

## 一、文件管理

`fileId` 是后面所有操作的入口，找文件这一步不能糊弄。

### 1.1 找文件

```bash
tdb files --json                              # 根目录
tdb files --keyword EnglishPod --json         # 按文件名模糊搜
tdb files --folder /BBC --json                # 指定文件夹
tdb files --folder /BBC --recursive --json    # 连子文件夹一起列
```

- 不带 `--folder` 只看根目录，子目录不会自动展开；要整棵树就加 `--recursive`。
- 表格输出只有 fileId / 名称 / 时长 / 复读 / 歌词。要看完整路径、大小、类型得用 `--json`。
- `type` 有 `audio` / `video` / `folder` 三种。`folder` 条目是子目录提示，不能拿它去写复读点。
- 不同文件夹里可能重名（`/A/lesson.mp3` 和 `/B/lesson.mp3`），报给用户时带上 `path`，别只给文件名。
- 视频条目（`type: "video"`）的 `duration` 可能返回 `0`，别拿它判断能不能合成；有没有分句看 `repeatCount`。
- `fileId` 是文件内容 MD5，原样传，不要截断、不要改写。

用户没说清是哪个文件时，先问。列 3~5 个候选（带路径和时长）让他挑，不要自己猜。

### 1.2 上传：把电脑上的音频放进听读宝

```bash
tdb upload ~/Downloads/lesson.mp3 --json
tdb upload ~/Downloads/lesson.mp3 --folder 听力 --json
```

返回 `fileId` / `name` / `size` / `existed` / `folder`。拿到 fileId 就能直接写复读点，不用等 App 刷新列表。

`--folder` 可选，只能是听读宝 Documents 下**已经存在的一级子目录名**：不能带 `/`、不能是 `.` 或 `..`。省略就落在 Documents 根目录。目录不存在会报 `NOT_FOUND`，接口不会替你建文件夹。

上传前自己先检查三样，别等报错：

| 检查 | 规则 | 不过怎么办 |
|---|---|---|
| 文件存在且非空 | 路径有效、大小 > 0 | 让用户确认路径 |
| 大小 | ≤ 200MB | 超过先问用户要不要压缩或切分（本地 ffmpeg），别自作主张 |
| 格式 | mp3 / m4a / aac / wav / flac / ape / ogg / wma / opus / mp4 / m4v / mov / mkv / avi / webm | 其它格式（aiff、m4b、amr、srt 等）先用 ffmpeg 转 mp3 再传，转之前跟用户说一声 |

三个坑：

- **落点只能是 Documents 根目录或它的一级子目录**：`--folder` 指定的目录必须先存在，不存在就先 `tdb mkdir 目录名` 建好（或者在 App 里建）。二级目录、`..`、绝对路径都会被拒。
- **同名不覆盖**：`existed: true` 表示听读宝里已经有同名文件，这次什么都没传上去。想用新版本替换，两条路：让用户在 App 里删掉旧的，或者把本地文件改个名再传（旧文件还在，要清就走删除流程）。别假装已经更新了。
- **一次只能传一个文件**。多文件就循环调用，每个都报 fileId。

### 1.3 下载：什么能下，怎么下

能下载的只有**合成产物**（音频 + 歌词）。从听读宝把原始音频拉回电脑，没有这个接口。

```bash
tdb download <taskId> --kind audio --out ./out/lesson.m4a --json
tdb download <taskId> --kind lrc   --out ./out/lesson.lrc --json
```

- 只能下已经成功的任务。任务还在跑报 `TASK_RUNNING`，失败或取消了报 `TASK_NOT_DONE`。
- `--out` 传的是**文件路径不是目录**，父目录会自动建；不传就落到当前目录、用手机上的文件名。
- `--kind` 只有 `audio` / `lrc`，一次一种。要音频加歌词就调两次；MCP 的 `tdb_download_output` 也是同理，`outDir` 给目录，调两次。
- 任务没有歌词时下 lrc 会报「这个任务没有歌词文件」。
- 报 `NOT_SUPPORTED`：设备端版本太老没有 `/output` 路由，让用户升级听读宝。
- 下载前后都看一眼文件大小，0 字节或明显偏小就是没拉全，重下。

**产物会消失**：合成结果躺在 App 的 `tmp/AudioMake/`，系统清临时目录、重装 App 就没了。要留档就当场下。

更省事的做法：合成时直接带 `--download <目录>`（必须配 `--wait`），成功后音频和歌词一次拉回来。

### 1.4 删除：唯一不能撤销的操作

规矩先摆明白：

- 删之前把**文件名（最好带路径）**和它有多少条复读点报给用户，等明确点头再动。
- 删掉的是文件 + 它的全部复读点 + 歌词，不可恢复，没有回收站。
- **CLI 里 AI 删不了**：`tdb delete <fileId> --json` 不带 `--yes` 会直接以退出码 2 拒绝，提示「AI 不允许直接删除」。所以你要做的是把命令交给用户，让他自己敲：

```bash
tdb delete <fileId> --yes      # 不带 --yes 会要求用户手动输入 y
```

- 走 MCP 时 `tdb_delete_file` 可以删，但要求 `confirmedByUser: true`，这个 true 必须是用户真实同意了才填，不是你自己补的。

### 1.5 文件层面做不了的事

- 移动 / 重命名文件：没有接口，让用户在 App 里做。
- 新建 / 删除 / 重命名文件夹：同上。
- 把听读宝里的原始音频下载回电脑：没有接口（只有合成产物能下）。
- 编辑音频内容（裁剪、降噪、转码）：不在协议范围。要用本地 ffmpeg 处理，处理完当新文件上传，并且跟用户讲清楚这是另一个文件。

## 二、AB 点（复读点）管理

App 里叫「复读点」，本质就是一句一个 AB 点：`start` / `end` 加原文和翻译。合成听力、跟读练习全靠它。

### 2.1 先读，再动手

```bash
tdb repeats <fileId> --json
```

返回 `fileId` / `name` / `duration` / `items[]`。`items` 按 `index` 升序，每条有 `repeatId`、`index`、`start`、`end`、`text`、`translation`（`text` / `translation` 可能整个字段都没有，不是空串就是没写）。

- `tdb files` 里的 `repeatCount` 只有数量，改动前还是得 `repeats` 拿全量。
- `duration` 是校验 `end` 的依据。视频条目的时长可能不准，做视频时以实际听到的为准，并告诉用户这个偏差。
- 已经有复读点、用户又没说重做：先报数量加前 3 条，问保留还是覆盖。别一声不吭 replace 掉。

### 2.2 写：两种 mode，区别很大

```bash
tdb set-repeats <fileId> --file repeats.json --mode replace --json
tdb set-repeats <fileId> --file repeats.json --mode append  --json
```

JSON 两种写法都认：裸数组，或者 `{ "mode": "...", "items": [...] }` 对象。优先级是 `--mode` > 对象里的 `mode` > 默认 `replace`。格式参考 `examples/repeats.sample.json`。

| mode | 干什么 | 重试安全吗 | 什么时候用 |
|---|---|---|---|
| `replace` | 清掉这个文件现有的全部复读点，换成这一批 | 安全，幂等 | 默认。重切、改某一条、整体平移、插中间、删某条 |
| `append` | 追加到现有末尾 | 不安全，重试会写重复 | 只在用户明确要「往后加」，或超过 500 条分批时 |

`append` 写超时了不要直接重试：先 `tdb repeats` 数一遍，确认这一批到底进去没有，再决定补写还是收手。

JSON 文件存到**系统临时目录**（Mac/Linux `/tmp`，Windows `%TEMP%`），别扔进用户的工作目录。

### 2.3 写之前自己过一遍校验

| 项 | 规则 | 说明 |
|---|---|---|
| `start` | ≥ 0，一般保留 1~2 位小数 | 单位是秒，不是帧 |
| `end` | 必须大于 `start` | 服务端会回 422 `VALIDATION_FAILED` |
| `end` 上限 | ≤ `duration` + 0.5 | 复用 App 生成的复读点时常常正好超出去零点几秒，写前截到 `duration` |
| 顺序 | 按时间升序 | 乱序在 App 里显示会很难看 |
| 相邻 | 前一条 `end` 不要压到后一条 `start` | 想连读就首尾相接，别重叠 |
| 条数 | 单次 ≤ 500 条 | 超了看 2.5 |
| 字段 | 只认 `start` / `end` / `text` / `translation` | `repeatId`、`index` 会被忽略，重写后 App 重新分配 |

文本规矩：

- `text` 原文照抄（ASR 结果或用户给的稿子），不要润色、不要改标点、不要擅自补句子。
- `translation` 给中文翻译；用户只要英文，或原文本身就是中文，就别写这个字段。
- 空字符串合法，但别用空串占位，能省就省。

### 2.4 常见改法

这个接口是**整表替换，没有单条增删改**。任何局部改动都是「读全量 → 内存里改 → 整体写回」，写回时别把没改的条目丢了（`text` / `translation` 一起带上）。

| 用户说的话 | 怎么做 |
|---|---|
| 「重新切一遍」 | 按语义切句，`replace` 全量 |
| 「第 5 条往前挪 0.3 秒」 | `repeats` 读全量 → 改第 5 条 `start` / `end`（长度不变）→ `replace` 全量 |
| 「把第 8 句拆成两句」 | 读全量 → 在原位置插一条、原条 `end` 收到切分点 → `replace` 全量 |
| 「删掉第 3 条」 | 读全量 → 数组里去掉 → `replace` 全量 |
| 「后面再加 20 句」 | 新切 20 条，`append` |
| 「只想改第一条」 | 同样读全量改一条再 `replace`，没有单条编辑接口 |
| 「清空所有复读点」 | 没有这个能力：CLI 和 MCP 都要求至少 1 条，空数组会被拒。让用户在 App 里清，或者问要不要整体重切成新的 |

### 2.5 超过 500 条

分批写：第一批 500 条用 `replace`，剩下的用 `append`，每次最多 500。

```
1000 条 = replace(items[0..499]) + append(items[500..999])
```

分批中途失败，先 `tdb repeats` 读数对数，再从断点补 `append`。别从头重跑 `replace`，会把已经写好的前半段一起冲掉。

## 三、合成听力文件

前置：这个文件已经有复读点（`repeatCount > 0`）。没有就先按第二节写。

三个参数要跟用户确认，别替他拍板：

- 每句额外重复几次（`--count`，不含原句，不传就是 1）
- 句间间隔（`--interval auto` 或具体秒数）
- 语速（`--rate`，0.5~2.0，复习阶段可以更慢）

另外两个可以不问：`--quality` 是 high / medium / low（不传 high），`--name` 里的非法字符会被过滤，中文没问题。

```bash
tdb make <fileId> --count 2 --interval auto --rate 0.9 --quality high --name "EnglishPod_012_听力" --wait --download ./out --json
```

- `--wait` 会轮询到任务结束再返回。宿主会超时就改成提交 + 轮询，见前面那节。
- `--download <目录>` 必须配 `--wait`，成功后把音频（有歌词的话连歌词）一起拉到电脑；只提交不等的时候不能带。
- 成功时把 `output.audioPath`、`output.duration`，有的话再加 `output.lrcPath` 报给用户。`audioPath` 是手机沙盒内的绝对路径，电脑上打不开，别让用户去那找；要文件就下载。
- 产物写在 App 沙盒的 `tmp/AudioMake/`，**不会**出现在 `tdb files` 的音频库列表里，别去列表里找。
- 失败时把 `error.code` 和 `error.message` 原样转述，别自己解释成网络问题。
- 报 `TASK_RUNNING`：App 里已有任务在跑，body 里带 `taskId`，问用户等它还是 `tdb cancel <taskId>`。

## 报错怎么读

先把 `error.code` 看一眼，多数问题自己就能定性，别笼统地当网络问题重试：

| code | 一般是什么 | 怎么办 |
|---|---|---|
| `NO_HOST` | 还没配对，或配置文件被清了 | `tdb config show` 看 host 空不空，空就走第 0 步 |
| `UNAUTHORIZED`（401） | token 对不上。App 重开、重新开启接口后令牌会变 | 让用户重新配对（扫码或复制配对串），拿旧 token 反复试没意义 |
| `FORBIDDEN`（403） | 请求不是从局域网来的：换了网、路由器开了 AP 隔离、或热点不是这台手机的 | 让手机和电脑回到同一个 WiFi；用热点时确认电脑连的就是这台手机 |
| `TIMEOUT` / `NETWORK` | 手机锁屏、App 退到后台、IP 变了 | 让用户把听读宝切回前台再跑一次；连续两次失败就停下问用户 |
| `BAD_RESPONSE` | 返回的不是 JSON，多半端口填错或被别的服务占了 | `tdb config show` 核对 host:port |
| `INVALID_ARGUMENT` | 参数不对：复读点文件格式错、上传格式不在白名单 | 按 message 改参数，别原样重试 |
| `VALIDATION_FAILED`（422） | 复读点时间非法 | 回 2.3 那张表逐条对 |
| `NOT_FOUND` | fileId / taskId 不存在，或文件已被删 | 重新 `tdb files` 找 |
| `TASK_RUNNING` / `TASK_NOT_DONE` | 合成还没结束 / 已经失败取消 | 前者 `tdb wait` 或 `tdb cancel`，后者看 `task` 里的 error |
| `NOT_SUPPORTED` | App 版本太老，没有下载路由 | 让用户升级听读宝 |
| `WAIT_TIMEOUT` | 等了半小时还没结束 | `tdb task` 再看一眼状态，别直接判定失败 |
| `INTERNAL`（500） | App 端未预期异常 | 原样转述 message，让用户在 App 里看合成记录或反馈 |

## 硬性约束

- 一个 App 同时只能跑一个合成任务。
- `replace` 会清掉用户已有的复读点，动手前问一句；删除文件必须用户明确同意。
- 时间是估的时候必须说出来，让用户听一遍确认。
- 不要为了「更完整」擅自补句子，不要改用户给的文本。
- `fileId` 是字符串，原样传，不要截断。
- 配置的优先级是环境变量 `TDB_HOST` / `TDB_TOKEN` > `~/.tdb/config.json`，装了 MCP 的话两边共用同一份配置。
- token 相当于设备通行证：贴日志、写文档、提交代码前先抹掉，`tdb config show` 里的 token 本来就是打码的。

## 协议细节

完整接口文档在仓库的 `docs/protocol.md`。需要更多背景时再读它，一般用不到。
