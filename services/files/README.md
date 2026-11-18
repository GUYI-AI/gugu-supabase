# 文件服务(workspace files)

工作区 = 咕咕内置 App 的第二层:内存里持有打开的文件、合并转发每次按键、存盘、卸载、冷压缩。
设计真源:gugu-base `notes/2026-09-29-app-platform/workspace-app/README.md` §2.1–2.3。

- 一个文件 = `chat.workspace_items` 一行。存盘时同一条 UPDATE 写 `ystate`(Yjs 状态)、`inline_text`(可读内容)、`size_bytes`。
- 文档名 `<itemId>@<epoch>`。markdown 用 `Y.Text('content')`,JSON 用 `Y.Map('root')`。
- 以受限角色 `gugu_files` 连库(迁移 `20260929063000` 建、`20260929155000` 改名);判权只走 `chat.files_authorize`。

## 接口

对外口(nginx 的 `/files/` 剥掉前缀后转到这里):

| | |
|---|---|
| WebSocket `/` | 子协议 `['gugu-files.v1', 'bearer.<JWT>']`,服务端回应 `gugu-files.v1`。❌ 请求头、❌ query 里的令牌。代 agent 打开再带一项 `as.<agentId>`(和 HTTP 的 `X-Gugu-As-Agent` 同一个判据),一条连接一个身份 |
| `GET /:id` | `Authorization: Bearer <JWT>`,agent 另带 `X-Gugu-As-Agent: <agentId>`。回 `{ epoch, contentType, text, live }`,JSON 缩进 2 格 |
| `POST /:id/edit` | body `{ old, new }`:在当前内容里找唯一的 `old` 换掉。成功 `{ ok: true, epoch }` |
| `POST /:id/replace` | Incoming inspected upload: `{ key, expected, finish }`. Prepare drains F71 providers and rejects a changed baseline with 409. Edge then runs the existing attachment/file transaction with the original JWT and always calls finish. |
| `OPTIONS /:id`、`/:id/edit` | 浏览器的预检:204。这两条路的每个响应(含错误)都带 `Access-Control-Allow-Origin: *` 与允许的方法、请求头(`Authorization`、`Content-Type`、`X-Gugu-As-Agent`)—— 凭证只走 `Authorization` 不走 cookie,所以 `*` 放行也读不到别人的东西 |

错误体都是 `{ error }`:`bad-credential` 401 · `not-found` 404(不是成员与不存在同一句)· `not-a-document` 409 ·
`content-changed` / `ambiguous`(带 `count`)409 · `empty-old` / `bad-request` 400 · `too-large` 413 · `invalid-json` 422 ·
`compacting` 503(edit 连着 4 代都撞上热压缩换代,一处都没改,过一会儿再试;F71)。

WebSocket 的拒绝原因(打开文件时):`not-found`、`not-a-document`、`stale-epoch:<n>`(重载到新代号)、
`too-large`(库里的文件已超限)、`invalid-json`。断开原因(开着时,客户端从 provider 的 onClose 拿到 `event.reason`):`removed-from-group`、`deleted`(文件被删)、
`rate-limited`、`too-large`(这次更新会超限 —— 客户端别自动重连重发,先把本地改动退回)。握手凭证无效直接 401。

presence:每个 awareness 状态的 `user` 由服务按连接身份盖成 `{ id, name, color }`,页面自报的一律覆盖。
盖的章回不到发出方自己,所以每条文件连接认证通过后(重连也算)服务再用 stateless 发一次
`{"t":"self","user":{ id, name, color }}` —— 和别人看到的章同一个来源;页面 ❌ 自己算颜色。

JSON 的并发(F43,`src/concurrent.mjs`):map 的键是地址,两端同时第一次建同一条嵌套路径(各建一个中间 map)时,
服务把输的那个 map 的内容并进胜者,两边写的都留下;键上别的值(数组、协同文本、数字、字符串)后写者胜。
看见旧值之后有意替换(比如重置成 `{}`)不修。页面运行时要装同一条 `keepReplacedMaps`(被替换掉的 map 不做 GC),
否则离线重连时本地先判自己输了,自己那份在送到服务之前就被回收。计数在 `/stats` 的 `concurrentMerges`。

内部口(只绑回环或与 attachments 函数同一内网,❌ 经 nginx 暴露):`GET /healthz`(库与 LISTEN 都通才 200)、`GET /stats`、`POST /inspect`。

`POST /inspect`:`Authorization: Bearer <服务间密钥>`,body `{ source: { url, headers }, limit, retain }` —— attachments 函数签好的一条读暂存对象的请求。流式读完,超过 `limit` 一个字节就停(413);回 200,正文是前 `min(大小, retain)` 字节,头 `x-gugu-sha256`、`x-gugu-size`、`x-gugu-etag`。来源不在 404、读不了 502、密钥不对 401、没配密钥 503。

Replacement preparation is one-use state on the existing upload receipt, expires after 30 seconds, and needs no new file-service configuration.
Finish cancels unused preparation under its receipt lock before resuming; success retires the old epoch through F71 so mounted editors reopen. An abandoned request releases after expiry, and late commits are rejected in the database.
For the service-only `attachments/document-import` migration, a row whose stored bytes cannot be read or do not match its version (`source_unavailable`, `source_changed`) is returned in `skipped` with its item UUID and passed over; any other refusal stops the batch with the item UUID in its message. `dry_run: true` reads and classifies the same rows and lists each decision in `items` without writing. Published assistant panel bodies are never candidates.

## 配置(环境变量)

| 变量 | 缺省 | |
|---|---|---|
| `FILES_DB_URL_FILE` | —(必填) | 存 `gugu_files` 连接串的文件;凭据只认文件 |
| `FILES_JWKS_URL` / `FILES_JWT_SECRET_FILE` | 至少一个 | GoTrue 的 JWKS;HS256 密钥文件(可缺) |
| `FILES_JWT_ISSUER` | 不核 | 给了就核 `iss` |
| `FILES_HOST` / `FILES_PORT` | `127.0.0.1` / `18320` | 对外口;容器里设 `0.0.0.0`,宿主只发布到回环 |
| `FILES_ADMIN_HOST` / `FILES_ADMIN_PORT` | `127.0.0.1` / `18321` | 内部口 |
| `FILES_INSPECT_SECRET_FILE` | 不配 ⇒ `/inspect` 回 503 | 内部口 `POST /inspect` 的服务间密钥文件;attachments 函数的 `GUGU_FILES_INSPECT_SECRET` 是同一个值 |
| `FILES_TIMEOUT_MS` | 30000 | 连接心跳超时 |
| `FILES_DEBOUNCE_MS` / `FILES_MAX_DEBOUNCE_MS` | 1000 / 5000 | 存盘去抖 |
| `FILES_MAX_FILE_BYTES` | 1 MiB | 文本 / JSON 文件上限 |
| `FILES_RATE_UPDATES_PER_SEC` / `_BURST` | 50 / 500 | 每连接消息条数,超了断开 |
| `FILES_RATE_BYTES_PER_SEC` / `_BURST` | 256 KiB / 8 MiB | 每连接字节,突发装得下一次整份重连同步 |
| `FILES_RATE_AWARENESS_PER_SEC` / `_BURST` | 30 / 90 | presence;超了只合并、不丢最新(尾帧在令牌回来时补发)。页面自己最多 20 帧/s,留一半余量 |
| `FILES_COMPACT_RATIO` / `FILES_COMPACT_MIN_BYTES` | 4 / 4096 | 冷压缩阈值 |
| `FILES_HOT_COMPACT_RATIO` / `FILES_HOT_COMPACT_MIN_BYTES` | 8 / 262144 | 文件开着时的热压缩阈值(F71):ystate > max(ratio × 正文, 下限)。比冷压缩宽得多 —— 换代会断开编辑器的撤销历史,只收拾一直整段改写的 App |
| `FILES_HOT_COMPACT_COOLDOWN_MS` | 60000 | 同一个文件两次热压缩尝试之间至少隔多久 |
| `FILES_COMPACT_DRAIN_MS` | 1000 | 热压缩等所有连接排空最多多久;超时这一轮作废(`resume`),绝不在没排空时换代 |
| `FILES_ROUND_IDLE_MS` | 30000 | 一轮改动的界限(G2):agent 那一轮开始、结束或换了 agent,或谁都停了这么久再改,就把上一轮记成一版历史(几个人轮流打字不切)(`chat.workspace_item_versions`,每个文件留最近 50 版);停够了的轮在下一笔改动时拿出内存、当场记下,内存里只留这么久之内改过的文件 |
| `FILES_STORE_WAITS_HISTORY_MS` | 5000 | 存盘之前最多等这个文件排着的历史写完多久(G2):上一轮的样子要先于这一轮的正文落库,否则「建好后没变过 ⇒ 建它的人」那条兜底失效、作者记成空。等不到(库卡住、写失败重试中)就只记日志、照常存盘 —— 作者丢了也比正文没存上强 |
| `FILES_LOG_LEVEL` | `info` | 结构化日志(一行一个 JSON) |

## 本地跑

```bash
pnpm install
# gugu_files 迁移建出来是 NOLOGIN:只在自己的本地库上给它 LOGIN 与口令,连接串写进一个 0600 文件
FILES_DB_URL_FILE=<文件> FILES_JWKS_URL=http://127.0.0.1:<API 口>/auth/v1/.well-known/jwks.json \
  node services/files/src/main.mjs
docker build -f services/files/Dockerfile -t gugu-files:<sha> .   # 镜像
```

## 判据

- `tests/unit/files/`:内容转换与 edit、凭证解析与验签、令牌桶。
- `tests/integration/files/`:原型 E2(三人 + agent 同时编辑)、E4(关闭、kill -9、合盖、冷压缩换代)、E5(鉴权、HTTP 契约、
  移出与删除、JSON、presence、上限与限速、加载核对),每条带对照。只要一个跑完迁移的库(自签 JWKS,❌ GoTrue)。
