import React, { useState, useEffect } from 'react';
import type { NodeStatusSummary } from '../shared/types';

export default function App() {
  const [port, setPort] = useState<number>(8232);
  const [cookiePath, setCookiePath] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [status, setStatus] = useState<NodeStatusSummary | null>(null);
  const [backendReachable, setBackendReachable] = useState<boolean | null>(null);

  // Check initial backend health & node connection on mount
  useEffect(() => {
    async function checkInitialStatus() {
      try {
        const healthRes = await fetch('/api/health');
        if (healthRes.ok) {
          setBackendReachable(true);
          const statusRes = await fetch('/api/status');
          if (statusRes.ok) {
            const data: NodeStatusSummary = await statusRes.json();
            setStatus(data);
          }
        } else {
          setBackendReachable(false);
        }
      } catch {
        setBackendReachable(false);
      }
    }
    checkInitialStatus();
  }, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port,
          cookiePath: cookiePath.trim() || undefined,
        }),
      });
      const data: NodeStatusSummary = await res.json();
      setStatus(data);
      setBackendReachable(true);
    } catch (err: unknown) {
      setStatus({
        connected: false,
        error: err instanceof Error ? err.message : 'Failed to reach z-node backend service.',
        errorType: 'UNKNOWN',
        endpoint: `http://127.0.0.1:${port}/`,
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setLoading(false);
    }
  };

  const getErrorHelp = (type: string | null | undefined): string | null => {
    switch (type) {
      case 'CONNECTION_REFUSED':
        return 'Zebra is not responding on this port. Check whether zebrad is running and whether [rpc] listen_addr = "127.0.0.1:8232" is uncommented in zebrad.toml.';
      case 'AUTH_ERROR':
        return 'Cookie authentication failed (HTTP 401). Zebra rejected the credentials. Ensure the correct .cookie file path is provided.';
      case 'COOKIE_FILE_NOT_FOUND':
        return 'Cookie authentication is mandatory, but the .cookie file was not found. Default OS cache paths only cover standard setups. If your node configures a custom rpc.cookie_dir, you must provide its direct path above.';
      case 'COOKIE_READ_ERROR':
        return 'Unable to read the .cookie file. Verify that the file is not empty and that the process has read permissions.';
      case 'TIMEOUT':
        return 'The request timed out after 5000ms. The Zebra node may be overloaded during heavy sync or blocked.';
      case 'MALFORMED_RESPONSE':
        return 'The service returned an invalid JSON-RPC response. Ensure that the specified port belongs to Zebra JSON-RPC and not another service.';
      case 'FORBIDDEN':
        return 'Access denied by local security policy. Requests to the backend API must target loopback with an authorized origin.';
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/60 backdrop-blur px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center font-bold text-amber-400">
              Z
            </div>
            <div>
              <h1 className="font-semibold text-lg text-slate-100 leading-tight">z-node</h1>
              <p className="text-xs text-slate-400">Zebra Node Operational Diagnostics</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 font-mono">Local Node Diagnostics</span>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-slate-800/80 border-slate-700">
              <span
                className={`w-2 h-2 rounded-full ${
                  status?.connected
                    ? 'bg-emerald-400'
                    : backendReachable === false
                    ? 'bg-red-400'
                    : 'bg-amber-400'
                }`}
              />
              <span className="text-slate-300">
                {status?.connected
                  ? 'Zebra Connected'
                  : backendReachable === false
                  ? 'Backend Offline'
                  : 'Zebra Disconnected'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6 space-y-6">
        {/* Backend Warning if offline */}
        {backendReachable === false && (
          <div className="p-4 rounded-lg bg-red-950/40 border border-red-800/60 text-red-200 text-sm">
            <strong className="font-semibold">z-node Backend Offline:</strong> Unable to communicate with the local backend service on <code className="bg-red-900/60 px-1 py-0.5 rounded">127.0.0.1:3001</code>. Please ensure the backend is running.
          </div>
        )}

        {/* Connection Configuration Form */}
        <section className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-200 mb-1">Local Connection Settings</h2>
          <p className="text-xs text-slate-400 mb-5 leading-relaxed">
            z-node communicates directly with your local Zebra node via loopback JSON-RPC. z-node uses Zebra's cookie-based RPC authentication. Credentials stay on your local machine.
          </p>

          <form onSubmit={handleConnect} className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div className="md:col-span-3">
              <label htmlFor="port-input" className="block text-xs font-medium text-slate-300 mb-1.5">
                Local RPC Port
              </label>
              <div className="flex items-center">
                <span className="inline-flex items-center px-3 py-2 text-xs text-slate-400 bg-slate-900 border border-r-0 border-slate-700 rounded-l-lg font-mono">
                  127.0.0.1:
                </span>
                <input
                  id="port-input"
                  type="number"
                  min="1"
                  max="65535"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 text-slate-100 text-xs font-mono rounded-r-lg px-3 py-2 focus:outline-none focus:border-amber-500"
                  placeholder="8232"
                  required
                />
              </div>
            </div>

            <div className="md:col-span-6">
              <label htmlFor="cookie-input" className="block text-xs font-medium text-slate-300 mb-1.5">
                Cookie File Path <span className="text-slate-500 font-normal">(uses default OS path if blank, or custom rpc.cookie_dir)</span>
              </label>
              <input
                id="cookie-input"
                type="text"
                value={cookiePath}
                onChange={(e) => setCookiePath(e.target.value)}
                placeholder="e.g. C:\Users\<Name>\AppData\Local\Zebra\.cookie or custom path"
                className="w-full bg-slate-900 border border-slate-700 text-slate-100 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="md:col-span-3">
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 text-slate-950 font-medium text-xs px-4 py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-3.5 w-3.5 text-slate-950" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Testing...
                  </>
                ) : (
                  'Connect to Zebra'
                )}
              </button>
            </div>
          </form>
        </section>

        {/* Connection Failure Display */}
        {status && !status.connected && (
          <section className="bg-red-950/20 border border-red-800/40 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-red-900/40 border border-red-700/50 flex items-center justify-center text-red-400 font-bold shrink-0">
                !
              </div>
              <div className="space-y-2 flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-red-200">Connection Failed</h3>
                  <span className="text-xs font-mono text-red-400/80 bg-red-950/80 px-2 py-0.5 rounded border border-red-800/50">
                    {status.errorType || 'ERROR'}
                  </span>
                </div>
                <p className="text-xs text-red-300 font-medium">{status.error}</p>
                {getErrorHelp(status.errorType) && (
                  <p className="text-xs text-slate-300 bg-slate-900/60 p-3 rounded-lg border border-slate-800 leading-relaxed">
                    <strong className="text-amber-400">Diagnostic Guidance:</strong> {getErrorHelp(status.errorType)}
                  </p>
                )}
                <div className="text-[11px] text-slate-500 font-mono">
                  Target: {status.endpoint} | Timestamp: {status.checkedAt}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Connection Success Display */}
        {status?.connected && status.nodeInfo && (
          <div className="space-y-6">
            <section className="bg-emerald-950/20 border border-emerald-800/40 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <h2 className="text-sm font-semibold text-emerald-200">Zebra Node Online & Responding</h2>
                </div>
                <span className="text-xs font-mono text-emerald-400/80 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/50">
                  Latency: {status.nodeInfo.rpcLatencyMs}ms
                </span>
              </div>

              {/* Partial Diagnostic Warning Banner if secondary queries failed */}
              {status.diagnosticWarnings && status.diagnosticWarnings.length > 0 && (
                <div className="mb-4 p-3 rounded-lg bg-amber-950/30 border border-amber-800/50 text-amber-200 text-xs space-y-1">
                  <div className="font-semibold flex items-center gap-1.5 text-amber-300">
                    <span>⚠</span> Partial Diagnostic Results (Node responded to getinfo, but secondary queries failed):
                  </div>
                  <ul className="list-disc list-inside text-amber-200/80 text-[11px] space-y-0.5">
                    {status.diagnosticWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Status Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-lg">
                  <div className="text-[11px] text-slate-400 font-medium">Zebra Version</div>
                  <div className="text-sm font-semibold text-slate-100 font-mono mt-0.5 truncate" title={status.nodeInfo.version}>
                    {status.nodeInfo.version}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">
                    Build: {status.nodeInfo.build}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-lg">
                  <div className="text-[11px] text-slate-400 font-medium">Network</div>
                  <div className="text-sm font-semibold text-slate-100 uppercase mt-0.5">
                    {status.nodeInfo.network}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    Protocol: {status.nodeInfo.protocolVersion}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-lg">
                  <div className="text-[11px] text-slate-400 font-medium">Current Block Height</div>
                  <div className="text-sm font-semibold text-amber-400 font-mono mt-0.5">
                    {status.nodeInfo.blockHeight !== null ? status.nodeInfo.blockHeight.toLocaleString() : 'Unavailable'}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    Estimated Tip: {status.nodeInfo.estimatedHeight !== null ? status.nodeInfo.estimatedHeight.toLocaleString() : 'Unavailable'}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-lg">
                  <div className="text-[11px] text-slate-400 font-medium">Peer Connections</div>
                  <div className="text-sm font-semibold text-slate-100 font-mono mt-0.5">
                    {status.nodeInfo.peerCount !== null ? `${status.nodeInfo.peerCount} total` : 'Unavailable'}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    {status.nodeInfo.inboundPeers !== null && status.nodeInfo.outboundPeers !== null
                      ? `${status.nodeInfo.inboundPeers} in / ${status.nodeInfo.outboundPeers} out`
                      : 'Peer details unavailable'}
                  </div>
                </div>
              </div>

              {/* Synchronisation Details */}
              <div className="mt-4 pt-4 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-900/60 p-3.5 rounded-lg border border-slate-800/60">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-slate-400 font-medium">Reported Verification Progress</span>
                    <span className="font-mono text-slate-200">
                      {status.nodeInfo.verificationProgress !== null
                        ? `${(status.nodeInfo.verificationProgress * 100).toFixed(2)}%`
                        : 'Unavailable'}
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                      style={{
                        width: `${
                          status.nodeInfo.verificationProgress !== null
                            ? Math.min(100, Math.max(0, status.nodeInfo.verificationProgress * 100))
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-500 font-mono mt-1.5">
                    <span>Validated Headers: {status.nodeInfo.headerHeight !== null ? status.nodeInfo.headerHeight.toLocaleString() : 'Unavailable'}</span>
                    <span>
                      {status.nodeInfo.verificationProgress === null
                        ? 'Sync progress unavailable'
                        : status.nodeInfo.verificationProgress >= 0.9999
                        ? 'Near estimated tip'
                        : 'Catching up to tip'}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-900/60 p-3.5 rounded-lg border border-slate-800/60 text-xs space-y-1">
                  <div className="text-slate-400 font-medium">Chain State Summary</div>
                  <div className="text-slate-300 text-[11px] font-mono truncate" title={status.nodeInfo.bestBlockHash ?? ''}>
                    Best Block Hash: {status.nodeInfo.bestBlockHash ? `${status.nodeInfo.bestBlockHash.slice(0, 16)}...` : 'Unavailable'}
                  </div>
                  <div className="text-slate-400 text-[11px]">
                    Size on Disk: {status.nodeInfo.sizeOnDisk !== null ? `${(status.nodeInfo.sizeOnDisk / (1024 * 1024 * 1024)).toFixed(2)} GB` : 'Unavailable'}
                  </div>
                  {status.nodeInfo.warnings && (
                    <div className="text-amber-400 text-[11px]">
                      Node Warning: {status.nodeInfo.warnings}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950/40 px-6 py-3 text-center text-xs text-slate-500 font-mono">
        z-node | Read-Only Local Diagnostic Utility for Zebra Nodes
      </footer>
    </div>
  );
}
