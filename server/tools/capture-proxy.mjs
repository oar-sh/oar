#!/usr/bin/env node
/**
 * OpenAI BYOK Capture Proxy
 *
 * A lightweight HTTP→HTTPS forwarding proxy that logs the full request body
 * sent to the OpenAI API. Use this to inspect what the Copilot CLI actually
 * sends — specifically whether `store: false` is set (which would suppress
 * entries in platform.openai.com/logs).
 *
 * Usage:
 *   node server/tools/capture-proxy.mjs [--port 3035] [--target https://api.openai.com] [--force-store-true]
 *
 * Then in the relay settings UI, set the OpenAI Base URL to:
 *   http://localhost:3035/v1
 *
 * All requests will be logged here and forwarded to OpenAI.
 * After testing, reset the base URL back to https://api.openai.com/v1.
 */

'use strict';

import http from 'http';
import https from 'https';
import { URL } from 'url';

const args = process.argv.slice(2);
const portArgIdx = args.indexOf('--port');
const targetArgIdx = args.indexOf('--target');
const forceStoreTrue = args.includes('--force-store-true');
const PORT = portArgIdx !== -1 ? Number(args[portArgIdx + 1]) : 3035;
const TARGET = targetArgIdx !== -1 ? args[targetArgIdx + 1] : 'https://api.openai.com';

const targetUrl = new URL(TARGET);
const isHttps = targetUrl.protocol === 'https:';
const targetHost = targetUrl.hostname;
const targetPort = targetUrl.port ? Number(targetUrl.port) : (isHttps ? 443 : 80);

let requestCount = 0;

function truncate(str, max = 4000) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n... [truncated ${str.length - max} chars]`;
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function maybeForceStoreTrue(body) {
  if (!forceStoreTrue || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...body, store: true };
}

function logRequest(reqId, method, path, headers, bodyStr) {
  const body = tryParseJson(bodyStr);
  console.log('\n' + '═'.repeat(72));
  console.log(`[proxy] Request #${reqId}: ${method} ${path}`);
  console.log(`[proxy] Host: ${headers.host || targetHost}`);
  console.log(`[proxy] Authorization: ${headers.authorization ? headers.authorization.replace(/Bearer\s+(\S{4})\S*/, 'Bearer $1...') : '(none)'}`);
  if (body && typeof body === 'object') {
    // Key fields to highlight
    const highlighted = {};
    for (const key of ['model', 'store', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens', 'reasoning_effort']) {
      if (key in body) highlighted[key] = body[key];
    }
    console.log(`[proxy] KEY FIELDS: ${JSON.stringify(highlighted, null, 2)}`);
    if (body.messages) console.log(`[proxy] messages: ${body.messages.length} message(s)`);
    if (body.input) console.log(`[proxy] input: ${Array.isArray(body.input) ? body.input.length + ' item(s)' : typeof body.input}`);
    if (body.tools) console.log(`[proxy] tools: ${body.tools.length} tool(s)`);
    console.log(`[proxy] FULL BODY:\n${truncate(JSON.stringify(body, null, 2))}`);
  } else {
    console.log(`[proxy] RAW BODY:\n${truncate(bodyStr)}`);
  }
}

function logResponse(reqId, statusCode, headers, bodyStr) {
  const body = tryParseJson(bodyStr);
  console.log(`[proxy] Response #${reqId}: HTTP ${statusCode}`);
  if (body && typeof body === 'object') {
    const highlighted = {};
    for (const key of ['id', 'object', 'model', 'store', 'usage']) {
      if (key in body) highlighted[key] = body[key];
    }
    console.log(`[proxy] RESPONSE KEY FIELDS: ${JSON.stringify(highlighted, null, 2)}`);
  }
  console.log('─'.repeat(72));
}

const server = http.createServer((req, res) => {
  const reqId = ++requestCount;
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const originalBodyStr = Buffer.concat(chunks).toString('utf8');
    const parsedOriginal = tryParseJson(originalBodyStr);
    const rewrittenBody = maybeForceStoreTrue(parsedOriginal);
    const bodyStr = (
      rewrittenBody
      && typeof rewrittenBody === 'object'
      && !Array.isArray(rewrittenBody)
      && rewrittenBody !== parsedOriginal
    )
      ? JSON.stringify(rewrittenBody)
      : originalBodyStr;
    logRequest(reqId, req.method, req.url, req.headers, bodyStr);

    const forwardHeaders = { ...req.headers };
    forwardHeaders.host = targetHost;
    // Remove transfer-encoding so we can send a Content-Length
    delete forwardHeaders['transfer-encoding'];
    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    if (bodyBuf.length > 0) {
      forwardHeaders['content-length'] = String(bodyBuf.length);
    }

    const options = {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: forwardHeaders,
    };

    const transport = isHttps ? https : http;
    const proxyReq = transport.request(options, (proxyRes) => {
      const respChunks = [];
      proxyRes.on('data', (chunk) => respChunks.push(chunk));
      proxyRes.on('end', () => {
        const respStr = Buffer.concat(respChunks).toString('utf8');
        logResponse(reqId, proxyRes.statusCode, proxyRes.headers, respStr);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(respStr);
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[proxy] Forward error #${reqId}:`, err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'proxy-forward-failed', message: err.message }));
    });

    if (bodyBuf.length > 0) proxyReq.write(bodyBuf);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('╔' + '═'.repeat(70) + '╗');
  console.log('║  OpenAI BYOK Capture Proxy                                           ║');
  console.log('╠' + '═'.repeat(70) + '╣');
  console.log(`║  Listening : http://127.0.0.1:${PORT}                                     ║`);
  console.log(`║  Forwarding: ${TARGET}                                ║`);
  console.log('╠' + '═'.repeat(70) + '╣');
  console.log(`║  Force store:true: ${forceStoreTrue ? 'enabled' : 'disabled'}                                         ║`);
  console.log('╠' + '═'.repeat(70) + '╣');
  console.log('║  SETUP:                                                              ║');
  console.log(`║  1. In Relay settings → OpenAI → Base URL, set:                     ║`);
  console.log(`║     http://localhost:${PORT}/v1                                            ║`);
  console.log('║  2. Start a new BYOK conversation and send any message.              ║');
  console.log('║  3. Look for "store" in the KEY FIELDS output below.                 ║');
  console.log('║     store: false → no logs in platform.openai.com                   ║');
  console.log('║     store: true (or absent) → logs should appear                    ║');
  console.log('║  4. Reset Base URL to https://api.openai.com/v1 when done.          ║');
  console.log('╚' + '═'.repeat(70) + '╝\n');
});

process.on('SIGINT', () => {
  console.log('\n[proxy] Shutting down.');
  server.close();
  process.exit(0);
});
