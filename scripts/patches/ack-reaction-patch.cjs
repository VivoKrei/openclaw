#!/usr/bin/env node
/**
 * ack-reaction-patch.cjs — Inject ⚡ reaction on inbound NC Talk messages
 *
 * Patches handleNextcloudTalkInbound() in the compiled OpenClaw bundle to
 * immediately react with ⚡ to every inbound message before processing.
 * This gives the user instant feedback that his message was received.
 *
 * Applied idempotently — safe to re-run after upgrades.
 * Re-applied automatically by ~/bin/openclaw-upgrade.sh.
 */

const fs = require('fs');
const path = require('path');

const BUNDLE_HINT = path.join(
  require('os').homedir(),
  '.local/lib/node_modules/openclaw/dist/channel-BZnxNpmP.js'
);

// Find the actual bundle file (name may change across versions)
let bundlePath = BUNDLE_HINT;
if (!fs.existsSync(bundlePath)) {
  const distDir = path.join(require('os').homedir(), '.local/lib/node_modules/openclaw/dist');
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('channel-') && f.endsWith('.js'));
  if (files.length === 1) {
    bundlePath = path.join(distDir, files[0]);
    console.log('Bundle name changed, using: ' + files[0]);
  } else if (files.length > 1) {
    const match = files.find(f => {
      const content = fs.readFileSync(path.join(distDir, f), 'utf8');
      return content.includes('handleNextcloudTalkInbound');
    });
    if (match) {
      bundlePath = path.join(distDir, match);
      console.log('Found target bundle: ' + match);
    } else {
      console.error('Cannot find channel bundle with handleNextcloudTalkInbound. Files:', files);
      process.exit(1);
    }
  } else {
    console.error('No channel-*.js files found in dist/');
    process.exit(1);
  }
}

const MARKER = '/* ACK_REACTION_PATCH_V2 */';

let code = fs.readFileSync(bundlePath, 'utf8');

// Idempotency check (both V1 and V2)
if (code.includes(MARKER) || code.includes('ACK_REACTION_PATCH */')) {
  console.log('Patch already applied, skipping.');
  process.exit(0);
}

// Find the target
const target = 'async function handleNextcloudTalkInbound(params) {\n\tconst { message, account, config, runtime, statusSink } = params;';

if (!code.includes(target)) {
  console.error('Cannot find handleNextcloudTalkInbound entry point. Bundle may have changed.');
  process.exit(1);
}

const injection = [
  'async function handleNextcloudTalkInbound(params) {',
  '\t' + MARKER,
  '\tconst { message, account, config, runtime, statusSink } = params;',
  '\t// --- ACK REACTION: React with ⚡ immediately on receipt ---',
  '\t(async () => {',
  '\t\ttry {',
  '\t\t\tconst msgId = message.messageId;',
  '\t\t\tconst roomToken = message.roomToken;',
  '\t\t\tconst baseUrl = account.config.baseUrl;',
  '\t\t\tconst username = account.config.username;',
  '\t\t\tconst password = account.config.password;',
  '\t\t\tif (!msgId || !roomToken || !baseUrl || !username || !password) return;',
  '\t\t\tif (message.senderId === `users/${username}`) return;',
  '\t\t\tconst url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/reaction/${roomToken}/${msgId}`;',
  '\t\t\tconst auth = Buffer.from(`${username}:${password}`).toString("base64");',
  '\t\t\tconst { request } = require("https");',
  '\t\t\tconst body = JSON.stringify({ reaction: "⚡" });',
  '\t\t\tconst req = request(url, {',
  '\t\t\t\tmethod: "POST",',
  '\t\t\t\theaders: {',
  '\t\t\t\t\t"OCS-APIRequest": "true",',
  '\t\t\t\t\t"Accept": "application/json",',
  '\t\t\t\t\t"Content-Type": "application/json",',
  '\t\t\t\t\t"Authorization": `Basic ${auth}`,',
  '\t\t\t\t\t"Content-Length": Buffer.byteLength(body)',
  '\t\t\t\t},',
  '\t\t\t\ttimeout: 3000',
  '\t\t\t}, () => {});',
  '\t\t\treq.on("error", () => {});',
  '\t\t\treq.write(body);',
  '\t\t\treq.end();',
  '\t\t} catch(_) {}',
  '\t})();'
].join('\n');

code = code.replace(target, injection);

fs.writeFileSync(bundlePath, code, 'utf8');
console.log('Patch applied to ' + path.basename(bundlePath));
console.log('   - ⚡ reaction on inbound message receipt');
