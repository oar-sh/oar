// Stand-in for the `claude` CLI auth subcommands, injected through
// COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN so the auth service can be exercised without
// touching the host's real Claude login.
//
// Node port of claude-auth-stub.sh so Windows can run it too; the platform
// wrappers next to it (`claude-auth-stub.sh`, `claude-auth-stub.cmd`) just exec
// this file.
//
// Mirrors the shapes observed on CLI 2.1.247:
//   auth status --json -> one line of JSON
//   auth login         -> browser notice, an OSC-8 + SGR wrapped authorize URL,
//                         then `Paste code here if prompted > ` and a blocking read
//   auth logout        -> removes the credentials file
//
// Fake credentials file path comes from CLAUDE_AUTH_STUB_CRED_FILE; "logged in"
// means that file exists.

import fs from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

const CRED_FILE = process.env.CLAUDE_AUTH_STUB_CRED_FILE || '';
const AUTH_URL = process.env.CLAUDE_AUTH_STUB_URL
  || 'https://claude.com/oauth/authorize?code=true&client_id=stub-client&code_challenge=Xk3nQ7pLm2vB8sT1wY6zR0aC5dF9gH4jK7lN2oP3qS8&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';

const [first = '', second = ''] = process.argv.slice(2);
const command = `${first} ${second}`;
const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);

if (command === 'auth status') {
  if (CRED_FILE && fs.existsSync(CRED_FILE)) {
    out('{"loggedIn":true,"authMethod":"claudeai","apiProvider":null,"email":"stub@example.com","orgId":"org_stub","orgName":"Stub Org","subscriptionType":"max"}\n');
  } else {
    out('{"loggedIn":false,"authMethod":null,"apiProvider":null,"email":null,"orgId":null,"orgName":null,"subscriptionType":null}\n');
  }
  process.exit(0);
} else if (command === 'auth login') {
  out('Opening browser to sign in…\n');
  // OSC-8 hyperlink (target + visible label) wrapped in SGR colour codes, the
  // exact shape the real CLI emits under a PTY.
  out(`If the browser did not open, visit: \x1b]8;;${AUTH_URL}\x1b\\\x1b[4;34m${AUTH_URL}\x1b[0m\x1b]8;;\x1b\\\n`);
  out('\x1b[2mPaste code here if prompted > \x1b[0m');
  const rl = readline.createInterface({ input: process.stdin });
  let submitted = null;
  rl.on('line', (line) => {
    submitted = line;
    rl.close();
  });
  rl.on('close', () => {
    if (submitted === null) {
      out('\nAborted.\n');
      process.exit(1);
    }
    if (submitted === 'goodcode') {
      if (CRED_FILE) {
        // Deliberately short fake tokens: anything with 20+ characters after
        // `sk-ant-` trips the secret scanner in server/test-hygiene.test.mjs.
        fs.writeFileSync(CRED_FILE, '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-stub","refreshToken":"sk-ant-ort01-stub"}}\n');
      }
      out('\nLogin successful. Logged in as stub@example.com\n');
      process.exit(0);
    }
    err('\nOAuth error: invalid_grant - the authorization code is invalid or has expired.\n');
    process.exit(1);
  });
} else if (command === 'auth logout') {
  if (CRED_FILE) {
    fs.rmSync(CRED_FILE, { force: true });
  }
  out('Logged out.\n');
  process.exit(0);
} else {
  err(`claude-auth-stub: unsupported command: ${process.argv.slice(2).join(' ')}\n`);
  process.exit(2);
}
