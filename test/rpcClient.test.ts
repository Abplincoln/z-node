import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ZebraRpcClient,
  ZebraRpcError,
  getDefaultCookiePath,
  sanitizeErrorMessage,
  sanitizeErrorDetails,
  validateGetInfoResponse,
  validateGetBlockchainInfoResponse,
  validateGetPeerInfoResponse,
} from '../src/server/rpcClient.js';
import { createServer, validatePortInput, ALLOWED_ORIGINS } from '../src/server/index.js';
import request from 'supertest';

describe('Zebra Cookie Path Resolution Platform Tests', () => {
  it('Linux with valid absolute XDG_CACHE_HOME uses $XDG_CACHE_HOME/zebra/.cookie', () => {
    const resolved = getDefaultCookiePath({
      platform: 'linux',
      env: {
        XDG_CACHE_HOME: '/custom/cache/dir',
        HOME: '/home/testuser',
      },
    });
    expect(resolved).toBe('/custom/cache/dir/zebra/.cookie');
  });

  it('Linux without XDG_CACHE_HOME uses $HOME/.cache/zebra/.cookie', () => {
    const resolved = getDefaultCookiePath({
      platform: 'linux',
      env: {
        HOME: '/home/testuser',
      },
    });
    expect(resolved).toBe('/home/testuser/.cache/zebra/.cookie');
  });

  it('Linux with non-absolute XDG_CACHE_HOME falls back to $HOME/.cache/zebra/.cookie', () => {
    const resolved = getDefaultCookiePath({
      platform: 'linux',
      env: {
        XDG_CACHE_HOME: 'relative/cache/path',
        HOME: '/home/testuser',
      },
    });
    expect(resolved).toBe('/home/testuser/.cache/zebra/.cookie');
  });

  it('macOS default uses $HOME/Library/Caches/zebra/.cookie', () => {
    const resolved = getDefaultCookiePath({
      platform: 'darwin',
      env: {
        HOME: '/Users/testuser',
      },
    });
    expect(resolved).toBe('/Users/testuser/Library/Caches/zebra/.cookie');
  });

  it('Windows default uses %LOCALAPPDATA%/zebra/.cookie', () => {
    const resolved = getDefaultCookiePath({
      platform: 'win32',
      env: {
        LOCALAPPDATA: 'C:\\Users\\testuser\\AppData\\Local',
      },
    });
    expect(resolved).toBe(path.win32 ? path.win32.join('C:\\Users\\testuser\\AppData\\Local', 'zebra', '.cookie') : 'C:\\Users\\testuser\\AppData\\Local\\zebra\\.cookie');
  });

  it('Returns null when required environment variables are missing', () => {
    expect(getDefaultCookiePath({ platform: 'linux', env: {} })).toBeNull();
    expect(getDefaultCookiePath({ platform: 'darwin', env: {} })).toBeNull();
    expect(getDefaultCookiePath({ platform: 'win32', env: {} })).toBeNull();
    expect(getDefaultCookiePath({ platform: 'linux', env: { XDG_CACHE_HOME: '   ' } })).toBeNull();
  });
});

describe('Error Sanitization Unit Tests', () => {
  it('Redacts Windows filesystem paths', () => {
    const input = 'Failed to open file at C:\\Users\\operator\\.cache\\zebra\\.cookie for reading';
    const output = sanitizeErrorMessage(input);
    expect(output).toBe('Failed to open file at [REDACTED_PATH] for reading');
    expect(output).not.toContain('C:\\Users');
  });

  it('Redacts Unix filesystem paths', () => {
    const input = 'Database corruption in /var/lib/zebra/state/v25.db during block import';
    const output = sanitizeErrorMessage(input);
    expect(output).toBe('Database corruption in [REDACTED_PATH] during block import');
    expect(output).not.toContain('/var/lib');
  });

  it('Redacts credentials and cookie tokens', () => {
    const input = 'Authentication header Basic dXNlcjpwYXNz with __cookie__:9876543210abcdef';
    const output = sanitizeErrorMessage(input);
    expect(output).toBe('Authentication header [REDACTED_AUTH] with [REDACTED_CREDENTIAL]');
    expect(output).not.toContain('9876543210abcdef');
    expect(output).not.toContain('dXNlcjpwYXNz');
  });

  it('Strips multiline stack traces and "at ..." frames', () => {
    const input = `Error: Something crashed
    at ZebraRpcClient.call (C:\\Users\\dev\\z-node\\src\\server\\rpcClient.ts:150:10)
    at async ZebraRpcClient.checkConnection (C:\\Users\\dev\\z-node\\src\\server\\rpcClient.ts:320:20)`;
    const output = sanitizeErrorMessage(input);
    expect(output).toBe('Error: Something crashed');
    expect(output).not.toContain('at ZebraRpcClient');
    expect(output).not.toContain('.ts:');
  });

  it('sanitizeErrorDetails safely permits high-level tokens and sanitizes paths', () => {
    expect(sanitizeErrorDetails('HTTP 401 Unauthorized')).toBe('HTTP 401 Unauthorized');
    expect(sanitizeErrorDetails('RPC code -32603')).toBe('RPC code -32603');
    expect(sanitizeErrorDetails('Error at /var/log/zebra.log')).toBe('Error at [REDACTED_PATH]');
    expect(sanitizeErrorDetails(undefined)).toBeUndefined();
  });
});

describe('ZebraRpcClient Unit and Integration Tests', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let receivedAuthHeader: string | undefined;
  let mockRequestCount = 0;
  let mockHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let tempCookieDir: string;
  let tempCookiePath: string;
  let tempEmptyCookiePath: string;

  beforeAll(async () => {
    // Create temporary cookie files for testing
    tempCookieDir = await fs.mkdtemp(path.join(os.tmpdir(), 'znode-test-'));
    tempCookiePath = path.join(tempCookieDir, '.cookie');
    await fs.writeFile(tempCookiePath, '__cookie__:9876543210abcdef', 'utf8');

    tempEmptyCookiePath = path.join(tempCookieDir, '.cookie_empty');
    await fs.writeFile(tempEmptyCookiePath, '   \n  ', 'utf8');

    // Create a mock HTTP server to simulate Zebra JSON-RPC
    mockServer = http.createServer((req, res) => {
      mockRequestCount++;
      receivedAuthHeader = req.headers['authorization'];
      mockHandler(req, res);
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const address = mockServer.address() as { port: number };
        mockPort = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await fs.rm(tempCookieDir, { recursive: true, force: true });
  });

  it('1. Missing custom cookie must fail without making an HTTP request', async () => {
    mockRequestCount = 0;
    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: path.join(tempCookieDir, 'non_existent.cookie'),
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('COOKIE_FILE_NOT_FOUND');
    expect(status.error).toContain('Specified cookie file not found');
    expect(status.error).not.toContain(tempCookieDir); // Must not leak local filesystem path
    expect(mockRequestCount).toBe(0); // Proves no HTTP request was made
  });

  it('2. Missing default cookie must fail without making an HTTP request', async () => {
    mockRequestCount = 0;
    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('COOKIE_FILE_NOT_FOUND');
    expect(mockRequestCount).toBe(0); // Proves no unauthenticated HTTP request was attempted
  });

  it('3. Empty cookie file must fail with COOKIE_READ_ERROR', async () => {
    mockRequestCount = 0;
    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempEmptyCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('COOKIE_READ_ERROR');
    expect(status.error).toContain('empty');
    expect(mockRequestCount).toBe(0);
  });

  it('4. Valid cookie authentication passes verified Basic auth header and loads all diagnostics', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const payload = JSON.parse(body);
        const { method, id } = payload;

        if (method === 'getinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                version: 2010000,
                build: '2.1.0',
                subversion: '/Zebra:2.1.0/',
                protocolversion: 170100,
                blocks: 2500000,
                connections: 12,
                difficulty: 45.67,
                testnet: false,
                errors: '',
              },
            })
          );
        } else if (method === 'getblockchaininfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                chain: 'main',
                blocks: 2500000,
                headers: 2500000,
                bestblockhash: '000000000123456789abcdef0123456789abcdef0123456789abcdef01234567',
                difficulty: 45.67,
                verificationprogress: 0.99999,
                estimatedheight: 2500000,
                size_on_disk: 35000000000,
                commitments: 123456,
              },
            })
          );
        } else if (method === 'getpeerinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: [
                {
                  addr: '198.51.100.1:8233',
                  services: '0000000000000001',
                  lastrecv: 1700000000,
                  inbound: false,
                  banscore: 0,
                  subver: '/Zebra:2.1.0/',
                  version: 170100,
                  connection_state: 'connected',
                  pingtime: 0.045,
                },
                {
                  addr: '198.51.100.2:8233',
                  services: '0000000000000001',
                  lastrecv: 1700000001,
                  inbound: true,
                  banscore: 0,
                  subver: '/MagicBean:5.8.0/',
                  version: 170100,
                  connection_state: 'connected',
                  pingtime: 0.082,
                },
              ],
            })
          );
        } else if (method === 'getnetworkinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                version: 2010000,
                subversion: '/Zebra:2.1.0/',
                protocolversion: 170100,
                localservices: '0000000000000001',
                timeoffset: 0,
                connections: 12,
                networks: [{ name: 'ipv4', limited: false, reachable: true, proxy: '' }],
                relayfee: 0.000001,
                localaddresses: [],
                warnings: '',
              },
            })
          );
        } else if (method === 'getbestblockheightandhash') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                height: 2500000,
                hash: '000000000123456789abcdef0123456789abcdef0123456789abcdef01234567',
              },
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const info = await client.getInfo();
    expect(info.subversion).toBe('/Zebra:2.1.0/');
    expect(info.blocks).toBe(2500000);

    const expectedBase64 = Buffer.from('__cookie__:9876543210abcdef').toString('base64');
    expect(receivedAuthHeader).toBe(`Basic ${expectedBase64}`);

    const status = await client.checkConnection();
    expect(status.connected).toBe(true);
    expect(status.nodeInfo?.version).toBe('/Zebra:2.1.0/');
    expect(status.diagnosticAvailability?.info).toBe(true);
    expect(status.diagnosticAvailability?.blockchainInfo).toBe(true);
    expect(status.diagnosticAvailability?.peerInfo).toBe(true);
  });

  it('5. No unauthenticated fallback occurs', async () => {
    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: '/missing/cookie/file',
    });

    await expect(client.getInfo()).rejects.toThrow(ZebraRpcError);
    await expect(client.getBlockchainInfo()).rejects.toThrow(ZebraRpcError);
  });

  it('6. Invalid JSON-RPC version is rejected with MALFORMED_RESPONSE', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '1.0', id, result: { version: 2010000, subversion: 'Zebra', protocolversion: 170100 } }));
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    await expect(client.getInfo()).rejects.toThrow(/Invalid JSON-RPC version/);
  });

  it('7. Mismatched JSON-RPC request ID is rejected with MALFORMED_RESPONSE', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 999999, result: { version: 2010000, subversion: 'Zebra', protocolversion: 170100 } }));
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    await expect(client.getInfo()).rejects.toThrow(/Mismatched JSON-RPC response ID/);
  });

  it('8. Malformed non-JSON response body is rejected with MALFORMED_RESPONSE', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Bad Gateway</body></html>');
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    await expect(client.getInfo()).rejects.toThrow(ZebraRpcError);
    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('MALFORMED_RESPONSE');
    expect(status.error).toContain('not valid JSON');
  });

  it('9. RPC request timeout triggers when server does not respond in time', async () => {
    mockHandler = (_req, _res) => {
      // Deliberately hang without sending a response to trigger client timeout
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
      timeoutMs: 150, // Short timeout for test speed
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('TIMEOUT');
    expect(status.error).toContain('timed out after 150ms');
    expect(status.errorDetails).toBe('Request timeout');
    expect(status.error).not.toMatch(/(\/|[A-Za-z]:\\).*\.(ts|js)/);
  });

  it('9b. RPC timeout triggers if server sends headers but stalls while sending response body', async () => {
    mockHandler = (_req, res) => {
      // Send HTTP response headers immediately, then send a partial chunk and stall
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"jsonrpc":"2.0",');
      // Intentionally do not call res.end() to stall body streaming
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
      timeoutMs: 150,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('TIMEOUT');
    expect(status.error).toContain('timed out after 150ms');
    expect(status.errorDetails).toBe('Request timeout');
  });

  it('10. Connection refused is handled cleanly when connecting to a closed port', async () => {
    const downClient = new ZebraRpcClient({
      host: '127.0.0.1',
      port: 19876,
      cookiePath: tempCookiePath,
      timeoutMs: 500,
    });

    const status = await downClient.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('CONNECTION_REFUSED');
    expect(status.error).toContain('Connection Refused');
    expect(status.errorDetails).toBe('Connection refused');
    expect(status.error).not.toMatch(/(\/|[A-Za-z]:\\).*\.(ts|js)/);
  });

  it('11. HTTP 401 Unauthorized is handled with AUTH_ERROR', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('AUTH_ERROR');
    expect(status.error).toContain('Authentication failed (401 Unauthorized)');
    expect(status.errorDetails).toBe('HTTP 401 Unauthorized');
  });

  it('11b. Non-OK HTTP response sanitizes status text and hides sensitive server messages', async () => {
    mockHandler = (_req, res) => {
      // Send a 502 with sensitive-looking status message
      res.writeHead(502, 'Bad Gateway - Secret Path /etc/zebra/keys.conf failed', {
        'Content-Type': 'text/plain',
      });
      res.end('Internal secret error');
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('RPC_ERROR');
    expect(status.error).toBe('Zebra RPC server returned HTTP 502.');
    expect(status.errorDetails).toBe('HTTP 502');
    expect(status.error).not.toContain('Secret Path');
    expect(status.error).not.toContain('/etc/zebra');
    expect(status.error).not.toContain('keys.conf');
  });

  it('12. HTTP redirects (301/302) are rejected and never followed', async () => {
    let redirectFollowed = false;

    mockHandler = (req, res) => {
      if (req.url === '/redirect-target') {
        redirectFollowed = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { version: 2010000, subversion: 'Spoofed', protocolversion: 170100 } }));
        return;
      }

      // Return a 302 redirect
      res.writeHead(302, {
        Location: `http://127.0.0.1:${mockPort}/redirect-target`,
      });
      res.end();
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    await expect(client.getInfo()).rejects.toThrow(ZebraRpcError);
    expect(redirectFollowed).toBe(false); // Proves redirect was never followed

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('RPC_ERROR');
    expect(redirectFollowed).toBe(false);
  });

  it('13. Zebra JSON-RPC error containing a fake filesystem path is sanitized', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            error: {
              code: -32603,
              message: 'State lock failure at C:\\ProgramData\\Zebra\\data\\chain.db or /var/lib/zebra/lock',
            },
          })
        );
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('RPC_ERROR');
    expect(status.error).toContain('[REDACTED_PATH]');
    expect(status.error).not.toContain('C:\\ProgramData');
    expect(status.error).not.toContain('/var/lib/zebra');
    expect(status.errorDetails).toBe('RPC code -32603');
  });

  it('14. Secondary diagnostic error containing sensitive text is sanitized in diagnosticWarnings', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        if (payload.method === 'getinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                version: 2010000,
                build: '2.1.0',
                subversion: '/Zebra:2.1.0/',
                protocolversion: 170100,
                blocks: 1000,
                testnet: false,
              },
            })
          );
        } else if (payload.method === 'getblockchaininfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              error: {
                code: -32603,
                message: 'Failed reading secret configuration at /etc/shadow and C:\\Users\\Administrator\\.zebra',
              },
            })
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: [] }));
        }
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(true);
    expect(status.diagnosticAvailability?.blockchainInfo).toBe(false);
    expect(status.diagnosticWarnings?.length).toBe(1);

    const warning = status.diagnosticWarnings![0];
    expect(warning).toContain('[REDACTED_PATH]');
    expect(warning).not.toContain('/etc/shadow');
    expect(warning).not.toContain('C:\\Users\\Administrator');
  });

  it('15. Unexpected internal errors return generic sanitized message and omit errorDetails', async () => {
    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    // Simulate an unexpected runtime exception (e.g. non-ZebraRpcError) inside getInfo
    const originalGetInfo = client.getInfo.bind(client);
    client.getInfo = async () => {
      throw new TypeError('Unexpected internal buffer error at internal/deps/undici/undici.js:42:15');
    };

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('UNKNOWN');
    expect(status.error).toBe('An unexpected internal error occurred while communicating with the Zebra node.');
    expect(status.errorDetails).toBeUndefined();
    expect(status.error).not.toContain('undici');
    expect(status.error).not.toContain('.js:');

    client.getInfo = originalGetInfo;
  });

  it('16. Invalid getinfo response structure fails connection check with MALFORMED_RESPONSE', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Missing "version" and "protocolversion", non-string subversion
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              subversion: 12345, // Invalid type
            },
          })
        );
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.errorType).toBe('MALFORMED_RESPONSE');
    expect(status.error).toContain('Invalid getinfo response');
  });

  it('17. Invalid getblockchaininfo response structure degrades gracefully to null with diagnostic warning', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        if (payload.method === 'getinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                version: 2010000,
                build: '2.1.0',
                subversion: '/Zebra:2.1.0/',
                protocolversion: 170100,
                blocks: 1000,
                connections: 5,
                testnet: false,
              },
            })
          );
        } else if (payload.method === 'getblockchaininfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // Invalid: missing blocks, headers, verificationprogress
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                chain: 'main',
                blocks: 'invalid_string_not_number',
              },
            })
          );
        } else if (payload.method === 'getpeerinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: [] }));
        }
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(true);
    expect(status.diagnosticAvailability?.info).toBe(true);
    expect(status.diagnosticAvailability?.blockchainInfo).toBe(false);
    expect(status.diagnosticWarnings?.length).toBe(1);
    expect(status.diagnosticWarnings?.[0]).toContain('Blockchain diagnostic query failed: Invalid getblockchaininfo response');

    // Blockchain fields must be null (unavailable)
    expect(status.nodeInfo?.headerHeight).toBeNull();
    expect(status.nodeInfo?.verificationProgress).toBeNull();
    expect(status.nodeInfo?.bestBlockHash).toBeNull();
  });

  it('18. Invalid getpeerinfo response structure degrades gracefully to null with diagnostic warning', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        if (payload.method === 'getinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                version: 2010000,
                build: '2.1.0',
                subversion: '/Zebra:2.1.0/',
                protocolversion: 170100,
                blocks: 1000,
                connections: 4,
                testnet: false,
              },
            })
          );
        } else if (payload.method === 'getblockchaininfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                chain: 'main',
                blocks: 1000,
                headers: 1000,
                bestblockhash: 'abc123hash',
                difficulty: 10.0,
                verificationprogress: 0.9999,
              },
            })
          );
        } else if (payload.method === 'getpeerinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // Invalid: expected array, returning an object
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: { error: 'not an array' },
            })
          );
        }
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(true);
    expect(status.diagnosticAvailability?.peerInfo).toBe(false);
    expect(status.diagnosticWarnings?.length).toBe(1);
    expect(status.diagnosticWarnings?.[0]).toContain('Peer diagnostic query failed: Invalid getpeerinfo response');

    // Peer breakdown is unavailable (null)
    expect(status.nodeInfo?.inboundPeers).toBeNull();
    expect(status.nodeInfo?.outboundPeers).toBeNull();
    // Total peer count safely falls back to info.connections
    expect(status.nodeInfo?.peerCount).toBe(4);
  });

  it('19. Missing secondary diagnostic endpoints are reported as unavailable rather than zero', async () => {
    mockHandler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        if (payload.method === 'getinfo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                version: 2010000,
                build: '2.1.0',
                subversion: '/Zebra:2.1.0/',
                protocolversion: 170100,
                blocks: 1000,
                testnet: false,
              },
            })
          );
        } else {
          // getblockchaininfo and getpeerinfo return 500
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              error: { code: -32603, message: 'Endpoint unavailable' },
            })
          );
        }
      });
    };

    const client = new ZebraRpcClient({
      host: '127.0.0.1',
      port: mockPort,
      cookiePath: tempCookiePath,
    });

    const status = await client.checkConnection();
    expect(status.connected).toBe(true);
    expect(status.diagnosticAvailability?.info).toBe(true);
    expect(status.diagnosticAvailability?.blockchainInfo).toBe(false);
    expect(status.diagnosticAvailability?.peerInfo).toBe(false);

    expect(status.nodeInfo?.inboundPeers).toBeNull();
    expect(status.nodeInfo?.outboundPeers).toBeNull();
    expect(status.nodeInfo?.headerHeight).toBeNull();
    expect(status.nodeInfo?.verificationProgress).toBeNull();
  });

  it('20. Security boundary: Client rejects non-loopback hosts and out-of-range ports', () => {
    expect(() => new ZebraRpcClient({ host: '192.168.1.1', port: 8232 })).toThrow(/Security boundary/);
    expect(() => new ZebraRpcClient({ host: '10.0.0.1', port: 8232 })).toThrow(/Security boundary/);
    expect(() => new ZebraRpcClient({ host: '127.0.0.1', port: 0 })).toThrow(/Invalid port/);
    expect(() => new ZebraRpcClient({ host: '127.0.0.1', port: 70000 })).toThrow(/Invalid port/);
  });
});

describe('Port Validation Unit Tests', () => {
  it('21. Malformed port inputs are rejected strictly', () => {
    expect(validatePortInput('8232abc').valid).toBe(false);
    expect(validatePortInput('8232.5').valid).toBe(false);
    expect(validatePortInput('').valid).toBe(false);
    expect(validatePortInput('   ').valid).toBe(false);
    expect(validatePortInput(0).valid).toBe(false);
    expect(validatePortInput(-1).valid).toBe(false);
    expect(validatePortInput(65536).valid).toBe(false);

    // Valid inputs
    expect(validatePortInput(8232)).toEqual({ valid: true, port: 8232 });
    expect(validatePortInput('8232')).toEqual({ valid: true, port: 8232 });
    expect(validatePortInput(undefined)).toEqual({ valid: true, port: 8232 });
  });
});

describe('Standalone Response Validators Unit Tests', () => {
  it('validateGetInfoResponse rejects non-objects and missing required fields', () => {
    expect(() => validateGetInfoResponse(null)).toThrow(/Expected a JSON object/);
    expect(() => validateGetInfoResponse([])).toThrow(/Expected a JSON object/);
    expect(() => validateGetInfoResponse({ subversion: 'Zebra', protocolversion: 170100 })).toThrow(/version/);
    expect(() => validateGetInfoResponse({ version: 'not-a-number', subversion: 'Zebra', protocolversion: 170100 })).toThrow(/version/);
    expect(() => validateGetInfoResponse({ version: 100, protocolversion: 170100 })).toThrow(/subversion/);
    expect(() => validateGetInfoResponse({ version: 100, subversion: 'Zebra' })).toThrow(/protocolversion/);
  });

  it('validateGetBlockchainInfoResponse rejects invalid structure', () => {
    expect(() => validateGetBlockchainInfoResponse(null)).toThrow(/Expected a JSON object/);
    expect(() => validateGetBlockchainInfoResponse({ chain: 'main' })).toThrow(/blocks/);
    expect(() => validateGetBlockchainInfoResponse({ chain: 'main', blocks: 100 })).toThrow(/headers/);
    expect(() => validateGetBlockchainInfoResponse({ chain: 'main', blocks: 100, headers: 100 })).toThrow(/bestblockhash/);
    expect(() => validateGetBlockchainInfoResponse({ chain: 'main', blocks: 100, headers: 100, bestblockhash: 'abc' })).toThrow(/verificationprogress/);
  });

  it('validateGetPeerInfoResponse rejects non-arrays and invalid peer items', () => {
    expect(() => validateGetPeerInfoResponse(null)).toThrow(/Expected a JSON array/);
    expect(() => validateGetPeerInfoResponse({})).toThrow(/Expected a JSON array/);
    expect(() => validateGetPeerInfoResponse([null])).toThrow(/Expected a JSON object/);
    expect(() => validateGetPeerInfoResponse([{ addr: 123, inbound: true }])).toThrow(/addr/);
    expect(() => validateGetPeerInfoResponse([{ addr: '127.0.0.1', inbound: 'not-a-bool' }])).toThrow(/inbound/);
  });
});

describe('Backend Security & Origin Validation Endpoints', () => {
  it('22. Allowed local origins succeed', async () => {
    const { app } = createServer();
    for (const origin of ALLOWED_ORIGINS) {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', origin)
        .set('Host', '127.0.0.1:3001');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    }
  });

  it('23. Disallowed Origin is rejected with 403 Forbidden', async () => {
    const { app } = createServer();
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://evil.com')
      .set('Host', '127.0.0.1:3001');
    expect(res.status).toBe(403);
    expect(res.body.errorType).toBe('FORBIDDEN');
    expect(res.body.error).toContain('origin is not allowed');
  });

  it('24. Cross-site browser request (Sec-Fetch-Site: cross-site) is rejected with 403 Forbidden', async () => {
    const { app } = createServer();
    const res = await request(app)
      .get('/api/health')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Host', '127.0.0.1:3001');
    expect(res.status).toBe(403);
    expect(res.body.errorType).toBe('FORBIDDEN');
    expect(res.body.error).toContain('Cross-site request rejected');
  });

  it('25. Non-loopback Host is rejected with 403 Forbidden (DNS rebinding mitigation)', async () => {
    const { app } = createServer();
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'evil.com');
    expect(res.status).toBe(403);
    expect(res.body.errorType).toBe('FORBIDDEN');
    expect(res.body.error).toContain('Invalid Host header');
  });

  it('26. Requests without Origin (same-origin GET or local CLI) targeting loopback succeed', async () => {
    const { app } = createServer();
    const res = await request(app)
      .get('/api/health')
      .set('Host', '127.0.0.1:3001'); // No Origin header set
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('27. Missing Host header is rejected with 400 Bad Request', async () => {
    const { app } = createServer();
    const res = await request(app)
      .get('/api/health')
      .set('Host', '');
    expect(res.status).toBe(400);
    expect(res.body.errorType).toBe('INVALID_CONFIG');
  });

  it('28. POST /api/connect rejects malformed port input with 400', async () => {
    const { app } = createServer();
    const res = await request(app)
      .post('/api/connect')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Host', '127.0.0.1:3001')
      .send({ port: '8232abc' });
    expect(res.status).toBe(400);
    expect(res.body.errorType).toBe('INVALID_CONFIG');
  });
});
