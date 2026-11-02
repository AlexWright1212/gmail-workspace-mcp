/**
 * Loads and validates endpoints.json at boot. This is ADR 003's fail-closed
 * rule (previously enforced by loadEnabledTools() over tools-enabled.json),
 * STRENGTHENED: the old function failed closed by returning an empty tool
 * set (the server would still boot and 404/deny everything, which looks
 * alive to a naive probe). This module instead throws, and the caller
 * (src/index.ts) lets that throw crash the process before any port is
 * bound -- a server that cannot prove its own config is valid does not get
 * to serve traffic that looks like it might be.
 *
 * Every error message names the file path and the specific offending entry,
 * so a typo in endpoints.json (a renamed tool, a copy-pasted path) fails
 * loudly at the one place it can still be fixed cheaply -- boot -- instead
 * of silently dropping a tool or, worse, colliding two endpoints on one path.
 */
import { readFileSync } from 'node:fs';
import type { ToolDefinition, ToolHandler } from './tools/types.js';
import { TOOL_REGISTRY } from './tools/registry.js';
import { INSTRUCTIONS_BY_ENDPOINT } from './instructions/index.js';

export interface EndpointDefinition {
  name: string;
  path: string;
  /**
   * What the owner sees: on the OAuth consent page ("An application is
   * asking for access to your Mail endpoint"), in the endpoint's RFC 9728
   * metadata, and in the boot log. Plan 002 Phase 2.
   */
  displayName: string;
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  instructions: string;
}

interface RawEndpointsFile {
  [endpointName: string]: {
    path?: unknown;
    displayName?: unknown;
    tools?: unknown;
  };
}

/**
 * True when `candidate` is `prefix` itself or lives under it as a whole path
 * segment (`/mcp` covers `/mcp/x` but not `/mcpx`). Express's `app.use(path)`
 * matches exactly this way, which is why two endpoints in that relation must
 * be refused: one endpoint's auth gate would silently apply to the other's
 * requests too, and the one mounted first would win.
 */
function isPathPrefixOf(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
}

export function loadEndpoints(
  filePath: string = new URL('../endpoints.json', import.meta.url).pathname,
): EndpointDefinition[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `[endpoints] Could not read ${filePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[endpoints] ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[endpoints] ${filePath} must contain a JSON object at the top level.`);
  }

  const rawEndpoints = parsed as RawEndpointsFile;
  const endpointNames = Object.keys(rawEndpoints);

  const seenPaths = new Map<string, string>();
  const result: EndpointDefinition[] = [];

  for (const name of endpointNames) {
    const entry = rawEndpoints[name];

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`[endpoints] ${filePath}: endpoint "${name}" must be an object.`);
    }

    const path = entry.path;
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error(
        `[endpoints] ${filePath}: endpoint "${name}" has an invalid "path" (must be a string starting with "/"), got: ${JSON.stringify(path)}.`,
      );
    }

    const existingOwner = seenPaths.get(path);
    if (existingOwner) {
      throw new Error(
        `[endpoints] ${filePath}: path "${path}" is used by both "${existingOwner}" and "${name}" -- paths must be unique.`,
      );
    }
    for (const [otherPath, otherName] of seenPaths) {
      if (isPathPrefixOf(otherPath, path) || isPathPrefixOf(path, otherPath)) {
        throw new Error(
          `[endpoints] ${filePath}: path "${path}" ("${name}") nests under or over "${otherPath}" ("${otherName}") -- one endpoint's auth gate would apply to the other's requests, so this is refused.`,
        );
      }
    }
    seenPaths.set(path, name);

    const displayName = entry.displayName;
    if (typeof displayName !== 'string' || displayName.trim() === '') {
      throw new Error(
        `[endpoints] ${filePath}: endpoint "${name}" has no "displayName" (a non-empty string, e.g. "Mail" -- shown on the OAuth consent page), got: ${JSON.stringify(displayName)}.`,
      );
    }

    const toolNames = entry.tools;
    if (!Array.isArray(toolNames) || !toolNames.every((t) => typeof t === 'string')) {
      throw new Error(
        `[endpoints] ${filePath}: endpoint "${name}"'s "tools" must be an array of strings.`,
      );
    }

    const seenToolNames = new Set<string>();
    const tools: ToolDefinition[] = [];
    const handlers: Record<string, ToolHandler> = {};

    for (const toolName of toolNames) {
      if (seenToolNames.has(toolName)) {
        throw new Error(
          `[endpoints] ${filePath}: endpoint "${name}" lists tool "${toolName}" more than once.`,
        );
      }
      seenToolNames.add(toolName);

      const registryEntry = TOOL_REGISTRY.get(toolName);
      if (!registryEntry) {
        throw new Error(
          `[endpoints] ${filePath}: endpoint "${name}" lists unknown tool "${toolName}" -- no such tool is registered in src/tools/registry.ts.`,
        );
      }

      tools.push(registryEntry.definition);
      handlers[toolName] = registryEntry.handler;
    }

    const instructions = INSTRUCTIONS_BY_ENDPOINT[name];
    if (typeof instructions !== 'string') {
      throw new Error(
        `[endpoints] ${filePath}: endpoint "${name}" has no instructions module in src/instructions/index.ts.`,
      );
    }

    result.push({ name, path, displayName, tools, handlers, instructions });
  }

  return result;
}
