import express, { type Request, type Response, type NextFunction } from 'express';
import { ZebraRpcClient, sanitizeErrorMessage } from './rpcClient.js';
import type { ConnectionConfig, NodeStatusSummary } from '../shared/types.js';

export const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);

/**
 * Security middleware for the local loopback diagnostic API.
 *
 * Scope and limitations of local API security:
 *
 * 1. Loopback binding (127.0.0.1):
 *    - What it DOES prevent: Restricts the TCP listener to the local loopback interface,
 *      preventing remote network access from the LAN or the public internet.
 *    - Limitation: Does not isolate the service from other processes running locally on the same host.
 *
 * 2. Host header validation:
 *    - What it helps prevent: Mitigates DNS rebinding attacks, where an attacker-controlled
 *      public domain resolves to 127.0.0.1 and causes a victim's browser to send requests
 *      bearing an external Host header (e.g. Host: evil.com).
 *    - Limitation: Host headers can be forged by any local non-browser client.
 *
 * 3. Origin and Sec-Fetch-Site header validation:
 *    - What it can reject:
 *      * Cross-origin requests initiated by web browsers from untrusted websites where the browser
 *        automatically includes an Origin header (such as CORS fetch/XHR, cross-origin form POSTs).
 *      * Browser requests carrying an explicit `Sec-Fetch-Site: cross-site` header.
 *    - What remains outside this protection (IMPORTANT LIMITATIONS):
 *      * Requests without Origin or Sec-Fetch-Site headers are accepted when targeting loopback
 *        Host. This is required because standard web browsers do NOT include an Origin header on
 *        same-origin GET requests (such as frontend navigation or requests proxied by Vite dev server),
 *        and local command-line tools (curl, scripts) do not send these headers.
 *      * Simple cross-origin browser GET requests (e.g., <img src="...">, <script src="...">) do
 *        not always send an Origin header. Although SOP prevents reading JSON responses, and Sec-Fetch-Site
 *        mitigates modern browsers, this middleware alone is NOT a complete or foolproof defense
 *        against all conceivable browser-based cross-origin techniques.
 *      * Any software or local process running on the operator's machine can connect directly to
 *        http://127.0.0.1:3001/ and craft arbitrary HTTP headers, bypassing browser header checks entirely.
 */
export function validateLocalApiSecurity(req: Request, res: Response, next: NextFunction): void {
  // 1. Host header validation: strictly loopback to mitigate DNS rebinding
  const host = req.headers['host'];
  if (!host) {
    res.status(400).json({
      connected: false,
      error: 'Bad Request: Missing Host header.',
      errorType: 'INVALID_CONFIG',
      checkedAt: new Date().toISOString(),
    });
    return;
  }

  const hostPattern = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i;
  if (!hostPattern.test(host)) {
    res.status(403).json({
      connected: false,
      error: 'Forbidden: Invalid Host header. Requests must target loopback.',
      errorType: 'FORBIDDEN',
      checkedAt: new Date().toISOString(),
    });
    return;
  }

  // 2. Reject explicit cross-site browser requests (Sec-Fetch-Site: cross-site)
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site') {
    res.status(403).json({
      connected: false,
      error: 'Forbidden: Cross-site request rejected.',
      errorType: 'FORBIDDEN',
      checkedAt: new Date().toISOString(),
    });
    return;
  }

  // 3. Origin validation: When an Origin header is sent by a browser, verify it matches allowed local origins
  const origin = req.headers['origin'];
  if (origin) {
    if (typeof origin !== 'string' || !ALLOWED_ORIGINS.has(origin)) {
      res.status(403).json({
        connected: false,
        error: 'Forbidden: Request origin is not allowed.',
        errorType: 'FORBIDDEN',
        checkedAt: new Date().toISOString(),
      });
      return;
    }
  }

  next();
}

/**
 * Strict port validator rejecting decimals, non-digits, empty strings, and out-of-range values.
 */
export function validatePortInput(rawPort: unknown): { valid: true; port: number } | { valid: false; error: string } {
  if (rawPort === undefined) {
    return { valid: true, port: 8232 };
  }

  const str = String(rawPort).trim();
  if (str.length === 0) {
    return {
      valid: false,
      error: 'Port cannot be empty. Please specify an integer port between 1 and 65535.',
    };
  }

  // Must be strictly digits (rejects decimals like 8232.5, alphanumeric like 8232abc, negative signs, etc.)
  if (!/^\d+$/.test(str)) {
    return {
      valid: false,
      error: `Invalid port format: "${str}". Port must contain only integer digits without characters or decimals.`,
    };
  }

  const portNum = Number(str);
  if (!Number.isSafeInteger(portNum) || portNum < 1 || portNum > 65535) {
    return {
      valid: false,
      error: `Port ${portNum} is out of range. Port must be an integer between 1 and 65535.`,
    };
  }

  return { valid: true, port: portNum };
}

export function createServer() {
  const app = express();
  app.use(express.json());

  // Apply security validation to all browser-facing /api routes
  app.use('/api', validateLocalApiSecurity);

  // Store active local configuration in-memory (never logged or persisted to disk)
  let activeConfig: ConnectionConfig = {
    host: '127.0.0.1',
    port: 8232,
    cookiePath: undefined,
  };

  let lastStatus: NodeStatusSummary | null = null;

  // Liveness check for z-node backend service
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'z-node-backend',
      timestamp: new Date().toISOString(),
    });
  });

  // Query node status using currently active configuration
  app.get('/api/status', async (_req: Request, res: Response) => {
    try {
      const client = new ZebraRpcClient(activeConfig);
      const status = await client.checkConnection();
      lastStatus = status;
      res.json(status);
    } catch {
      res.status(500).json({
        connected: false,
        error: 'An internal server error occurred while retrieving node status.',
        errorType: 'UNKNOWN',
        endpoint: `http://${activeConfig.host}:${activeConfig.port}/`,
        checkedAt: new Date().toISOString(),
      });
    }
  });

  // Test and update local Zebra connection
  app.post('/api/connect', async (req: Request, res: Response) => {
    const { port, cookiePath } = req.body ?? {};

    // Strict port validation
    const portValidation = validatePortInput(port);
    if (!portValidation.valid) {
      res.status(400).json({
        connected: false,
        error: sanitizeErrorMessage(portValidation.error),
        errorType: 'INVALID_CONFIG',
        endpoint: `http://127.0.0.1:${port ?? 'unknown'}/`,
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    // Validate cookiePath if provided
    let cleanCookiePath: string | undefined = undefined;
    if (typeof cookiePath === 'string' && cookiePath.trim().length > 0) {
      cleanCookiePath = cookiePath.trim();
    }

    const testConfig: ConnectionConfig = {
      host: '127.0.0.1',
      port: portValidation.port,
      cookiePath: cleanCookiePath,
      timeoutMs: 5000,
    };

    try {
      const client = new ZebraRpcClient(testConfig);
      const status = await client.checkConnection();

      // If check completed (even if connection refused or auth failed), update activeConfig
      activeConfig = testConfig;
      lastStatus = status;

      res.json(status);
    } catch {
      res.status(400).json({
        connected: false,
        error: 'Unable to process connection check with the specified configuration.',
        errorType: 'INVALID_CONFIG',
        endpoint: `http://127.0.0.1:${portValidation.port}/`,
        checkedAt: new Date().toISOString(),
      });
    }
  });

  return { app, getActiveConfig: () => ({ ...activeConfig }), getLastStatus: () => lastStatus };
}

// Start server when run directly
const isDirectRun = !process.env.VITEST && process.argv[1]?.includes('server');
if (isDirectRun) {
  const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3001;
  const HOST = '127.0.0.1'; // Security requirement: strictly bind to loopback

  const { app } = createServer();
  app.listen(PORT, HOST, () => {
    console.log(`[z-node] Backend service running on http://${HOST}:${PORT}`);
    console.log(`[z-node] Security boundary: Loopback bound only. Read-only Zebra RPC.`);
  });
}
