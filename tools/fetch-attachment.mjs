#!/usr/bin/env node
// Fetch ONE attachment's exact bytes from a Gmail message or draft.
//
// tools/raw-mime.mjs dumps a whole message as annotated UTF-8 text -- fine for
// headers and text bodies, but its decode step (`Buffer...toString('utf8')`)
// is lossy for binary attachment bytes (PDFs, images, etc.), so it cannot be
// used to verify attachment fidelity. This exists for that: fetch the
// attachment through the same `messages.attachments.get` endpoint Gmail
// itself serves, decode straight to a Buffer, and write it to disk so it can
// be diffed/checksummed against the original file.
//
// Usage:
//   node tools/fetch-attachment.mjs <account> <messageId> <filename> <outFile>
//   node tools/fetch-attachment.mjs <account> --draft <draftId> <filename> <outFile>
//
// Then, e.g.:
//   shasum -a 256 <outFile> <original file>   # hashes must match

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
    throw new Error(
      `Unknown account "${accountId}". Known: ${cfg.accounts.map((a) => a.id).join(', ')}`
    );
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

// Recursively find every part carrying an attachment (has a filename and
// either an attachmentId or inline body data). Mirrors the shape
// src/gmail-client.ts walks, kept as a separate implementation on purpose --
// same reasoning as raw-mime.mjs's header comment on not sharing a decoder
// with the server this is meant to check.
function collectAttachmentParts(payload, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body && (payload.body.attachmentId || payload.body.data)) {
    out.push(payload);
  }
  for (const part of payload.parts || []) collectAttachmentParts(part, out);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const account = argv[0];

  let idArg;
  let filename;
  let outFile;
  let isDraft = false;

  if (argv[1] === '--draft') {
    isDraft = true;
    [, , idArg, filename, outFile] = argv;
  } else {
    [, idArg, filename, outFile] = argv;
  }

  if (!account || !idArg || !filename || !outFile) {
    console.error(
      'usage: fetch-attachment.mjs <account> <messageId> <filename> <outFile>\n' +
        '       fetch-attachment.mjs <account> --draft <draftId> <filename> <outFile>'
    );
    process.exit(2);
  }

  const { gmail } = await loadAccount(account);

  let messageId;
  let payload;
  if (isDraft) {
    const d = await gmail.users.drafts.get({ userId: 'me', id: idArg, format: 'full' });
    messageId = d.data.message.id;
    payload = d.data.message.payload;
  } else {
    const m = await gmail.users.messages.get({ userId: 'me', id: idArg, format: 'full' });
    messageId = m.data.id;
    payload = m.data.payload;
  }

  const candidates = collectAttachmentParts(payload);
  const match = candidates.find((p) => p.filename === filename);
  if (!match) {
    const names = candidates.map((p) => p.filename).join(', ') || '(none)';
    console.error(`No attachment named "${filename}" found. Available: ${names}`);
    process.exit(1);
  }

  let data;
  if (match.body.attachmentId) {
    const att = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: match.body.attachmentId,
    });
    data = att.data.data;
  } else {
    data = match.body.data; // small attachments Gmail inlines directly
  }

  const bytes = Buffer.from(data, 'base64url');
  await fs.writeFile(outFile, bytes);
  console.log(`Wrote ${bytes.length} bytes to ${outFile} (from "${filename}")`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
