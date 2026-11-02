/**
 * Shared types for the per-service tool modules under src/tools/. See
 * docs/plans/002-google-workspace-endpoint.md, "Phase 1 — Tool registry
 * restructure" for the shape this codifies.
 */
import type {
  CallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { AccountConfig, AccountsConfig } from '../config.js';
import type { GmailAccountClient } from '../gmail-client.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
}

export type ToolDefinition = Tool & { annotations: ToolAnnotations };

/**
 * What a handler needs from the server, without depending on the server
 * class itself. `isToolEnabled` means "listed on the endpoint serving this
 * call" -- it is NOT a global switch (that was ENABLED_TOOLS's job, pre-Phase
 * 1); each endpoint's McpEndpointServer answers it from its own tool list.
 */
export interface ToolContext {
  configRoot: string;
  loadConfig(): Promise<AccountsConfig>;
  getClientForAccount(account: AccountConfig): Promise<GmailAccountClient>;
  isToolEnabled(name: string): boolean;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<CallToolResult>;

export interface ToolModule {
  definitions: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}
