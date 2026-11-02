/**
 * Merges every per-service tool module into one lookup table. Plan 002
 * Phase 1: this replaces the single inline 58-entry array that used to live
 * in src/index.ts's ListToolsRequestSchema handler.
 *
 * Fails LOUDLY at import time (throws, does not log-and-continue) on:
 *  - a duplicate tool name across modules,
 *  - a definition missing `annotations` or with a non-boolean `readOnlyHint`,
 *  - a definition with no matching handler, or a handler with no matching
 *    definition.
 * This is deliberate: a silently-dropped or silently-duplicated tool is
 * exactly the kind of mistake the old 4,100-line inline array made easy, and
 * the whole point of the restructure is to make it impossible instead of
 * merely unlikely.
 */
import type { ToolDefinition, ToolHandler, ToolModule } from './types.js';
import mail from './mail.js';
import accounts from './accounts.js';
import attachments from './attachments.js';
import drive from './drive.js';
import sheets from './sheets.js';
import docs from './docs.js';
import calendar from './calendar.js';

const MODULES: ToolModule[] = [mail, accounts, attachments, drive, sheets, docs, calendar];

export interface RegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

function buildRegistry(): ReadonlyMap<string, RegistryEntry> {
  const registry = new Map<string, RegistryEntry>();
  const definedNames = new Set<string>();
  const handledNames = new Set<string>();

  for (const mod of MODULES) {
    for (const definition of mod.definitions) {
      if (definedNames.has(definition.name)) {
        throw new Error(`[tools/registry] Duplicate tool definition: "${definition.name}".`);
      }
      definedNames.add(definition.name);

      const annotations = definition.annotations as { readOnlyHint?: unknown } | undefined;
      if (!annotations || typeof annotations.readOnlyHint !== 'boolean') {
        throw new Error(
          `[tools/registry] Tool "${definition.name}" is missing annotations.readOnlyHint (must be boolean).`,
        );
      }
    }
    for (const name of Object.keys(mod.handlers)) {
      if (handledNames.has(name)) {
        throw new Error(`[tools/registry] Duplicate tool handler: "${name}".`);
      }
      handledNames.add(name);
    }
  }

  for (const name of definedNames) {
    if (!handledNames.has(name)) {
      throw new Error(`[tools/registry] Tool "${name}" has a definition but no handler.`);
    }
  }
  for (const name of handledNames) {
    if (!definedNames.has(name)) {
      throw new Error(`[tools/registry] Tool "${name}" has a handler but no definition.`);
    }
  }

  for (const mod of MODULES) {
    const byName = new Map(mod.definitions.map((d) => [d.name, d] as const));
    for (const [name, handler] of Object.entries(mod.handlers)) {
      const definition = byName.get(name);
      if (!definition) continue; // already thrown above
      registry.set(name, { definition, handler });
    }
  }

  return registry;
}

export const TOOL_REGISTRY: ReadonlyMap<string, RegistryEntry> = buildRegistry();
