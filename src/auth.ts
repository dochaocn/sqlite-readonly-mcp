import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** 返回 Express 中间件：`Authorization: Bearer <token>` 与配置一致才 next；比较用时序安全避免旁路。 */
export function requireBearerToken(expectedToken: string) {
  const expectedBuf = Buffer.from(expectedToken, 'utf8');

  return function bearerAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing or invalid Authorization header' },
        id: null
      });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    const tokenBuf = Buffer.from(token, 'utf8');
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid bearer token' },
        id: null
      });
      return;
    }
    next();
  };
}
