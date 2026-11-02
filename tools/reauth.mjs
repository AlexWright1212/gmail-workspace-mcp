#!/usr/bin/env node
// Standalone re-auth for one account.
//
// The in-server onboarding tool is listed on no endpoint in endpoints.json, so this is
// the only supported way to (re)consent an account. It requests the full
// scope set spec 002 needs -- mail plus Drive, Sheets, Docs and Calendar --
// mirroring GOOGLE_ACCOUNT_SCOPES in src/gmail-client.ts. Until 2026-09-19 it
// requested mail only (spec 001 excluded Workspace); tokens issued before then
// hold mail scopes only, and `node tools/workspace-probe.mjs` says which
// account still needs a fresh consent.
//
// Usage:
//   node tools/reauth.mjs <account>           # print the consent URL
//   node tools/reauth.mjs <account> <code>    # exchange the code, write token
//
// After consenting, the browser lands on http://localhost/?code=...&scope=...
// That page fails to load (nothing is listening) -- that is expected. Copy the
// `code` value out of the address bar and pass it as the second argument.

import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

const CONFIG_ROOT = process.env.GMAILMCPCONFIG_DIR || '/root/.gmail-multi-mcp';

//   mail.google.com      -> messages, threads, drafts, send, labels, modify
//   gmail.settings.basic -> sendAs signatures, filters (block_sender)
//   drive                -> Drive search/read/create/move/trash (restricted scope,
//                           same "unverified app" interstitial as mail.google.com)
//   spreadsheets, documents, calendar -> the Workspace endpoint (plan 002)
//   openid/userinfo      -> identify which account actually consented
//
// Keep this list equal to GOOGLE_ACCOUNT_SCOPES (src/gmail-client.ts) plus the
// two identity scopes. The probe (tools/workspace-probe.mjs) checks the same set.
const SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

async function loadAccount(accountId) {
  const cfg = JSON.parse(
    await fs.readFile(path.join(CONFIG_ROOT, 'accounts.json'), 'utf8')
  );
  const acct = cfg.accounts.find((a) => a.id === accountId);
  if (!acct) {
    throw new Error(
      `Unknown account "${accountId}". Known: ${cfg.accounts.map((a) => a.id).join(', ')}`
    );
  }
  const creds = JSON.parse(await fs.readFile(acct.credentialPath, 'utf8'));
  const c = creds.installed || creds.web;
  const client = new google.auth.OAuth2(
    c.client_id,
    c.client_secret,
    (c.redirect_uris && c.redirect_uris[0]) || 'http://localhost'
  );
  return { acct, client };
}

async function main() {
  const [accountId, code] = process.argv.slice(2);
  if (!accountId) {
    console.error('usage: reauth.mjs <account> [authorization_code]');
    process.exit(2);
  }

  const { acct, client } = await loadAccount(accountId);

  if (!code) {
    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent', // force a fresh refresh_token, don't reuse the dead one
      login_hint: acct.email,
    });
    console.log(`\nAccount : ${acct.id}  (${acct.email})`);
    console.log(`Scopes  :\n  ${SCOPES.join('\n  ')}`);
    console.log(`\nSign in as ${acct.email} -- not any other Google account.\n`);
    console.log(url);
    console.log(
      `\nThen: node tools/reauth.mjs ${acct.id} "<code from the address bar>"\n`
    );
    return;
  }

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh_token. Re-run the consent URL (it uses prompt=consent, which should always issue one).'
    );
  }

  // Verify the consent landed on the account we expected before overwriting a
  // token file -- consenting as the wrong Google account is an easy mistake and
  // would silently point this account id at the wrong mailbox.
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const info = await oauth2.userinfo.get();
  const actual = (info.data.email || '').toLowerCase();
  const expected = acct.email.toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `Consent was granted by ${actual}, but account "${acct.id}" expects ${expected}. Nothing written. Re-run and sign in as ${expected}.`
    );
  }

  const granted = (tokens.scope || '').split(' ');
  const missing = SCOPES.filter(
    (s) => s !== 'openid' && !granted.includes(s)
  );

  await fs.writeFile(acct.tokenPath, JSON.stringify(tokens, null, 2), 'utf8');

  console.log(`\nToken written: ${acct.tokenPath}`);
  console.log(`Verified as  : ${actual}`);
  console.log(`Granted      :\n  ${granted.join('\n  ')}`);
  if (missing.length) {
    console.log(`\nWARNING -- these requested scopes were NOT granted:`);
    for (const m of missing) console.log(`  ${m}`);
    console.log(
      `Google lets a user untick individual permissions on the consent screen;\n` +
        `a Workspace scope missing here means the Workspace endpoint cannot serve\n` +
        `this account. For tamu, a university admin policy can also strip them.`
    );
  } else {
    console.log(`\nAll required scopes granted.`);
  }
  if (tokens.refresh_token_expires_in) {
    const days = (tokens.refresh_token_expires_in / 86400).toFixed(1);
    console.log(
      `\nNOTE: refresh_token expires in ~${days} days. That means the OAuth consent\n` +
        `screen is still in "Testing" publishing status. Set it to "In production"\n` +
        `in Google Cloud Console or this breaks again in a week.`
    );
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}\n`);
  process.exit(1);
});
