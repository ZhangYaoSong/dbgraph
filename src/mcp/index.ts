/**
 * MCP Server
 *
 * Entry point for the MCP server. Wires transport, session, and engine.
 */

import { StdioTransport, SocketTransport } from './transport';
import { MCPSession, MCPSessionOptions } from './session';
import { MCPEngine } from './engine';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { getDaemonSocketPath, getDaemonPidPath } from './transport';

export { MCPEngine } from './engine';

export interface MCPServerOptions {
  projectPath?: string;
  autoRefresh?: boolean;
}

/**
 * MCPServer — manages MCP lifecycle (stdio or daemon mode)
 */
export class MCPServer {
  private engine: MCPEngine;
  private session: MCPSession | null = null;
  private projectPath?: string;
  private autoRefresh: boolean;

  constructor(options: MCPServerOptions = {}) {
    this.engine = new MCPEngine();
    this.projectPath = options.projectPath;
    this.autoRefresh = options.autoRefresh ?? false;
  }

  /**
   * Start MCP server in stdio mode (used by AI agents directly)
   */
  start(): void {
    const transport = new StdioTransport();
    this.session = new MCPSession(transport, this.engine, {
      explicitProjectPath: this.projectPath,
      autoRefresh: this.autoRefresh,
    });
    this.session.start();
  }

  /**
   * Start MCP server as a daemon listening on a Unix socket / named pipe
   */
  async startDaemon(projectRoot: string): Promise<void> {
    const socketPath = getDaemonSocketPath(projectRoot);
    const pidPath = getDaemonPidPath(projectRoot);

    // Ensure .dbgraph dir exists
    const dbgraphDir = path.join(projectRoot, '.dbgraph');
    if (!fs.existsSync(dbgraphDir)) {
      fs.mkdirSync(dbgraphDir, { recursive: true });
    }

    // Clean up stale socket
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    } catch { /* ignore */ }

    // Write PID file
    fs.writeFileSync(pidPath, String(process.pid), 'utf-8');

    return new Promise<void>((resolve) => {
      const server = net.createServer((socket) => {
        const transport = new SocketTransport(socket);
        const session = new MCPSession(transport, this.engine, {
          explicitProjectPath: this.projectPath ?? projectRoot,
          autoRefresh: this.autoRefresh,
        });
        session.start();
      });

      server.listen(socketPath, () => {
        console.error(`DBGraph daemon listening on ${socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the MCP server
   */
  stop(): void {
    this.session?.stop();
    this.engine.stop();
  }
}
