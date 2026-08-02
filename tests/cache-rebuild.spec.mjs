import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";

function insertTestConversation(db, {
  id,
  title,
  sdkSessionId = null,
  archived = 0,
  status = "active",
}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO conversations (
      id, title, archived, compacted_into, compacted_from, summary_seed, seed_pending, status,
      created_at, updated_at, sdk_session_id
    ) VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?)
  `).run(id, title, archived, status, now, now, sdkSessionId);
}

function insertTestMessage(db, { id, conversationId, role, text }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
  `).run(id, conversationId, role, text, now);
}

function insertRuntimeSession(db, { id, conversationId, sdkSessionId = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO runtime_sessions (
      id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at, sdk_session_id
    ) VALUES (?, ?, 'isolated', ?, NULL, 'active', ?, ?, ?)
  `).run(id, conversationId, id, now, now, sdkSessionId);
}

test("reconciles legacy cache rows without touching bound conversations", async ({ request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const db = new DatabaseSync(relayDbPath());
  const stamp = Date.now();
  const legacyConversationId = `legacy-cache-${stamp}`;
  const boundConversationId = `bound-cache-${stamp}`;
  const boundSdkSessionId = `sdk-cache-${stamp}`;
  const legacyMessageId = `legacy-message-${stamp}`;
  const boundMessageId = `bound-message-${stamp}`;

  try {
    insertTestConversation(db, {
      id: legacyConversationId,
      title: "Legacy cache conversation",
      sdkSessionId: null,
    });
    insertTestMessage(db, {
      id: legacyMessageId,
      conversationId: legacyConversationId,
      role: "user",
      text: "legacy turn",
    });

    insertTestConversation(db, {
      id: boundConversationId,
      title: "Bound cache conversation",
      sdkSessionId: boundSdkSessionId,
    });
    insertTestMessage(db, {
      id: boundMessageId,
      conversationId: boundConversationId,
      role: "user",
      text: "bound turn",
    });

    const rebuild = await request.post("/api/cache/rebuild", {
      headers,
      data: { mode: "reconcile" },
    });
    expect(rebuild.ok()).toBeTruthy();
    const rebuildBody = await rebuild.json();

    expect(String(rebuildBody?.mode || "")).toBe("reconcile");
    expect(rebuildBody?.summary?.purgedConversationIds || []).toContain(legacyConversationId);
    expect(rebuildBody?.summary?.runtimeSessionsBootstrapped || 0).toBeGreaterThanOrEqual(1);

    const legacyConversation = await request.get(`/api/conversation/${legacyConversationId}`, { headers });
    expect(legacyConversation.status()).toBe(404);

    const boundConversation = await request.get(`/api/conversation/${boundConversationId}`, { headers });
    expect(boundConversation.ok()).toBeTruthy();
    const boundBody = await boundConversation.json();
    expect(String(boundBody?.sdkSessionId || "")).toBe(boundSdkSessionId);

    const sessions = await request.get("/api/sessions", { headers });
    expect(sessions.ok()).toBeTruthy();
    const sessionsBody = await sessions.json();
    expect(Array.isArray(sessionsBody?.sessions)).toBeTruthy();
    expect(sessionsBody.sessions.some((row) => String(row.conversationId || "") === boundConversationId)).toBeTruthy();
    expect(sessionsBody.sessions.some((row) => String(row.conversationId || "") === legacyConversationId)).toBeFalsy();
  } finally {
    db.close();
  }
});
