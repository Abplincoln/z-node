// Shared TypeScript types for z-node

export interface ConnectionConfig {
  host: string;
  port: number;
  cookiePath?: string;
  timeoutMs?: number;
}

export interface ZebraGetInfoResponse {
  version: number;
  build: string;
  subversion: string;
  protocolversion: number;
  blocks: number;
  connections: number;
  proxy?: string;
  difficulty: number;
  testnet: boolean;
  paytxfee?: number;
  relayfee?: number;
  errors?: string;
}

export interface ZebraGetBlockchainInfoResponse {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  verificationprogress: number;
  chainwork?: string | number;
  pruned?: boolean;
  size_on_disk?: number;
  commitments?: number;
  estimatedheight?: number;
}

export interface ZebraNetworkDetail {
  name: string;
  limited: boolean;
  reachable: boolean;
  proxy: string;
  proxy_randomize_credentials?: boolean;
}

export interface ZebraLocalAddress {
  address: string;
  port: number;
  score: number;
}

export interface ZebraGetNetworkInfoResponse {
  version: number;
  subversion: string;
  protocolversion: number;
  localservices: string;
  timeoffset: number;
  connections: number;
  networks: ZebraNetworkDetail[];
  relayfee: number;
  localaddresses: ZebraLocalAddress[];
  warnings: string;
}

export interface ZebraPeerInfo {
  addr: string;
  services: string;
  lastrecv: number;
  inbound: boolean;
  banscore: number;
  subver: string;
  version: number;
  connection_state: string;
  pingtime?: number;
  pingwait?: number;
}

export interface ZebraBestBlockHeightAndHashResponse {
  height: number;
  hash: string;
}

export type ConnectionErrorType =
  | 'AUTH_ERROR'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'COOKIE_FILE_NOT_FOUND'
  | 'COOKIE_READ_ERROR'
  | 'INVALID_CONFIG'
  | 'RPC_ERROR'
  | 'FORBIDDEN'
  | 'UNKNOWN';

export interface DiagnosticAvailability {
  info: boolean;
  blockchainInfo: boolean;
  peerInfo: boolean;
}

export interface NodeStatusSummary {
  connected: boolean;
  error: string | null;
  errorType: ConnectionErrorType | null;
  errorDetails?: string;
  endpoint: string;
  checkedAt: string;
  diagnosticAvailability?: DiagnosticAvailability;
  diagnosticWarnings?: string[];
  nodeInfo?: {
    version: string;
    build: string;
    subversion: string;
    protocolVersion: number;
    network: string;
    blockHeight: number | null;
    headerHeight: number | null;
    estimatedHeight: number | null;
    verificationProgress: number | null;
    bestBlockHash: string | null;
    peerCount: number | null;
    inboundPeers: number | null;
    outboundPeers: number | null;
    sizeOnDisk: number | null;
    rpcLatencyMs: number;
    warnings?: string;
  };
}
