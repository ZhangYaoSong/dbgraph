/**
 * MCP Transport Layer
 *
 * JSON-RPC over stdin/stdout for direct mode (MCP stdio transport).
 * JSON-RPC over Unix sockets / named pipes for daemon mode.
 */

import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// =============================================================================
// Types
// =============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export enum ErrorCodes {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

// =============================================================================
// Transport interface
// =============================================================================

export interface JsonRpcTransport {
  start(handler: (message: JsonRpcMessage) => void): void;
  sendResult(id: number | string, result: unknown): void;
  sendError(id: number | string, code: number, message: string, data?: unknown): void;
  sendNotification(method: string, params?: unknown): void;
  stop(): void;
}

// =============================================================================
// Stdio Transport (direct MCP mode)
// =============================================================================

export class StdioTransport implements JsonRpcTransport {
  private handler: ((message: JsonRpcMessage) => void) | null = null;
  private buffer = '';
  private stopped = false;

  start(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
    process.stdin.on('data', this.onData);
    process.stdin.on('end', this.onEnd);
    process.stdin.setEncoding('utf-8');
  }

  private onData = (chunk: string): void => {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        this.handler?.(message);
      } catch {
        this.sendError(0, ErrorCodes.ParseError, 'Failed to parse JSON');
      }
    }
  };

  private onEnd = (): void => {
    this.stopped = true;
  };

  sendResult(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  sendError(id: number | string, code: number, message: string, data?: unknown): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  sendNotification(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params } as JsonRpcNotification);
  }

  stop(): void {
    this.stopped = true;
    process.stdin.removeListener('data', this.onData);
    process.stdin.removeListener('end', this.onEnd);
  }

  private write(msg: JsonRpcResponse | JsonRpcNotification): void {
    if (this.stopped) return;
    const raw = JSON.stringify(msg) + '\n';
    process.stdout.write(raw);
  }
}

// =============================================================================
// Socket Transport (daemon mode)
// =============================================================================

export class SocketTransport implements JsonRpcTransport {
  private socket: net.Socket;
  private handler: ((message: JsonRpcMessage) => void) | null = null;
  private buffer = '';
  private stopped = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
  }

  start(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
    this.socket.on('data', this.onData);
    this.socket.on('close', this.onClose);
    this.socket.setEncoding('utf-8');
  }

  private onData = (chunk: string): void => {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        this.handler?.(message);
      } catch {
        this.sendError(0, ErrorCodes.ParseError, 'Failed to parse JSON');
      }
    }
  };

  private onClose = (): void => {
    this.stopped = true;
  };

  sendResult(id: number | string, result: unknown): void {
    if (!this.stopped) this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  sendError(id: number | string, code: number, message: string, data?: unknown): void {
    if (!this.stopped) this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }) + '\n');
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.stopped) this.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  stop(): void {
    this.stopped = true;
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('close', this.onClose);
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

// =============================================================================
// Daemon path utilities
// =============================================================================

export function getDaemonSocketPath(projectRoot: string): string {
  const dir = path.join(projectRoot, '.dbgraph');
  // Use a hash to avoid path-length issues on Windows
  const hash = Buffer.from(projectRoot).toString('base64').replace(/[/+=]/g, '_');
  return os.platform() === 'win32'
    ? path.join(dir, `dbgraph-${hash}.pipe`)
    : path.join(dir, `dbgraph-${hash}.sock`);
}

export function getDaemonPidPath(projectRoot: string): string {
  return path.join(projectRoot, '.dbgraph', 'daemon.pid');
}
