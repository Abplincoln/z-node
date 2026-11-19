# z-node

**z-node** is a lightweight, local, read-only operational diagnostic utility for [Zebra](https://github.com/ZcashFoundation/zebra) Zcash full nodes.

It allows node operators to inspect node synchronization, chain height, network status, and peer connectivity over local JSON-RPC.

---

## Capabilities & RPC Methods

### Actively Queried by Application
During connection checks and diagnostic polling, the application queries:
- **`getinfo`**: Node version, build info, protocol version, and basic connection count.
- **`getblockchaininfo`**: Current block height, headers, estimated chain height, verification progress, and disk footprint.
- **`getpeerinfo`**: Peer connection details, inbound and outbound peer distribution.

### Additional Client Wrappers
The underlying TypeScript RPC client also implements typed wrappers for:
- **`getnetworkinfo`**: Network and subversion details.
- **`getbestblockheightandhash`**: Most recent block height and hash.

All queries are strictly read-only; no wallet, transaction transmission, or state-modifying operations are supported.

---

## Architecture

```
[Browser / Desktop UI] (http://127.0.0.1:5173)
        │
        │ HTTP loopback requests (/api)
        ▼
  [Vite Dev Server Proxy]
        │
        │ Proxied to backend (127.0.0.1:3001)
        ▼
[z-node Express Backend]
  ├── Local Security Middleware (Loopback check, Host & Origin validation)
  ├── Strict Input Validator (Port range & cookie path format)
  └── Zebra RPC Client
        │
        │ HTTP JSON-RPC 2.0 with HTTP Basic Cookie Authentication
        ▼
  [Local Zebra Node (zebrad)] (127.0.0.1:8232)
```

---

## Zebra Configuration & Cookie Authentication

### Enabling Zebra RPC
Zebra disables its JSON-RPC server by default. The operator must explicitly configure and enable it in `zebrad.toml`:

```toml
[rpc]
listen_addr = "127.0.0.1:8232"
# Optional custom cookie directory:
# cookie_dir = "/path/to/custom/dir"
```

### Cookie Authentication
When RPC is enabled, Zebra uses cookie-based authentication by default. It writes a temporary token to a `.cookie` file. **z-node** automatically checks standard OS cache locations:
- **Linux:** `$XDG_CACHE_HOME/zebra/.cookie` (or `~/.cache/zebra/.cookie`)
- **macOS:** `~/Library/Caches/zebra/.cookie`
- **Windows:** `%LOCALAPPDATA%\zebra\.cookie`

If your node uses a custom `rpc.cookie_dir`, enter the exact file path to `.cookie` directly in the connection form.

---

## Local Security Boundary & Limitations

- **Loopback Binding:** The backend listener binds strictly to `127.0.0.1`, preventing access from external networks.
- **Host Validation:** Requests are validated against `127.0.0.1` and `localhost` to mitigate browser DNS rebinding attacks.
- **Origin Validation:** Cross-site browser requests carrying external `Origin` or `Sec-Fetch-Site: cross-site` headers are rejected.
- **Limitations:** These protections guard against unauthorized remote and browser-based cross-site requests. They do not isolate against other non-browser software running locally under the same operating system user, nor can they prevent local processes from connecting directly to loopback with custom headers.

---

## Installation & Running

### Prerequisites
- Node.js v20+ (tested on Node v24)
- npm v10+

### Setup
```bash
git clone <repository-url>
cd z-node
npm install
```

### Development Workflow
The standard workflow runs both the backend service and the frontend client concurrently:

```bash
npm run dev
```
- Frontend UI: `http://127.0.0.1:5173`
- Backend API: `http://127.0.0.1:3001`

To run either service separately:
- `npm run dev:server` (Express backend via `tsx watch`)
- `npm run dev:client` (Vite dev server)

*Note on `npm start`:* The `npm start` script runs only the compiled backend service (`node dist-server/server/index.js`). It does not serve frontend static assets. For local application use, use `npm run dev`.

---

## Verification & Automated Tests

Run the Vitest test suite and TypeScript type checks:

```bash
# Run automated tests
npm test

# Type-check client and server
npm run typecheck

# Verify production build
npm run build
```

> **Testing Scope Notice:** All 44 automated tests pass using a controlled in-memory mock Zebra RPC server. No live integration test with a running `zebrad` instance was performed on the development machine.

---

## License

This project is open-source software licensed under the MIT License. See [LICENSE](LICENSE) for details.
