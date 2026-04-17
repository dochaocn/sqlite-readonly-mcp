# sqlite-readonly-mcp 运维说明

## 部署摘要

- 进程仅监听 `HOST`（默认 `127.0.0.1`）与 `PORT`，公网由 Nginx 终止 TLS 并反代到 `/mcp`。
- 鉴权：MCP 进程校验 `Authorization: Bearer <BEARER_TOKEN>`；Nginx 不校验 Token，但须**原样转发** `Authorization`。
- 数据：`SQLITE_PATH` 指向的库以 **只读** 打开；系统用户对该文件需有读权限。

## Token 轮换

1. 生成新 Token（足够长度与熵）。
2. 更新环境文件（如 `/etc/sqlite-readonly-mcp.env`）中的 `BEARER_TOKEN`。
3. `systemctl restart sqlite-readonly-mcp`（或等价方式）。
4. 通知所有 Cursor/客户端配置更新；旧 Token 立即失效。
5. 审计日志中确认无异常 401 激增。

密钥文件权限建议：`chmod 600 /etc/sqlite-readonly-mcp.env`，属主为运行服务的用户。

## 日志与排障


| 现象                     | 可能原因                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| **401**                | Token 错误、缺失 `Authorization`、客户端未带 Bearer。                               |
| **403 Invalid Host**   | `Host` 不在 `ALLOWED_HOSTS`；将 Nginx 对外的 `server_name` 加入 `ALLOWED_HOSTS`。 |
| **406 Not Acceptable** | 客户端未同时接受 `application/json` 与 `text/event-stream`；检查 `Accept` 头。        |
| **502/504**            | 上游未启动、端口错、Nginx 超时过短；长查询可调大 `proxy_read_timeout`。                       |


不要在访问日志中打印完整 `Authorization` 行。

## 备份

- 只读服务不修改库文件；备份仍按业务 RPO/RTO 对 `.sqlite` 做快照或文件级备份即可。

## 健康检查

- `GET /health` 仅允许来自回环地址（见应用实现）。生产可用 **内网 curl** 或 **Nginx `location /health` 限制 allow 127.0.0.1**。