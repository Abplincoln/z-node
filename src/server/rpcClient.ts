import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  ConnectionConfig,
  ZebraGetInfoResponse,
  ZebraGetBlockchainInfoResponse,
  ZebraGetNetworkInfoResponse,
  ZebraPeerInfo,
  ZebraBestBlockHeightAndHashResponse,
  NodeStatusSummary,
  ConnectionErrorType,
  DiagnosticAvailability,
} from '../shared/types.js';

export class ZebraRpcError extends Error {
  constructor(
    message: string,
    public readonly type: ConnectionErrorType,
    public readonly details?: string,
    public readonly rpcCode?: number
  ) {
    super(message);
    this.name = 'ZebraRpcError';
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export interface EnvironmentContext {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/**
 * Resolves the default Zebra .cookie path for the operating system according to Zebra's documented defaults:
 *
 * - Linux: $XDG_CACHE_HOME/zebra/.cookie when XDG_CACHE_HOME is an absolute path;
 *          otherwise $HOME/.cache/zebra/.cookie.
 * - macOS: $HOME/Library/Caches/zebra/.cookie.
 * - Windows: %LOCALAPPDATA%/zebra/.cookie.
 * - Returns null if required environment variables are unavailable, indicating that
 *   automatic discovery is not possible and the operator must explicitly specify cookiePath.
 *
 * Accepts an optional EnvironmentContext to allow deterministic, platform-independent testing.
 */
export function getDefaultCookiePath(ctx?: EnvironmentContext): string | null {
  const platform = ctx?.platform ?? os.platform();
  const env = ctx?.env ?? process.env;

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) return null;
    return path.win32 ? path.win32.join(localAppData, 'zebra', '.cookie') : path.join(localAppData, 'zebra', '.cookie');
  }

  if (platform === 'darwin') {
    const home = env.HOME?.trim();
    if (!home) return null;
    return path.posix ? path.posix.join(home, 'Library', 'Caches', 'zebra', '.cookie') : path.join(home, 'Library', 'Caches', 'zebra', '.cookie');
  }

  if (platform === 'linux') {
    const xdgCache = env.XDG_CACHE_HOME?.trim();
    if (xdgCache && path.posix.isAbsolute(xdgCache)) {
      return path.posix.join(xdgCache, 'zebra', '.cookie');
    }
    const home = env.HOME?.trim();
    if (!home) return null;
    return path.posix.join(home, '.cache', 'zebra', '.cookie');
  }

  // Fallback for other POSIX-like platforms
  const home = env.HOME?.trim();
  if (!home) return null;
  return path.posix ? path.posix.join(home, '.cache', 'zebra', '.cookie') : path.join(home, '.cache', 'zebra', '.cookie');
}

/**
 * Sanitizes an error message or diagnostic warning to prevent leaking:
 * - Local filesystem paths (Windows or Unix paths)
 * - Cookie contents or credentials
 * - Stack traces or internal source locations
 */
export function sanitizeErrorMessage(msg: unknown): string {
  if (typeof msg !== 'string') {
    return 'An unexpected diagnostic error occurred.';
  }

  // 1. Take the first line (stack traces in Error.prototype.stack appear on subsequent lines)
  let sanitized = msg.split(/\r?\n/)[0]?.trim() ?? '';

  // Remove any trailing stack frame on the single line (e.g. at func (file.ts:1:1))
  sanitized = sanitized.replace(/\s+at\s+(?:[A-Za-z0-9_$.<>]+\s*)?\([^)]+\.[a-zA-Z0-9]+:\d+(?::\d+)?\)$/i, '');
  sanitized = sanitized.replace(/\s+at\s+\S+\.[a-zA-Z0-9]+:\d+(?::\d+)?$/i, '');

  // 2. Remove credentials and cookie values
  sanitized = sanitized.replace(/__cookie__:[a-zA-Z0-9_-]+/gi, '[REDACTED_CREDENTIAL]');
  sanitized = sanitized.replace(/Basic\s+[a-zA-Z0-9+/=]+/gi, '[REDACTED_AUTH]');

  // 3. Redact Windows filesystem paths (e.g. C:\foo\bar or D:/foo/bar)
  sanitized = sanitized.replace(/\b[a-zA-Z]:[\\/][^\s"',;)}\]]+/g, '[REDACTED_PATH]');

  // 4. Redact Unix filesystem paths starting with / (e.g. /var/log/..., /home/..., /etc/...)
  // Avoid redacting protocol slashes like http:// or endpoint paths like http://127.0.0.1:8232/
  sanitized = sanitized.replace(/(^|[\s("':])\/(?:[a-zA-Z0-9_.-]+[\\/])+[a-zA-Z0-9_.-]*/g, '$1[REDACTED_PATH]');
  sanitized = sanitized.replace(/(^|[\s("':])\/(etc|var|home|usr|root|opt|tmp|Users|Library|System)\/[^\s"',;)}\]]*/g, '$1[REDACTED_PATH]');

  return sanitized.trim() || 'An unexpected diagnostic error occurred.';
}

/**
 * Sanitizes error details to ensure no sensitive raw server strings or stack traces are passed.
 */
export function sanitizeErrorDetails(details?: string): string | undefined {
  if (!details) return undefined;
  if (/^HTTP \d{3}( [A-Za-z ]+)?$/.test(details)) {
    return details;
  }
  if (/^RPC code -?\d+$/.test(details)) {
    return details;
  }
  const clean = sanitizeErrorMessage(details);
  return clean || undefined;
}

/**
 * Lightweight runtime validation for Zebra `getinfo` responses.
 * Fails fast if required fields for connection summary are missing or have invalid types.
 */
export function validateGetInfoResponse(data: unknown): ZebraGetInfoResponse {
  if (!isRecord(data)) {
    throw new ZebraRpcError(
      'Invalid getinfo response: Expected a JSON object.',
      'MALFORMED_RESPONSE'
    );
  }

  if (typeof data.version !== 'number') {
    throw new ZebraRpcError(
      'Invalid getinfo response: Missing or non-numeric "version" field.',
      'MALFORMED_RESPONSE'
    );
  }
  if (typeof data.subversion !== 'string') {
    throw new ZebraRpcError(
      'Invalid getinfo response: Missing or non-string "subversion" field.',
      'MALFORMED_RESPONSE'
    );
  }
  if (typeof data.protocolversion !== 'number') {
    throw new ZebraRpcError(
      'Invalid getinfo response: Missing or non-numeric "protocolversion" field.',
      'MALFORMED_RESPONSE'
    );
  }

  if (data.build !== undefined && typeof data.build !== 'string') {
    throw new ZebraRpcError(
      'Invalid getinfo response: "build" field must be a string.',
      'MALFORMED_RESPONSE'
    );
  }
  if (data.blocks !== undefined && typeof data.blocks !== 'number') {
    throw new ZebraRpcError(
      'Invalid getinfo response: "blocks" field must be a number.',
      'MALFORMED_RESPONSE'
    );
  }
  if (data.connections !== undefined && typeof data.connections !== 'number') {
    throw new ZebraRpcError(
      'Invalid getinfo response: "connections" field must be a number.',
      'MALFORMED_RESPONSE'
    );
  }
  if (data.testnet !== undefined && typeof data.testnet !== 'boolean') {
    throw new ZebraRpcError(
      'Invalid getinfo response: "testnet" field must be a boolean.',
      'MALFORMED_RESPONSE'
    );
  }

  return data as unknown as ZebraGetInfoResponse;
}

/**
 * Lightweight runtime validation for Zebra `getblockchaininfo` responses.
 * Validates fields required for blockchain diagnostics.
 */
export function validateGetBlockchainInfoResponse(data: unknown): ZebraGetBlockchainInfoResponse {
  if (!isRecord(data)) {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: Expected a JSON object.',
      'MALFORMED_RESPONSE'
    );
  }

  if (typeof data.chain !== 'string') {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: Missing or non-string "chain" field.',
      'MALFORMED_RESPONSE'
    );
  }
  if (typeof data.blocks !== 'number') {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: Missing or non-numeric "blocks" field.',
      'MALFORMED_RESPONSE'
    );
  }
  if (typeof data.headers !== 'number') {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: Missing or non-numeric "headers" field.',
      'MALFORMED_RESPONSE'
    );
  }
  if (typeof data.bestblockhash !== 'string') {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: Missing or non-string "bestblockhash" field.',
      'MALFORMED_RESPONSE'
    );
  }
  if (typeof data.verificationprogress !== 'number') {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: Missing or non-numeric "verificationprogress" field.',
      'MALFORMED_RESPONSE'
    );
  }

  if (data.estimatedheight !== undefined && typeof data.estimatedheight !== 'number') {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: "estimatedheight" must be a number.',
      'MALFORMED_RESPONSE'
    );
  }
  if (data.size_on_disk !== undefined && typeof data.size_on_disk !== 'number') {
    throw new ZebraRpcError(
      'Invalid getblockchaininfo response: "size_on_disk" must be a number.',
      'MALFORMED_RESPONSE'
    );
  }

  return data as unknown as ZebraGetBlockchainInfoResponse;
}

/**
 * Lightweight runtime validation for Zebra `getpeerinfo` responses.
 * Validates array structure and peer entry properties.
 */
export function validateGetPeerInfoResponse(data: unknown): ZebraPeerInfo[] {
  if (!Array.isArray(data)) {
    throw new ZebraRpcError(
      'Invalid getpeerinfo response: Expected a JSON array of peer entries.',
      'MALFORMED_RESPONSE'
    );
  }

  for (let i = 0; i < data.length; i++) {
    const peer = data[i];
    if (!isRecord(peer)) {
      throw new ZebraRpcError(
        `Invalid peer entry at index ${i}: Expected a JSON object.`,
        'MALFORMED_RESPONSE'
      );
    }
    if (typeof peer.addr !== 'string') {
      throw new ZebraRpcError(
        `Invalid peer entry at index ${i}: Missing or non-string "addr" field.`,
        'MALFORMED_RESPONSE'
      );
    }
    if (typeof peer.inbound !== 'boolean') {
      throw new ZebraRpcError(
        `Invalid peer entry at index ${i}: Missing or non-boolean "inbound" field.`,
        'MALFORMED_RESPONSE'
      );
    }
  }

  return data as ZebraPeerInfo[];
}

export class ZebraRpcClient {
  private readonly host: string;
  private readonly port: number;
  private readonly cookiePath?: string;
  private readonly timeoutMs: number;
  private requestId = 1;

  constructor(config: ConnectionConfig) {
    this.host = config.host.trim();
    this.port = config.port;
    this.cookiePath = config.cookiePath?.trim() || undefined;
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 5000;

    this.validateHost(this.host);
    this.validatePort(this.port);
  }

  private validateHost(host: string): void {
    const normalized = host.toLowerCase();
    if (normalized !== '127.0.0.1' && normalized !== 'localhost' && normalized !== '::1') {
      throw new ZebraRpcError(
        'Security boundary: Connections are restricted to local loopback (127.0.0.1 or localhost) only.',
        'INVALID_CONFIG'
      );
    }
  }

  private validatePort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ZebraRpcError(
        `Invalid port: ${port}. Port must be an integer between 1 and 65535.`,
        'INVALID_CONFIG'
      );
    }
  }

  /**
   * Resolve and load cookie content.
   * Authentication is strictly mandatory: if a cookie cannot be found or read,
   * an error is thrown immediately. Unauthenticated requests are never sent.
   */
  private async resolveCookie(): Promise<string> {
    const targetPath = this.cookiePath || getDefaultCookiePath();

    if (!targetPath) {
      throw new ZebraRpcError(
        'Unable to determine default Zebra .cookie file location because required environment variables are not set. Please provide the explicit cookie file path.',
        'COOKIE_FILE_NOT_FOUND'
      );
    }

    try {
      const content = await fs.readFile(targetPath, 'utf8');
      const trimmed = content.trim();
      if (!trimmed) {
        throw new ZebraRpcError(
          this.cookiePath
            ? 'The specified cookie file is empty.'
            : 'The default cookie file is empty.',
          'COOKIE_READ_ERROR'
        );
      }
      return trimmed;
    } catch (err: unknown) {
      if (err instanceof ZebraRpcError) throw err;
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        const msg = this.cookiePath
          ? 'Specified cookie file not found. If your Zebra node uses a custom rpc.cookie_dir, please verify the path to .cookie.'
          : 'Default Zebra cookie file not found. If your Zebra node uses a custom rpc.cookie_dir, please provide the path to your .cookie file.';
        throw new ZebraRpcError(msg, 'COOKIE_FILE_NOT_FOUND');
      }
      const msg = this.cookiePath
        ? 'Unable to read the specified cookie file.'
        : 'Unable to read the default cookie file.';
      throw new ZebraRpcError(msg, 'COOKIE_READ_ERROR');
    }
  }

  public getEndpointUrl(): string {
    return `http://${this.host}:${this.port}/`;
  }

  /**
   * Execute a single JSON-RPC 2.0 call.
   * Private: Only verified diagnostic wrapper methods are exposed.
   * HTTP redirects are explicitly rejected via redirect: 'error'.
   * The configured timeout covers waiting for HTTP response, receiving the full body, and JSON parsing.
   */
  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    // 1. Resolve cookie first. Fails fast without making an HTTP request if cookie missing.
    const cookie = await this.resolveCookie();
    const endpoint = this.getEndpointUrl();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(cookie).toString('base64')}`,
    };

    const currentRequestId = this.requestId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: currentRequestId,
      method,
      params,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (err: unknown) {
        const error = err as Error;

        if (error.name === 'AbortError' || error.name === 'TimeoutError' || controller.signal.aborted) {
          throw new ZebraRpcError(
            `RPC request to Zebra at ${this.host}:${this.port} timed out after ${this.timeoutMs}ms.`,
            'TIMEOUT',
            'Request timeout'
          );
        }

        const cause = (error as { cause?: Error }).cause;
        const causeMsg = cause?.message || '';

        // Catch redirect rejection from native fetch (redirect: 'error')
        if (
          error.message.toLowerCase().includes('redirect') ||
          causeMsg.toLowerCase().includes('redirect')
        ) {
          throw new ZebraRpcError(
            'RPC request was redirected, which is disallowed for security.',
            'RPC_ERROR',
            'HTTP redirect rejected'
          );
        }

        // Check for connection refused / network error
        const code = (cause as { code?: string })?.code || (error as { code?: string }).code;

        if (code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
          throw new ZebraRpcError(
            `Unable to connect to Zebra node at ${this.host}:${this.port} (Connection Refused). Verify that zebrad is running and [rpc] listen_addr is configured in zebrad.toml.`,
            'CONNECTION_REFUSED',
            'Connection refused'
          );
        }

        throw new ZebraRpcError(
          `Network error communicating with Zebra RPC server at ${this.host}:${this.port}.`,
          'CONNECTION_REFUSED',
          'Network error'
        );
      }

      // Defensive check: If response is a 3xx redirect status code
      if (response.status >= 300 && response.status < 400) {
        throw new ZebraRpcError(
          `Unexpected redirect received from Zebra RPC server (HTTP ${response.status}). Redirects are rejected for security.`,
          'RPC_ERROR',
          `HTTP ${response.status}`
        );
      }

      if (response.status === 401) {
        throw new ZebraRpcError(
          'Authentication failed (401 Unauthorized). Zebra rejected the credentials. Verify that the correct .cookie file path is provided.',
          'AUTH_ERROR',
          'HTTP 401 Unauthorized'
        );
      }

      if (!response.ok) {
        throw new ZebraRpcError(
          `Zebra RPC server returned HTTP ${response.status}.`,
          'RPC_ERROR',
          `HTTP ${response.status}`
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (err: unknown) {
        const error = err as Error;
        if (error.name === 'AbortError' || error.name === 'TimeoutError' || controller.signal.aborted) {
          throw new ZebraRpcError(
            `RPC request to Zebra at ${this.host}:${this.port} timed out after ${this.timeoutMs}ms.`,
            'TIMEOUT',
            'Request timeout'
          );
        }
        throw new ZebraRpcError(
          'Failed to parse JSON response from Zebra RPC server. The server response was not valid JSON.',
          'MALFORMED_RESPONSE'
        );
      }

      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new ZebraRpcError(
          'Invalid JSON-RPC response format: Expected a JSON object.',
          'MALFORMED_RESPONSE'
        );
      }

      const rpcResponse = json as {
        jsonrpc?: unknown;
        id?: unknown;
        result?: unknown;
        error?: unknown;
      };

      // Verify JSON-RPC version
      if (rpcResponse.jsonrpc !== '2.0') {
        throw new ZebraRpcError(
          `Invalid JSON-RPC version: Expected "2.0", received ${JSON.stringify(rpcResponse.jsonrpc)}.`,
          'MALFORMED_RESPONSE'
        );
      }

      // Verify request ID matches
      if (rpcResponse.id !== currentRequestId) {
        throw new ZebraRpcError(
          `Mismatched JSON-RPC response ID: Expected ${currentRequestId}, received ${JSON.stringify(rpcResponse.id)}.`,
          'MALFORMED_RESPONSE'
        );
      }

      // Check for error field
      if (rpcResponse.error !== undefined) {
        if (rpcResponse.result !== undefined) {
          throw new ZebraRpcError(
            'Malformed JSON-RPC response: Contains both result and error fields.',
            'MALFORMED_RESPONSE'
          );
        }
        if (
          !rpcResponse.error ||
          typeof rpcResponse.error !== 'object' ||
          typeof (rpcResponse.error as { code?: unknown }).code !== 'number' ||
          typeof (rpcResponse.error as { message?: unknown }).message !== 'string'
        ) {
          throw new ZebraRpcError(
            'Malformed JSON-RPC error: Expected error object with numeric code and string message.',
            'MALFORMED_RESPONSE'
          );
        }
        const errObj = rpcResponse.error as { code: number; message: string };
        const safeMessage = sanitizeErrorMessage(errObj.message);
        throw new ZebraRpcError(
          `Zebra RPC error (${errObj.code}): ${safeMessage}`,
          'RPC_ERROR',
          `RPC code ${errObj.code}`,
          errObj.code
        );
      }

      // Check for result field
      if (rpcResponse.result === undefined) {
        throw new ZebraRpcError(
          'Zebra RPC response missing both result and error fields.',
          'MALFORMED_RESPONSE'
        );
      }

      return rpcResponse.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Approved read-only diagnostic wrappers with runtime structure validation:
  public async getInfo(): Promise<ZebraGetInfoResponse> {
    const raw = await this.call<unknown>('getinfo');
    return validateGetInfoResponse(raw);
  }

  public async getBlockchainInfo(): Promise<ZebraGetBlockchainInfoResponse> {
    const raw = await this.call<unknown>('getblockchaininfo');
    return validateGetBlockchainInfoResponse(raw);
  }

  public async getNetworkInfo(): Promise<ZebraGetNetworkInfoResponse> {
    return this.call<ZebraGetNetworkInfoResponse>('getnetworkinfo');
  }

  public async getPeerInfo(): Promise<ZebraPeerInfo[]> {
    const raw = await this.call<unknown>('getpeerinfo');
    return validateGetPeerInfoResponse(raw);
  }

  public async getBestBlockHeightAndHash(): Promise<ZebraBestBlockHeightAndHashResponse> {
    return this.call<ZebraBestBlockHeightAndHashResponse>('getbestblockheightandhash');
  }

  /**
   * Performs an end-to-end operational health check against the local Zebra node,
   * measuring RPC latency and aggregating node status safely without exposing credentials or stack traces.
   * Gracefully reports partial diagnostic failures rather than masking them.
   */
  public async checkConnection(): Promise<NodeStatusSummary> {
    const startTime = Date.now();
    const endpoint = this.getEndpointUrl();

    try {
      // 1. Primary liveness and version check: getinfo (fails checkConnection if getinfo fails validation)
      const info = await this.getInfo();
      const rpcLatencyMs = Date.now() - startTime;

      const diagnosticAvailability: DiagnosticAvailability = {
        info: true,
        blockchainInfo: false,
        peerInfo: false,
      };
      const diagnosticWarnings: string[] = [];

      // 2. Query getblockchaininfo for chain height & sync info (degrades gracefully if validation fails)
      let blockchainInfo: ZebraGetBlockchainInfoResponse | null = null;
      try {
        blockchainInfo = await this.getBlockchainInfo();
        diagnosticAvailability.blockchainInfo = true;
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : 'Unknown error';
        diagnosticWarnings.push(`Blockchain diagnostic query failed: ${sanitizeErrorMessage(rawMsg)}`);
      }

      // 3. Query getpeerinfo for detailed peer information (degrades gracefully if validation fails)
      let peerInfo: ZebraPeerInfo[] | null = null;
      try {
        peerInfo = await this.getPeerInfo();
        diagnosticAvailability.peerInfo = true;
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : 'Unknown error';
        diagnosticWarnings.push(`Peer diagnostic query failed: ${sanitizeErrorMessage(rawMsg)}`);
      }

      let inboundPeers: number | null = null;
      let outboundPeers: number | null = null;
      let peerCount: number | null = null;

      if (peerInfo && Array.isArray(peerInfo)) {
        inboundPeers = 0;
        outboundPeers = 0;
        for (const peer of peerInfo) {
          if (peer.inbound) inboundPeers++;
          else outboundPeers++;
        }
        peerCount = peerInfo.length;
      } else if (typeof info.connections === 'number') {
        peerCount = info.connections;
      }

      const blockHeight = blockchainInfo?.blocks ?? (typeof info.blocks === 'number' ? info.blocks : null);
      const headerHeight = blockchainInfo?.headers ?? null;
      const estimatedHeight = blockchainInfo?.estimatedheight ?? null;
      const verificationProgress = blockchainInfo?.verificationprogress ?? null;
      const bestBlockHash = blockchainInfo?.bestblockhash ?? null;
      const sizeOnDisk = blockchainInfo?.size_on_disk ?? null;

      return {
        connected: true,
        error: null,
        errorType: null,
        endpoint,
        checkedAt: new Date().toISOString(),
        diagnosticAvailability,
        diagnosticWarnings: diagnosticWarnings.length > 0 ? diagnosticWarnings : undefined,
        nodeInfo: {
          version: info.subversion || `Zebra (v${info.version})`,
          build: info.build || 'N/A',
          subversion: info.subversion || 'N/A',
          protocolVersion: info.protocolversion,
          network: blockchainInfo?.chain ?? (info.testnet ? 'test' : 'main'),
          blockHeight,
          headerHeight,
          estimatedHeight,
          verificationProgress,
          bestBlockHash,
          peerCount,
          inboundPeers,
          outboundPeers,
          sizeOnDisk,
          rpcLatencyMs,
          warnings: info.errors ? sanitizeErrorMessage(info.errors) : undefined,
        },
      };
    } catch (err: unknown) {
      const now = new Date().toISOString();
      if (err instanceof ZebraRpcError) {
        return {
          connected: false,
          error: sanitizeErrorMessage(err.message),
          errorType: err.type,
          errorDetails: sanitizeErrorDetails(err.details),
          endpoint,
          checkedAt: now,
        };
      }

      return {
        connected: false,
        error: 'An unexpected internal error occurred while communicating with the Zebra node.',
        errorType: 'UNKNOWN',
        endpoint,
        checkedAt: now,
      };
    }
  }
}
