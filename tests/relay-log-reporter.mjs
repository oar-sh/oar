// Prints the shared test relay's output for a spec that failed: what the
// relay logged while the spec ran (its refusals, its errors), read from the
// redacted log file tests/run-e2e.mjs has the relay write
// (RELAY_TEST_LOG_FILE). OAR_E2E_DUMP_RELAY_LOG=1 prints it for every spec.
// The suite runs one worker, so the lines between a spec's start and its end
// are that spec's (and its retry's own).

import fs from "node:fs";

const MAX_BYTES = 32 * 1024;

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function readSince(file, start) {
  const end = fileSize(file);
  if (!file || end <= start) return "";
  const from = Math.max(start, end - MAX_BYTES);
  const buffer = Buffer.alloc(end - from);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, buffer.length, from); } finally { fs.closeSync(fd); }
  return `${from > start ? `[… ${from - start} bytes before]\n` : ""}${buffer.toString("utf8")}`;
}

export default class RelayLogReporter {
  constructor() {
    this.file = String(process.env.RELAY_TEST_LOG_FILE || "").trim();
    this.always = String(process.env.OAR_E2E_DUMP_RELAY_LOG || "").trim() === "1";
    this.starts = new Map();
  }

  printsToStdio() {
    return false;
  }

  onTestBegin(test, result) {
    if (this.file) this.starts.set(`${test.id}#${result.retry}`, fileSize(this.file));
  }

  onTestEnd(test, result) {
    if (!this.file) return;
    const key = `${test.id}#${result.retry}`;
    const start = this.starts.get(key) ?? 0;
    this.starts.delete(key);
    const failed = result.status !== "passed" && result.status !== "skipped";
    if (!failed && !this.always) return;
    const text = readSince(this.file, start);
    const title = test.titlePath().filter(Boolean).join(" › ");
    process.stdout.write(`\n--- relay log for ${title} (${result.status}, run ${result.retry + 1}) ---\n${text || "(nothing logged)\n"}--- end of relay log ---\n`);
  }
}
