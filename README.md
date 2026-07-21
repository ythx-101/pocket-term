# pocket-term-2

`pocket-term-2` 是 **pocket-term 产品线的第二个产品版本**：把 [herdr](https://github.com/earendil-works/herdr) agent 舰队做成适合手机使用的会话客户端。你可以在手机上浏览会话列表、进入 pane 查看消息气泡、查看状态和未读提示，而不必打开一整屏共享终端。

本版本支持页内通知、可选 Web Push、受保护的消息发送、图片附件、Markdown 附件预览、HTML 附件沙箱预览，以及运行时配置的 **QingYue skill 答疑群**入口。

> 本 README 是中文主文档。命令、API 路径、环境变量、协议字段、技术名词和许可证名称保留原文，便于直接复制和核对。

## 付费答疑群

- 群名：**QingYue skill 答疑群**
- 入群费用：**55 元**
- 入口：由服务端运行时配置二维码，二维码不提交到 Git
- 有效期：以页面当前显示的二维码有效期为准

二维码未配置时，页面不会显示付费群卡片。配置后，在手机页面的“我”中可以看到群名、价格、有效期和二维码，点击二维码可放大查看。

## 快速开始

Agent 请先阅读 `SKILL.md` 并按其中流程执行。部署者只需要决定端口、是否配置公网入口，以及是否启用 Web Push。

```bash
git clone <this-repo> pocket-term-2 && cd pocket-term-2
# Node.js >= 20，并确保 herdr 正在运行且 Unix socket 可读
bash scripts/install.sh --port 7690
# 打开 http://127.0.0.1:7690/herd/
```

机器可验证的安装、检查和卸载步骤见 `AGENTS.md`。

| 脚本 | 用途 |
| --- | --- |
| `scripts/install.sh` | 非交互式安装：npm ci、systemd unit、可选 Push 和健康检查 |
| `scripts/gen-vapid.sh` | 将 VAPID 密钥对输出到 stdout，不写入 Git |
| `scripts/smoke.sh` | 对运行中的实例执行冒烟检查 |

## 功能概览

- **会话与消息**：查看 herdr 会话、Tier A transcript 气泡、Tier B 屏幕流、SSE 实时更新和未读状态。
- **受保护发送**：同源校验、body 限制、按 pane 限流、pane 存在性检查，以及 `PT2_READONLY` 紧急只读开关。
- **附件**：图片上传/预览；Markdown 仅以安全 DOM 节点渲染；HTML 使用白名单清洗、空 sandbox 和独立预览窗口。
- **付费群入口**：读取运行时配置，不把二维码或邀请 token 提交到代码仓库。
- **通知**：可选 Web Push；未配置 Push 时，页面通知和会话徽标仍然可用。

## 架构

```text
浏览器 ──(CF Access)── 反向代理 ──► 127.0.0.1:7690  pocket-term-2 bridge
                                             │
                                             ├─ GET  /herd/            SPA
                                             ├─ GET  /herd/api/state
                                             ├─ GET  /herd/api/pane/:id/messages
                                             ├─ GET  /herd/api/events          (SSE)
                                             ├─ POST /herd/api/seen/:id
                                             ├─ POST /herd/api/upload?target=chat
                                             ├─ GET  /herd/api/file?path=
                                             └─ GET  /herd/api/paid-group
                                             │
                                             ▼
                                        herdr.sock
                                             │
                                             └─ ~/.claude/projects/**.jsonl  (可选 Tier A)
```

- **Tier A**：Claude transcript JSONL，在存在 `agent_session` 时提供真实 user/agent/tool 气泡。
- **Tier B**：`pane.read` 屏幕差异，作为任意 pane 的 monospace 流式回退。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/herd/` | 聊天 SPA 静态页面 |
| GET | `/herd/api/state` | 会话列表 JSON |
| GET | `/herd/api/pane/:id/messages?before=&limit=` | 消息气泡历史 |
| GET | `/herd/api/events` | SSE：`state`、`bubble`、`:heartbeat` |
| POST | `/herd/api/seen/:id` | 标记 pane 已读，只写入 `state/last-seen.json` |
| POST | `/herd/api/upload?target=chat` | 同源限制的图片、Markdown、HTML 上传 |
| GET/HEAD | `/herd/api/file?path=` | 白名单文件读取；Markdown 使用 `text/plain` |
| GET | `/herd/api/paid-group` | 运行时付费群展示配置 |
| GET | `/herd/api/push/vapid-public` | Web Push 公钥，未配置时返回 503 |
| POST | `/herd/api/push/subscribe` | 注册同源浏览器订阅 |
| DELETE | `/herd/api/push/subscribe` | 删除同源浏览器订阅 |

默认监听地址：`PT2_HOST=127.0.0.1`、`PT2_PORT=7690`，可通过环境变量覆盖。

### 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PT2_HOST` / `PT2_PORT` | `127.0.0.1` / `7690` | 监听地址 |
| `PT2_HERDR_SOCK` | `$HOME/.config/herdr/herdr.sock` | herdr Unix socket |
| `PT2_PROJECTS_ROOT` | `$HOME/.claude/projects` | Claude JSONL 根目录 |
| `PT2_CHAT_UPLOAD_DIR` | `/srv/term-uploads` | 聊天上传目录 |
| `PT2_FILE_SERVE_ROOT` | `/srv/term-uploads` | 文件读取白名单根目录 |
| `PT2_READONLY` | 未设置 | `1` / `true` 启用只读熔断 |
| `PT2_VAPID_SUBJECT` / `PUBLIC_KEY` / `PRIVATE_KEY` | 未设置 | Web Push，三项必须同时存在 |
| `PT2_PAID_GROUP_NAME` | 未设置 | 付费群展示名称 |
| `PT2_PAID_GROUP_PRICE` | 未设置 | 付费群价格文本 |
| `PT2_PAID_GROUP_QR_PATH` | 未设置 | 白名单根目录内的二维码图片路径 |
| `PT2_PAID_GROUP_EXPIRES` | 未设置 | 页面展示的二维码有效期 |

付费群四项变量缺一项时，接口返回 `enabled: false`，页面隐藏入口。二维码必须位于文件读取白名单下，并通过现有图片扩展名、realpath 和 symlink 检查。

## 本地运行

要求：**Node.js >= 20**，以及正在运行且 Unix socket 可读的 herdr server。

```bash
cd /path/to/pocket-term-2
npm ci
# 可选：
# export PT2_HOST=127.0.0.1 PT2_PORT=7690
# export PT2_HERDR_SOCK=$HOME/.config/herdr/herdr.sock
# export PT2_PROJECTS_ROOT=$HOME/.claude/projects
node server.js
# 打开 http://127.0.0.1:7690/herd/
```

对运行中的实例执行冒烟检查：

```bash
PT2_BASE=http://127.0.0.1:7690 ./scripts/smoke.sh
```

## 测试

运行时使用锁定的 `web-push` 依赖，测试使用 Node 内置 test runner：

```bash
node --test test/**/*.test.mjs
# 或
npm test
```

## 可选 Web Push

在部署环境设置 `PT2_VAPID_SUBJECT`、`PT2_VAPID_PUBLIC_KEY` 和 `PT2_VAPID_PRIVATE_KEY`，也可以使用 `scripts/install.sh --with-push`。使用 `scripts/gen-vapid.sh` 生成密钥；不要把密钥提交到 Git。浏览器订阅只写入被忽略的 `state/push-subscriptions.json`。

三项变量不完整时，Web Push 返回 `push_not_configured`，页面原有 banner/徽标回退逻辑继续工作。Service Worker 位于 `/herd/sw.js`，作用域为 `/herd/`，通知直接使用加密 Push payload，不拉取受 Access 保护的 API。

触及 herdr 的 live tests 只使用只读方法：`ping`、`session.snapshot`、`pane.read` 和 `events.*`。

## systemd

Unit 模板是 `systemd/pocket-term-2.service.tmpl`，包含 `__WORKDIR__`、`__HOME__`、`__NODE_PATH__`、`__NODE_BIN__`、`__USER__`、`__GROUP__` 等占位符。优先使用：

```bash
bash scripts/install.sh --port 7690
```

部署和回滚流程见 `docs/ops.md`。

## cloudflared ingress 示例

不要提交私有 hostname。下面只是占位模式：

```yaml
ingress:
  - hostname: term.example.com
    path: ^/herd(/.*)?$
    service: http://127.0.0.1:7690
  - hostname: term.example.com
    path: ^/up$
    service: http://127.0.0.1:7699
  - hostname: term.example.com
    service: http://127.0.0.1:7681
  - service: http_status:404
```

修改配置后先执行配置校验，再按运维 runbook 重启 tunnel，并检查 `/herd/api/state`、既有 `/` 和 `/up`。

## 许可证

本项目使用 **MIT License**，详见 [LICENSE](./LICENSE)。

本项目属于 **pocket-term** 开源产品线（pocket terminal → pocket agent fleet chat）。代码和文档按可发布标准维护，不写入私有域名、token 或本机运行时密钥。
