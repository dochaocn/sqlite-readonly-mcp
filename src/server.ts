import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import Database from 'better-sqlite3';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { requireBearerToken } from './auth.js';
import { assertReadOnlySql } from './sql.js';

/** 从环境变量读取运行配置；缺 SQLITE_PATH 或 Bearer 令牌时抛错。 */
function loadConfig() {
  const sqlitePath = process.env.SQLITE_PATH; // 必填：SQLite 文件路径
  const bearerToken = process.env.BEARER_TOKEN ?? process.env.READONLY_TOKEN; // 必填：HTTP Bearer
  const port = parseInt(process.env.PORT ?? '3333', 10);
  const bindHost = process.env.HOST ?? '127.0.0.1';
  const maxRows = parseInt(process.env.SQLITE_MAX_ROWS ?? '5000', 10); // 单次查询最大行数
  const allowedHostsEnv = process.env.ALLOWED_HOSTS; // 可选：Host 头白名单

  if (!sqlitePath) {
    throw new Error('SQLITE_PATH is required');
  }
  if (!bearerToken) {
    throw new Error('BEARER_TOKEN (or READONLY_TOKEN) is required');
  }

  // Host 校验白名单：逗号分隔；未设则仅允许本机常见 loopback 名
  const allowedHosts =
    allowedHostsEnv
      ?.split(',')
      .map(s => s.trim())
      .filter(Boolean) ?? ['127.0.0.1', 'localhost', '[::1]'];

  return { sqlitePath, bearerToken, port, bindHost, maxRows, allowedHosts };
}

/** 注册 MCP 工具（只读查询、列表明），并与给定 DB / 行数上限绑定。 */
function createMcpServer(db: Database.Database, maxRows: number) {
  const server = new McpServer(
    {
      name: 'sqlite-readonly-mcp',
      version: '1.0.0'
    },
    { capabilities: {} }
  );

  server.registerTool(
    'sqlite_query',
    {
      description:
        'Execute a single read-only SQL query (SELECT, WITH, or EXPLAIN). Returns rows as JSON text.',
      inputSchema: {
        sql: z.string().describe('Single SELECT / WITH / EXPLAIN statement')
      }
    },
    async ({ sql }) => {
      assertReadOnlySql(sql);
      const stmt = db.prepare(sql); // 只读连接 + 上文断言，避免写操作
      const rows = stmt.all();
      const list = rows as Record<string, unknown>[];
      if (list.length > maxRows) {
        throw new Error(`Result has ${list.length} rows; limit is ${maxRows} (set SQLITE_MAX_ROWS)`);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ rows: list, rowCount: list.length })
          }
        ]
      };
    }
  );

  server.registerTool(
    'list_tables',
    {
      description: 'List user tables in the database (convenience over sqlite_master).',
      inputSchema: {}
    },
    async () => {
      const sql =
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
      const stmt = db.prepare(sql);
      const rows = stmt.all() as { name: string }[];
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tables: rows.map(r => r.name) })
          }
        ]
      };
    }
  );

  return server;
}

type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;

/** 禁用反向代理缓冲，保证 MCP 流式/SSE 及时下发。 */
function disableAccelBuffering(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Accel-Buffering', 'no');
  next();
}

/** 判断请求体（单对象或 JSON-RPC 批）是否含 initialize，用于新建 Streamable 会话。 */
function bodyContainsInitializeRequest(body: unknown): boolean {
  if (body === null || body === undefined) {
    return false;
  }
  if (Array.isArray(body)) {
    return body.some(item => isInitializeRequest(item));
  }
  return isInitializeRequest(body);
}

async function main() {
  const { sqlitePath, bearerToken, port, bindHost, maxRows, allowedHosts } = loadConfig();

  // 只读打开；文件必须已存在，避免隐式创建库
  const db = new Database(sqlitePath, {
    readonly: true,
    fileMustExist: true
  });

  const bearerMiddleware = requireBearerToken(bearerToken);

  // MCP 官方 Express 封装：Host 头校验用 allowedHosts；非全网监听时内部 host 固定为 127.0.0.1
  const app = createMcpExpressApp({
    host: bindHost === '0.0.0.0' || bindHost === '::' ? bindHost : '127.0.0.1',
    allowedHosts
  });

  /** 进程内 sessionId → 传输实例（Streamable HTTP 与旧版 SSE 共用） */
  const transports: Record<string, AnyTransport> = {};

  /** 切到纯 SSE 前关闭所有 Streamable 连接，避免混用两种协议。 */
  async function closeAllStreamableTransports(): Promise<void> {
    const ids = Object.keys(transports);
    for (const id of ids) {
      const t = transports[id];
      if (t instanceof StreamableHTTPServerTransport) {
        delete transports[id];
        try {
          await t.close();
        } catch {}
      }
    }
  }

  app.get('/health', (req, res) => {
    const ip = req.socket.remoteAddress;
    const local =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === undefined;
    if (!local) {
      res.status(403).json({ error: 'health only available from loopback' });
      return;
    }
    res.json({ status: 'ok', service: 'sqlite-readonly-mcp' });
  });

  // Streamable HTTP：GET 走 SSE 升级；POST 带会话则复用 transport，无会话且 body 为 initialize 则新建
  app.all('/mcp', bearerMiddleware, disableAccelBuffering, async (req: Request, res: Response) => {
    try {
      const rawSession = req.headers['mcp-session-id'];
      const sessionId =
        typeof rawSession === 'string' ? rawSession.trim() : undefined;

      // 无 session：GET 即 legacy 兼容——在 /mcp 上直接挂 SSE
      if (!sessionId && req.method === 'GET') {
        await closeAllStreamableTransports();
        const sseTransport = new SSEServerTransport('/messages', res);
        const sseSid = sseTransport.sessionId;
        transports[sseSid] = sseTransport;
        res.on('close', () => {
          delete transports[sseSid];
        });
        const sseServer = createMcpServer(db, maxRows);
        await sseServer.connect(sseTransport);
        return;
      }

      let transport: StreamableHTTPServerTransport | undefined;

      // 已有 Streamable 会话：继续 handleRequest
      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (existing instanceof StreamableHTTPServerTransport) {
          transport = existing;
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: Session exists but uses a different transport protocol'
            },
            id: null
          });
          return;
        }
      } else if (sessionId && !transports[sessionId]) {
        // 多 worker / 非粘性负载下会话在别进程：无法续用
        console.error(
          'MCP /mcp: session not in this process; use a single Node worker or sticky upstream (ip_hash)'
        );
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found'
          },
          id: null
        });
        return;
      } else if (
        !sessionId &&
        req.method === 'POST' &&
        bodyContainsInitializeRequest(req.body)
      ) {
        // 首次 POST + initialize：创建 Streamable 传输并在回调里登记 sessionId
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          onsessioninitialized: (id: string) => {
            transports[id] = transport!;
          }
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };
        const server = createMcpServer(db, maxRows);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided'
          },
          id: null
        });
        return;
      }

      // 后续 JSON-RPC：交给 SDK  transport
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP /mcp error:', e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  // 旧版路径：GET /sse 建 SSE，客户端再 POST /messages?sessionId=…
  app.get('/sse', bearerMiddleware, disableAccelBuffering, async (req: Request, res: Response) => {
    try {
      await closeAllStreamableTransports();
      const transport = new SSEServerTransport('/messages', res);
      const sseSid = transport.sessionId;
      transports[sseSid] = transport;
      res.on('close', () => {
        delete transports[sseSid];
      });
      const server = createMcpServer(db, maxRows);
      await server.connect(transport);
    } catch (e) {
      console.error('MCP /sse error:', e);
      if (!res.headersSent) {
        res.status(500).end('Internal server error');
      }
    }
  });

  app.post('/messages', bearerMiddleware, async (req: Request, res: Response) => {
    try {
      const q = req.query.sessionId;
      const sid = Array.isArray(q) ? q[0] : q;
      if (!sid || typeof sid !== 'string') {
        res.status(400).send('Missing sessionId');
        return;
      }
      const existing = transports[sid];
      if (!existing) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32002,
            message: 'Session not found or expired'
          },
          id: null
        });
        return;
      }
      if (existing instanceof SSEServerTransport) {
        await existing.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Session exists but uses a different transport protocol'
          },
          id: null
        });
      }
    } catch (e) {
      console.error('MCP /messages error:', e);
      if (!res.headersSent) {
        res.status(500).end('Internal server error');
      }
    }
  });

  app.listen(port, bindHost, () => {
    console.error(
      `sqlite-readonly-mcp listening on http://${bindHost}:${port} (Streamable: /mcp, legacy SSE: GET /sse, POST /messages)`
    );
  });

  const shutdown = async () => {
    // 优雅退出：关传输再关 DB
    for (const id of Object.keys(transports)) {
      try {
        await transports[id].close();
      } catch {}
      delete transports[id];
    }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
