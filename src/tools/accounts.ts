/**
 * Account-management tools: list_accounts, begin_account_auth,
 * finish_account_auth. Moved out of src/index.ts during the plan 002 Phase 1
 * registry restructure. Not listed on any endpoint today (same as before the
 * restructure -- these tools had handlers and dispatch cases but no
 * tools/list entry, so they were already unreachable; see the plan's target
 * "Tool surface" section, which keeps them unexposed going forward).
 */
import { promises as fs } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AccountConfig } from '../config.js';
import {
  ensureConfigLayout,
  getAccountPaths,
  getDefaultAccountPaths,
  saveAccountsConfig,
  upsertAccount,
  validateAccountId,
} from '../config.js';
import { getAccountHealth, getAccountOrThrow } from '../accounts.js';
import {
  exchangeCodeForToken,
  generateAuthUrlFromCredentials,
  readCredentialsFile,
} from '../gmail-client.js';
import {
  textResult,
  valueToString,
  type BeginAuthArgs,
  type FinishAuthArgs,
} from './shared.js';
import type { ToolContext, ToolDefinition, ToolHandler, ToolModule } from './types.js';

export const listAccountsTool: ToolDefinition = {
          name: 'list_accounts',
          description:
            'List all configured Gmail inbox accounts and their authentication/health status.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const beginAccountAuthTool: ToolDefinition = {
          name: 'begin_account_auth',
          description:
            'Start OAuth for a new Google account: writes its OAuth client credentials, registers it (disabled) in accounts.json, and returns a Google authorization URL to open in a browser. Follow with finish_account_auth once you have the authorization_code.',
          inputSchema: {
            type: 'object',
            properties: {
              account_id: { type: 'string', description: 'Short id for the new account (e.g. "personal", "tamu").' },
              email: { type: 'string', description: 'The Google account email address being connected.' },
              display_name: { type: 'string', description: 'Optional display name for the account.' },
              credentials_json: {
                description: 'OAuth client credentials (Google "Desktop" client JSON), as a JSON string or object. Omit to use credentials_path or the default credentials file.',
              },
              credentials_path: { type: 'string', description: 'Path to a credentials JSON file to read instead of credentials_json.' },
            },
            required: ['account_id', 'email'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const finishAccountAuthTool: ToolDefinition = {
          name: 'finish_account_auth',
          description:
            'Complete OAuth for an account started with begin_account_auth: exchanges the authorization_code for tokens, saves them, and enables the account.',
          inputSchema: {
            type: 'object',
            properties: {
              account_id: { type: 'string', description: 'The account id passed to begin_account_auth.' },
              authorization_code: { type: 'string', description: 'The code Google returned after approving access.' },
            },
            required: ['account_id', 'authorization_code'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export async function handleListAccounts(ctx: ToolContext): Promise<CallToolResult> {
    const config = await ctx.loadConfig();

    if (config.accounts.length === 0) {
      return textResult(
        [
          '# Gmail Accounts',
          '',
          'No accounts configured yet.',
          '',
          ctx.isToolEnabled('begin_account_auth') && ctx.isToolEnabled('finish_account_auth')
            ? 'Use `begin_account_auth` then `finish_account_auth` to add the first inbox.'
            : 'Adding an inbox is an OWNER task on the server host — no tool exposed here can do it. On the VPS, run `node tools/reauth.mjs <account>`, open the printed consent URL, then re-run it with the returned code.',
        ].join('\n')
      );
    }

    const healthList = await Promise.all(
      config.accounts.map((account) => getAccountHealth(ctx.configRoot, account))
    );

    const lines: string[] = ['# Gmail Accounts', '', `**Config Root**: ${ctx.configRoot}`, ''];

    healthList.forEach((health, index) => {
      const { account } = health;
      const status = health.ready ? 'ready' : account.enabled ? 'needs-auth-files' : 'disabled';
      const defaultMarker = config.defaultAccount === account.id ? ' (default)' : '';
      lines.push(`## ${index + 1}. ${account.id}${defaultMarker}`);
      lines.push(`- Email: ${account.email}`);
      lines.push(`- Display Name: ${account.displayName || '(none)'}`);
      lines.push(`- Enabled: ${account.enabled}`);
      lines.push(`- Status: ${status}`);
      lines.push(`- Credentials File: ${health.hasCredentialsFile ? 'present' : 'missing'}`);
      lines.push(`- Token File: ${health.hasTokenFile ? 'present' : 'missing'}`);
      lines.push('');
    });

    return textResult(lines.join('\n'));
  }


export async function parseCredentialsInput(args: BeginAuthArgs, credentialsPath: string): Promise<unknown> {
    if (args.credentials_json !== undefined) {
      if (typeof args.credentials_json === 'string') {
        return JSON.parse(args.credentials_json);
      }
      if (typeof args.credentials_json === 'object' && args.credentials_json !== null) {
        return args.credentials_json;
      }
      throw new Error('credentials_json must be either a JSON string or object.');
    }

    if (args.credentials_path && args.credentials_path.trim() !== '') {
      const raw = await fs.readFile(args.credentials_path, 'utf8');
      return JSON.parse(raw);
    }

    return readCredentialsFile(credentialsPath);
  }


export async function handleBeginAccountAuth(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: BeginAuthArgs = {
      account_id: valueToString(rawArgs.account_id),
      email: valueToString(rawArgs.email),
      display_name: valueToString(rawArgs.display_name, '') || undefined,
      credentials_json: rawArgs.credentials_json,
      credentials_path: valueToString(rawArgs.credentials_path, '') || undefined,
    };

    if (!args.account_id) throw new Error('account_id is required.');
    if (!args.email) throw new Error('email is required.');

    validateAccountId(args.account_id);
    await ensureConfigLayout(ctx.configRoot);

    const defaultPaths = getDefaultAccountPaths(ctx.configRoot, args.account_id);
    await fs.mkdir(defaultPaths.accountDir, { recursive: true });

    const credentials = await parseCredentialsInput(args, defaultPaths.credentialsPath);
    await fs.writeFile(defaultPaths.credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');

    const { authUrl } = generateAuthUrlFromCredentials(credentials);

    let config = await ctx.loadConfig();

    config = upsertAccount(config, {
      id: args.account_id,
      email: args.email,
      displayName: args.display_name,
      enabled: false,
      credentialPath: defaultPaths.credentialsPath,
      tokenPath: defaultPaths.tokenPath,
    });

    await saveAccountsConfig(ctx.configRoot, config);

    return textResult(
      [
        '# Google Account OAuth Started',
        '',
        `**Account ID**: ${args.account_id}`,
        `**Email**: ${args.email}`,
        `**Credentials File**: ${defaultPaths.credentialsPath}`,
        '',
        'Open this URL and approve access for Gmail and Google Drive metadata:',
        authUrl,
        '',
        'Then run `finish_account_auth` with the same account_id and the returned authorization_code.',
      ].join('\n')
    );
  }


export async function handleFinishAccountAuth(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: FinishAuthArgs = {
      account_id: valueToString(rawArgs.account_id),
      authorization_code: valueToString(rawArgs.authorization_code),
    };

    if (!args.account_id) throw new Error('account_id is required.');
    if (!args.authorization_code) throw new Error('authorization_code is required.');

    validateAccountId(args.account_id);

    let config = await ctx.loadConfig();
    const account = getAccountOrThrow(config, args.account_id);
    const paths = getAccountPaths(ctx.configRoot, account);

    const credentials = await readCredentialsFile(paths.credentialsPath);
    const tokens = await exchangeCodeForToken(credentials, args.authorization_code);

    if (!tokens.access_token && !tokens.refresh_token) {
      throw new Error('OAuth exchange succeeded but no token payload was returned.');
    }

    await fs.writeFile(paths.tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');

    const updatedAccount: AccountConfig = {
      ...account,
      enabled: true,
      credentialPath: paths.credentialsPath,
      tokenPath: paths.tokenPath,
    };

    const tempConfig = upsertAccount(config, updatedAccount);
    await saveAccountsConfig(ctx.configRoot, tempConfig);

    const refreshedAccount = getAccountOrThrow(tempConfig, args.account_id);
    const client = await ctx.getClientForAccount(refreshedAccount);

    let profileEmail = refreshedAccount.email;
    try {
      profileEmail = await client.getProfileEmail();
    } catch {
      profileEmail = refreshedAccount.email;
    }

    config = upsertAccount(tempConfig, {
      ...refreshedAccount,
      email: profileEmail,
      enabled: true,
    });

    if (!config.defaultAccount) {
      config.defaultAccount = args.account_id;
    }

    await saveAccountsConfig(ctx.configRoot, config);

    return textResult(
      [
        '✅ Google account OAuth completed.',
        `Account ID: ${args.account_id}`,
        `Email: ${profileEmail}`,
        `Token File: ${paths.tokenPath}`,
        '',
        'This account is now enabled for Gmail tools and Google Drive metadata search.',
      ].join('\n')
    );
  }

export const definitions: ToolDefinition[] = [
  listAccountsTool,
  beginAccountAuthTool,
  finishAccountAuthTool,
];

export const handlers: Record<string, ToolHandler> = {
  list_accounts: (_rawArgs, ctx) => handleListAccounts(ctx),
  begin_account_auth: handleBeginAccountAuth,
  finish_account_auth: handleFinishAccountAuth,
};

const accountsModule: ToolModule = { definitions, handlers };
export default accountsModule;
