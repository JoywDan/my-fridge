# 🧊 囡囡的冰箱

不知道烧什么菜的时候用的小程序：管理冰箱库存、收藏菜谱、生成一周菜单，还有 Echo 陪聊。

## ✨ v2 新功能

- **📷 扫单入库**：超市买完东西拍一张小票，或者网购订单/购物车截图，Claude 自动识别里面的食品（自动忽略纸巾洗洁精这种），翻译成中文常用名，勾选确认后直接入库。再也不用手动一样样输了。
- **🤖 接入 Claude Code**：AI 菜谱生成和 Echo 聊天不再走第三方中转 API，改为调用你自己服务器上的 `claude -p`（Claude Code 无头模式）。用 Claude 订阅登录，不需要按 token 付费的 API Key。

## 架构

```
手机上的 PWA (index.html)
        │  HTTP + 口令
        ▼
server.js（你的服务器，零依赖 Node 脚本）
        │  spawn
        ▼
claude -p（Claude Code CLI，订阅账号登录）
```

`server.js` 提供两个接口：

| 接口 | 作用 |
|------|------|
| `POST /api/chat` | Echo 聊天 + AI 菜谱生成（带人设和对话历史） |
| `POST /api/scan` | 接收小票/截图（base64），Claude 用 Read 工具看图，返回食材 JSON 清单 |

它同时也把 `index.html` 等静态文件服务出来，所以直接访问 `http://服务器:7777` 就能用整个应用（前端继续放 GitHub Pages 也行，接口有 CORS 支持）。

## 部署（服务器端）

前提：Node 18+，装好并登录了 [Claude Code](https://code.claude.com/docs/en/overview)：

```bash
npm install -g @anthropic-ai/claude-code
claude   # 第一次运行，用你的 Claude 订阅账号登录
```

然后启动后端：

```bash
git clone https://github.com/JoywDan/my-fridge.git
cd my-fridge
FRIDGE_TOKEN=换成一串很长的随机口令 node server.js
```

想常驻的话用 systemd：

```ini
# /etc/systemd/system/my-fridge.service
[Unit]
Description=My Fridge backend
After=network.target

[Service]
WorkingDirectory=/path/to/my-fridge
Environment=FRIDGE_TOKEN=换成一串很长的随机口令
ExecStart=/usr/bin/node server.js
Restart=always
User=你的用户名

[Install]
WantedBy=multi-user.target
```

可选环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `FRIDGE_TOKEN` | 空（⚠️不安全） | 访问口令，前端填同一个 |
| `PORT` | 7777 | 监听端口 |
| `CLAUDE_MODEL` | sonnet | 聊天/菜谱模型（可改 haiku 更快） |
| `CLAUDE_SCAN_MODEL` | 同上 | 识别小票的模型 |
| `CLAUDE_BIN` | claude | claude 命令路径 |

## 前端配置

打开应用 → 菜谱页 → 「🤖 Echo帮我想菜谱」→ 填一次**后端地址**（如 `http://1.2.3.4:7777`）和**访问口令**，之后扫单、菜谱生成、Echo 聊天就都通了。

> 💡 如果前端放在 GitHub Pages（https），浏览器会拦截对 http 后端的请求（mixed content），建议给后端套个域名 + HTTPS（Caddy 一行配置），或者干脆直接用 `http://服务器:7777` 打开应用并添加到主屏幕。

## 安全提醒

- 一定要设置 `FRIDGE_TOKEN`，否则任何知道地址的人都能调用你的 Claude 额度。
- 后端调用 Claude 时：聊天接口不开任何工具，扫单接口只允许 `Read`，不会执行命令或改文件。
