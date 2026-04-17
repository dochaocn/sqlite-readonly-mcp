# sqlite-readonly-mcp

在远程 Linux 上运行的 **只读 SQLite** [Model Context Protocol](https://modelcontextprotocol.io) 服务，使用 **Streamable HTTP**（`/mcp`），由 **Bearer Token** 鉴权，查询结果以 **JSON 文本**返回。设计为置于 **Nginx（HTTPS）** 之后，上游仅监听本机。

## 功能

- 工具 `sqlite_query`：单条 `SELECT` / `WITH` / `EXPLAIN`，返回 `{ rows, rowCount }` 的 JSON。
- 工具 `list_tables`：列出非系统表名。
- SQLite：`better-sqlite3` **readonly + fileMustExist**；应用层限制单语句与查询前缀。
- `GET /health`：仅供回环访问，用于探针（见 `src/server.ts`）。
- 传输：**Streamable HTTP**（`/mcp`）+ 旧版 **SSE**（`GET /sse`、`POST /messages`），便于 Cursor 在需要时回退。

## 环境变量


| 变量                | 必填  | 说明                                                              |
| ----------------- | --- | --------------------------------------------------------------- |
| `SQLITE_PATH`     | 是   | 数据库文件绝对路径                                                       |
| `BEARER_TOKEN`    | 是   | 静态 Bearer（也可用 `READONLY_TOKEN`）                                 |
| `HOST`            | 否   | 默认 `127.0.0.1`                                                  |
| `PORT`            | 否   | 默认 `3333`                                                       |
| `ALLOWED_HOSTS`   | 否   | 逗号分隔，允许的 `Host` 头；需包含 Nginx 对外域名。默认 `127.0.0.1,localhost,[::1]` |
| `SQLITE_MAX_ROWS` | 否   | 单次查询最大行数，默认 `5000`                                              |


## 本地构建与运行

```bash
npm install
npm run build
export SQLITE_PATH=/path/to/db.sqlite
export BEARER_TOKEN='your-secret-token'
export ALLOWED_HOSTS='127.0.0.1,localhost'
node dist/server.js
```

开发调试：`npm run dev`

## Nginx 与 systemd

参见 [deploy/nginx.example.conf](deploy/nginx.example.conf)、[deploy/sqlite-readonly-mcp.service](deploy/sqlite-readonly-mcp.service)、[deploy/sqlite-readonly-mcp.env.example](deploy/sqlite-readonly-mcp.env.example)。

要点：向上游传递 `Authorization`、`Accept`、`Content-Type`、`mcp-session-id`；对 SSE/分块响应关闭 `proxy_buffering`。示例中已包含 `**/sse**`、`**/messages**`（旧版 SSE 回退），与 **Streamable HTTP 的 `/mcp`** 一并反代。

### 以 root 用户运行（推荐示例）

为简化 **SQLite 文件及父目录** 的读权限配置，示例 **使用 root** 启动服务（systemd 单元中**不设** `User=` / `Group=`，默认即为 root）。

1. 将代码与构建产物放到例如 `/opt/sqlite-readonly-mcp`，并执行 `npm ci --omit=dev` 与 `npm run build`。
2. 复制环境文件并填写变量：
  ```bash
   sudo cp deploy/sqlite-readonly-mcp.env.example /etc/sqlite-readonly-mcp.env
   sudo chmod 600 /etc/sqlite-readonly-mcp.env
  ```
3. 安装并启用单元（按需修改 `WorkingDirectory`、`ExecStart` 中 `node` 的绝对路径）：
  ```bash
   sudo cp deploy/sqlite-readonly-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now sqlite-readonly-mcp
   sudo systemctl status sqlite-readonly-mcp
  ```

若你曾自行添加 `User=mcp`，删除该行后再 `daemon-reload` 与 `restart`。

**安全提示**：root 进程被攻破时影响面更大，请务必配合 **HTTPS、Bearer、本机监听 + Nginx、防火墙**；若需最小权限，可改回专用用户并单独配置数据文件与路径权限。

## 手动验证（curl）

MCP 要求客户端同时接受 `application/json` 与 `text/event-stream`：

```bash
curl -sS -D - \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' \
  "https://mcp.example.com/mcp"
```

错误 Token 应返回 **401**。

## Cursor 客户端

在 Cursor 的 MCP 设置中为该远程服务配置 **HTTPS URL**（例如 `https://mcp.example.com/mcp`）。若需 **Bearer**，请查阅当前 Cursor 版本是否支持为远程 MCP 配置 **自定义 Header**；若不支持，需在本地增加一层带固定 `Authorization` 的网关（见方案风险说明）。

## 运维

详见 [docs/RUNBOOK.md](docs/RUNBOOK.md)。

## 许可

MIT（与 `@modelcontextprotocol/sdk` 一致；以各依赖许可证为准）。