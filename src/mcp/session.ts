/**
 * MCP Session
 *
 * Manages a single MCP session — handles initialization, tool listing,
 * and tool call dispatching.
 */

import {
  JsonRpcTransport, JsonRpcRequest, JsonRpcNotification,
  ErrorCodes, JsonRpcMessage,
} from './transport';
import { MCPEngine } from './engine';

export interface MCPSessionOptions {
  explicitProjectPath?: string;
  autoRefresh?: boolean;
}

export class MCPSession {
  private clientSupportsRoots = false;
  private rootsAttempted = false;
  private explicitProjectPath: string | null;
  private watchConfig: boolean;

  constructor(
    private transport: JsonRpcTransport,
    private engine: MCPEngine,
    opts: MCPSessionOptions = {},
  ) {
    this.explicitProjectPath = opts.explicitProjectPath ?? null;
    this.watchConfig = opts.autoRefresh ?? false;
  }

  start(): void {
    this.transport.start(this.handleMessage.bind(this));
  }

  stop(): void {
    this.transport.stop();
  }

  getTransport(): JsonRpcTransport {
    return this.transport;
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    const isRequest = 'id' in message;
    switch (message.method) {
      case 'initialize':
        if (isRequest) await this.handleInitialize(message as JsonRpcRequest);
        break;
      case 'initialized':
        break;
      case 'tools/list':
        if (isRequest) await this.handleToolsList(message as JsonRpcRequest);
        break;
      case 'tools/call':
        if (isRequest) await this.handleToolsCall(message as JsonRpcRequest);
        break;
      case 'ping':
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, {});
        break;
      default:
        if (isRequest) {
          this.transport.sendError(
            (message as JsonRpcRequest).id,
            ErrorCodes.MethodNotFound,
            `Method not found: ${message.method}`,
          );
        }
    }
  }

  private async retryInitIfNeeded(): Promise<void> {
    if (!this.engine.isReady()) {
      await this.engine.ensureInitialized();
    }
  }

  /**
   * Before each tool call, lazily check if the database schema changed
   * and re-index if needed. Zero overhead when idle.
   */
  private async refreshIfSchemaChanged(): Promise<void> {
    if (!this.watchConfig || !this.engine.isReady()) return;
    try {
      const { changed, currentFingerprint } = await this.engine.checkSchemaChanged();
      if (changed) {
        process.stderr.write(`[DBGraph MCP] Schema changed, re-indexing...\n`);
        const result = await this.engine.executeReindex(currentFingerprint);
        process.stderr.write(
          `[DBGraph MCP] Re-indexed: ${result.sourcesIndexed} source(s), ` +
          `${result.nodesCreated} node(s), ${result.edgesCreated} edge(s)\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[DBGraph MCP] Schema refresh failed: ${msg}\n`);
    }
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<void> {
    const params = request.params as Record<string, unknown> | undefined;
    const clientInfo = params?.clientInfo as Record<string, string> | undefined;
    const clientName = clientInfo?.name ?? 'unknown';

    // Forward roots capability
    if (params?.capabilities) {
      const caps = params.capabilities as Record<string, unknown>;
      this.clientSupportsRoots = !!(caps.roots as Record<string, unknown>)?.listChanged;
    }

    // Do NOT block init on engine readiness — start it in background and
    // retry on first tool call. Unresponsive daemon is worse than stale.
    this.engine.startBackgroundInit(this.explicitProjectPath ?? undefined);

    const instructions = this.engine.getServerInstructions();

    this.transport.sendResult(request.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'dbgraph', version: '0.1.0' },
      capabilities: {
        tools: {},
        ...(this.clientSupportsRoots ? {} : { roots: { listChanged: false } }),
      },
      instructions,
    });
  }

  private async handleToolsList(request: JsonRpcRequest): Promise<void> {
    this.transport.sendResult(request.id, {
      tools: this.engine.getTools(),
    });
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };

    if (!params || !params.name) {
      this.transport.sendError(request.id, ErrorCodes.InvalidParams, 'Missing tool name');
      return;
    }

    const toolName = params.name;
    const toolArgs = params.arguments || {};

    const tool = this.engine.getTools().find((t) => t.name === toolName);
    if (!tool) {
      this.transport.sendError(request.id, ErrorCodes.MethodNotFound, `Unknown tool: ${toolName}`);
      return;
    }

    try {
      await this.retryInitIfNeeded();
      await this.refreshIfSchemaChanged();

      const result = await this.engine.executeTool(toolName, toolArgs);
      this.transport.sendResult(request.id, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.transport.sendError(request.id, ErrorCodes.InternalError, msg);
    }
  }
}
