/**
 * A generic MCP server bound to one EndpointDefinition (src/endpoints.ts).
 * Plan 002 Phase 1: replaces the single GmailMultiInboxServer class that used
 * to hard-code the mail tool list and dispatch inline in src/index.ts.
 * Importable and inert -- nothing here runs on import, unlike the old
 * src/index.ts, which self-executed. Tests build one over
 * InMemoryTransport.createLinkedPair() (see test/golden-mail-tools-list.test.mjs).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureConfigLayout, getConfigRoot, loadAccountsConfig } from './config.js';
import { GmailAccountClient } from './gmail-client.js';
import { AllowlistConfigError, SendNotAllowedError } from './allowlist.js';
import { assertToolScopeAllowed, ScopeDeniedError } from './http/scopes.js';
import type { McpServerLike } from './http/transports.js';
import type { EndpointDefinition } from './endpoints.js';
import { textResult } from './tools/shared.js';
import type { ToolContext } from './tools/types.js';

export class McpEndpointServer implements McpServerLike {
  private readonly server: Server;
  private readonly configRoot: string;
  private readonly endpoint: EndpointDefinition;
  private readonly ctx: ToolContext;

  constructor(endpoint: EndpointDefinition) {
    this.endpoint = endpoint;
    this.server = new Server(
      {
        name: 'ghub',
        version: '1.4.0',
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: endpoint.instructions,
      }
    );

    this.configRoot = getConfigRoot();

    const enabledNames = new Set(endpoint.tools.map((t) => t.name));
    this.ctx = {
      configRoot: this.configRoot,
      loadConfig: () => loadAccountsConfig(this.configRoot),
      getClientForAccount: (account) => GmailAccountClient.create(this.configRoot, account),
      isToolEnabled: (name) => enabledNames.has(name),
    };

    this.setupHandlers();

    this.server.onerror = (error) => {
      console.error('[ghub] MCP error:', error);
    };
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.endpoint.tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      try {
        const handler = this.endpoint.handlers[name];
        if (!handler) {
          throw new Error(`Tool "${name}" is not enabled on this server.`);
        }
        // ADR 013: OAuth-authenticated requests carry extra.authInfo (set by
        // src/http/oauth's gate). Since Phase 4 deleted the shared bearer
        // token, EVERY /mcp request carries it -- the only caller left that
        // does not is the stdio transport, which has no HTTP auth layer and is
        // reachable only from the VPS itself. See src/http/scopes.ts -- this
        // call is the ENTIRE scope gate, deliberately kept out of every tool
        // handler, and its `if (!authInfo) return` is now the last thing
        // between a gate bug and unscoped access.
        assertToolScopeAllowed(name, extra.authInfo);
        return await handler(args, this.ctx);
      } catch (error) {
        // A refusal from the send boundary is surfaced VERBATIM. Its wording is
        // load-bearing: the spec requires the caller to be told the TOOL will
        // not allow this, not that the assistant "decided" against it. Wrapping
        // it in "Error executing send_message: ..." reads like a transient
        // failure worth retrying, which is the opposite of what happened.
        if (
          error instanceof SendNotAllowedError ||
          error instanceof AllowlistConfigError ||
          error instanceof ScopeDeniedError
        ) {
          return textResult(error.message);
        }
        return textResult(`Error executing ${name}: ${(error as Error).message}`);
      }
    });
  }

  async connectTransport(transport: Transport): Promise<void> {
    await ensureConfigLayout(this.configRoot);
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.connectTransport(transport);
    console.error(`[ghub] Running on stdio. Config root: ${this.configRoot}`);
  }
}
