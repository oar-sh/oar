import test from 'node:test';
import assert from 'node:assert/strict';

import { prefixToolActivityEmoji } from './tool-activity-emoji.mjs';

test('relay_tool tool lines get the satellite', () => {
  const line = 'Tool (relay_tool): send → linux-test session 01234567: “run the suite”';
  assert.equal(prefixToolActivityEmoji(line), `🛰️ ${line}`);
  assert.equal(prefixToolActivityEmoji('Tool (relay_tool): list_relays'), '🛰️ Tool (relay_tool): list_relays');
  // Claude's un-normalised MCP name.
  assert.equal(
    prefixToolActivityEmoji('Tool (mcp__relay__relay_tool): create_session → win-test'),
    '🛰️ Tool (mcp__relay__relay_tool): create_session → win-test',
  );
  // The Copilot CLI's <server>-<tool> name for an MCP tool.
  assert.equal(prefixToolActivityEmoji('Tool (oar-relay_tool): wait'), '🛰️ Tool (oar-relay_tool): wait');
});

test('lines written under the old name, remote_relay, keep the satellite', () => {
  assert.equal(prefixToolActivityEmoji('Tool (remote_relay): list_relays'), '🛰️ Tool (remote_relay): list_relays');
  assert.equal(prefixToolActivityEmoji('Tool (mcp__relay__remote_relay): wait'), '🛰️ Tool (mcp__relay__remote_relay): wait');
  assert.equal(prefixToolActivityEmoji('Tool (oar-remote_relay): wait'), '🛰️ Tool (oar-remote_relay): wait');
});

test('lookalikes and other tools keep their own emoji', () => {
  assert.equal(prefixToolActivityEmoji('Tool (relay_tool_extra): x'), '🛠️ Tool (relay_tool_extra): x');
  assert.equal(prefixToolActivityEmoji('Tool (remote_relay_extra): x'), '🛠️ Tool (remote_relay_extra): x');
  assert.equal(prefixToolActivityEmoji('Tool (powershell): Get-ChildItem'), '🪓 Tool (powershell): Get-ChildItem');
  assert.equal(prefixToolActivityEmoji('Tool (preview): open 5173'), '🛠️ Tool (preview): open 5173');
  assert.equal(prefixToolActivityEmoji('🛰️ Tool (relay_tool): wait'), '🛰️ Tool (relay_tool): wait');
  assert.equal(prefixToolActivityEmoji(''), '');
});
