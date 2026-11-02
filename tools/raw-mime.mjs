#!/usr/bin/env node
// Fetch the RAW delivered MIME of a Gmail message.
//
// This exists because neither our MCP tools nor Anthropic's Gmail connector
// expose raw MIME -- so the entire draft-vs-sent divergence bug class is
// invisible to both. Every fidelity claim in this project is verified with
// this script against a real delivered message, never against a rendered
// snippet or a description of one.
//
// Usage:
//   node tools/raw-mime.mjs <account> <messageId> [--headers-only] [--part=N]
//   node tools/raw-mime.mjs <account> --search "<gmail query>" [--limit=N]
//   node tools/raw-mime.mjs <account> --draft <draftId>

import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

const CONFIG_ROOT = process.env.GMAILMCPCONFIG_DIR || '/root/.gmail-multi-mcp';

async function loadAccount(accountId) {
  const cfg = JSON.parse(
    await fs.readFile(path.join(CONFIG_ROOT, 'accounts.json'), 'utf8')
  );
  const acct = cfg.accounts.find((a) => a.id === accountId);
  if (!acct) {
    const ids = cfg.accounts.map((a) => a.id).join(', ');
    throw new Error(`Unknown account "${accountId}". Known: ${ids}`);
  }

  const creds = JSON.parse(await fs.readFile(acct.credentialPath, 'utf8'));
  const token = JSON.parse(await fs.readFile(acct.tokenPath, 'utf8'));
  const c = creds.installed || creds.web || creds;

  const auth = new google.auth.OAuth2(
    c.client_id,
    c.client_secret,
    (c.redirect_uris && c.redirect_uris[0]) || 'http://localhost'
  );
  auth.setCredentials(token);

  return { acct, gmail: google.gmail({ version: 'v1', auth }) };
}

// Gmail returns raw as base64url; decode to the exact bytes that were delivered.
function decodeRaw(raw) {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

// Render CR/LF visibly. The whole bug is about line breaks, so an invisible
// difference between LF and CRLF -- or a hard break where a soft one belongs --
// must not be able to hide in the output.
function annotateLineEndings(text) {
  return text
    .split(/\r\n|\n|\r/)
    .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
    .join('\n');
}

function summarizeStructure(mime) {
  const ctMatches = [...mime.matchAll(/^Content-Type:\s*([^;\r\n]+)/gim)].map(
    (m) => m[1].trim()
  );
  const cteMatches = [
    ...mime.matchAll(/^Content-Transfer-Encoding:\s*(\S+)/gim),
  ].map((m) => m[1].trim());
  return { contentTypes: ctMatches, transferEncodings: cteMatches };
}

async function main() {
  const argv = process.argv.slice(2);
  const account = argv[0];
  if (!account) {
    console.error('usage: raw-mime.mjs <account> <messageId|--search Q|--draft ID>');
    process.exit(2);
  }

  const { acct, gmail } = await loadAccount(account);
  const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

  if (argv.includes('--search')) {
    const q = argv[argv.indexOf('--search') + 1];
    const limit = Number(flag('limit') || 10);
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: limit,
    });
    const msgs = res.data.messages || [];
    console.log(`# ${acct.email} -- ${msgs.length} match(es) for: ${q}\n`);
    for (const m of msgs) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      });
      const h = Object.fromEntries(
        (full.data.payload?.headers || []).map((x) => [x.name, x.value])
      );
      console.log(
        `${m.id}  ${h.Date}\n    subj: ${h.Subject}\n    from: ${h.From}  to: ${h.To}\n`
      );
    }
    return;
  }

  let messageId;
  if (argv.includes('--draft')) {
    const draftId = argv[argv.indexOf('--draft') + 1];
    const d = await gmail.users.drafts.get({
      userId: 'me',
      id: draftId,
      format: 'raw',
    });
    const mime = decodeRaw(d.data.message.raw);
    report(acct, `draft:${draftId}`, mime, argv);
    return;
  }

  messageId = argv[1];
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'raw',
  });
  report(acct, messageId, decodeRaw(res.data.raw), argv);
}

function report(acct, id, mime, argv) {
  const struct = summarizeStructure(mime);
  console.log(`# RAW MIME -- ${acct.email} -- ${id}`);
  console.log(`# Content-Types: ${JSON.stringify(struct.contentTypes)}`);
  console.log(`# Transfer-Encodings: ${JSON.stringify(struct.transferEncodings)}`);
  console.log(`# Total bytes: ${Buffer.byteLength(mime, 'utf8')}`);
  console.log(`# CRLF pairs: ${(mime.match(/\r\n/g) || []).length}`);
  console.log('#'.repeat(70));

  if (argv.includes('--headers-only')) {
    const split = mime.search(/\r?\n\r?\n/);
    console.log(annotateLineEndings(mime.slice(0, split)));
    return;
  }
  console.log(annotateLineEndings(mime));
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
