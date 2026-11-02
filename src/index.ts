#!/usr/bin/env node

import { getConfigRoot } from './config.js';
import { loadEndpoints, type EndpointDefinition } from './endpoints.js';
import { McpEndpointServer } from './mcp-server.js';
import { resolveHttpConfigFromEnv, startHttpServer } from './http/server.js';

function resolveTransportMode(): 'stdio' | 'http' {
  const explicit = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  if (explicit === 'stdio') return 'stdio';
  // 'sse' is the historical spelling of this mode and is still what the
  // deployed .env says. Phase 4 deleted the /sse endpoint but not this value:
  // renaming it would need a coordinated .env edit on the VPS for no benefit,
  // so both spellings select the one remaining HTTP transport.
  if (explicit === 'sse' || explicit === 'http') return 'http';
  if (process.env.PORT?.trim()) return 'http';
  return 'stdio';
}

async function runHttpServer(endpoints: EndpointDefinition[]): Promise<void> {
  const config = resolveHttpConfigFromEnv(process.env);

  // Fail closed, loudly, at boot. Before Phase 4 an unconfigured OAuth layer
  // was a degraded-but-safe mode because the shared bearer token still gated
  // /mcp. OAuth is now the only credential, so booting without it would raise
  // a public endpoint whose every request is refused -- and, worse, one whose
  // failure the deploy health check cannot see: that check probes /mcp
  // unauthenticated and treats a 4xx as success. Refusing to start instead
  // makes pm2 report the app down, which deploy.sh does catch, and leaves
  // `bash scripts/deploy.sh --rollback` as the escape hatch.
  if (!config.oauth) {
    throw new Error(
      'Refusing to start the HTTP transport: the OAuth authorization server is not configured. ' +
        'Set PUBLIC_URL, GOOGLE_LOGIN_CLIENT_ID and GOOGLE_LOGIN_CLIENT_SECRET in .env ' +
        '(see docs/adr/013-self-hosted-oauth-google-upstream.md). Since Phase 4 removed the ' +
        'shared bearer token there is no other way to authenticate a client, so a server ' +
        'started without it could serve nobody.',
    );
  }

  // OAuth env parsing (resolveHttpConfigFromEnv) is a pure function of `env`
  // and deliberately does not know about configRoot; attach it here, the one
  // place that already computes it for the rest of the server.
  const oauth = { ...config.oauth, configRoot: getConfigRoot() };

  const running = await startHttpServer({
    ...config,
    oauth,
    // See request-log.ts's module doc comment.
    requestLog: { configRoot: getConfigRoot() },
    // One gated Streamable HTTP mount per endpoints.json entry, in file
    // order (plan 002 Phase 2). Each is its own OAuth protected resource.
    endpoints: endpoints.map((endpoint) => ({
      path: endpoint.path,
      displayName: endpoint.displayName,
      createServer: () => new McpEndpointServer(endpoint),
    })),
  });

  console.error('[ghub] Running on HTTP at port ' + running.port + '.');
  for (const endpoint of endpoints) {
    console.error(
      `[ghub]   ${endpoint.displayName}: POST ${endpoint.path} (${endpoint.tools.length} tools), resource ${new URL(endpoint.path, config.oauth.issuerUrl).href}`,
    );
  }
  console.error('[ghub] OAuth AS enabled. Issuer: ' + config.oauth.issuerUrl.href);

  const shutdown = async (): Promise<void> => {
    await running.close();
  };

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  // Throws (and crashes the process, before any port is bound) on a missing,
  // malformed, or invalid endpoints.json -- see src/endpoints.ts's doc
  // comment for why that is the correct failure mode.
  const endpoints = loadEndpoints();

  const mailEndpoint = endpoints.find((e) => e.name === 'mail');
  if (!mailEndpoint) {
    throw new Error('[ghub] endpoints.json has no "mail" endpoint -- refusing to start.');
  }
  if (mailEndpoint.path !== '/mcp') {
    throw new Error(
      `[ghub] The "mail" endpoint must be mounted at /mcp, got "${mailEndpoint.path}" -- refusing to start.`,
    );
  }

  if (resolveTransportMode() === 'http') {
    await runHttpServer(endpoints);
    return;
  }

  // stdio serves the Mail endpoint only. It is reachable solely from the VPS
  // itself (no HTTP auth layer -- see src/http/scopes.ts) and exists for
  // on-box debugging, not for clients.
  const server = new McpEndpointServer(mailEndpoint);
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
  await server.run();
}

main().catch((error) => {
  console.error('[ghub] Fatal error:', error);
  process.exit(1);
});
