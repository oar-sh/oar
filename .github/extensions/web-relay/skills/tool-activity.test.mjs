import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatToolActivity,
  formatToolResultActivity,
} from './tool-activity.mjs';

test('formats web search arguments with the query', () => {
  assert.equal(
    formatToolActivity({
      toolName: 'Web Search (MCP: github-mcp-server)',
      toolArgs: { query: 'Yani Neko animated gif' },
    }),
    'Web Search: Yani Neko animated gif',
  );
});

test('the OAR MCP remote_relay tool gets the same line as on every other engine', () => {
  assert.equal(
    formatToolActivity({
      toolName: 'oar-remote_relay',
      toolArgs: JSON.stringify({ action: 'send', relay: 'linux-test', session: '0123456789abcdef', text: 'run the suite' }),
    }),
    'Tool (remote_relay): send → linux-test session 01234567: “run the suite”',
  );
  assert.equal(formatToolActivity({ toolName: 'oar-remote_relay', toolArgs: {} }), 'Tool (remote_relay): call');
});

test('formats web fetch arguments with the URL', () => {
  assert.equal(
    formatToolActivity({
      toolName: 'web_fetch',
      toolArgs: { url: 'https://example.com/article' },
    }),
    'Web Fetch: https://example.com/article',
  );
});

test('formats output text from an MCP web search result', () => {
  assert.equal(
    formatToolResultActivity({
      toolName: 'Web Search (MCP: github-mcp-server)',
    }, {
      type: 'output_text',
      text: { value: "A search result's preview" },
    }),
    "Tool (Web Search (MCP: github-mcp-server)): output=\"A search result's preview\"",
  );
});

test('formats store_memory activity with all memory metadata', () => {
  assert.equal(
    formatToolActivity({
      toolName: 'store_memory',
      toolArgs: {
        subject: 'tooling',
        fact: 'A useful fact',
        citations: 'file.mjs:1',
        reason: 'Future work',
        scope: 'repository',
      },
    }),
    'Tool (store_memory):\nsubject="tooling"\nfact="A useful fact"\ncitations="file.mjs:1"\nreason="Future work"\nscope="repository"',
  );
});

test('formats vote_memory activity with all memory metadata', () => {
  assert.equal(
    formatToolActivity({
      toolName: 'vote_memory',
      toolArgs: {
        fact: 'A useful fact',
        direction: 'upvote',
        reason: 'Future work',
        scope: 'repository',
      },
    }),
    'Tool (vote_memory):\nfact="A useful fact"\ndirection="upvote"\nreason="Future work"\nscope="repository"',
  );
});
