/**
 * Tier A transcript-reader tests — synthetic fixtures only.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readMessages } from '../lib/transcript-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'projects');
const ALLOWED = FIXTURES;

describe('transcript-reader path safety', () => {
  let tmpDir;
  let outsideFile;
  let insideLink;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt2-escape-'));
    outsideFile = path.join(tmpDir, 'secret.jsonl');
    fs.writeFileSync(
      outsideFile,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: { role: 'user', content: 'should never read' },
      }) + '\n',
      'utf8'
    );
    // Symlink lives *inside* allowedRoot but points outside → must still reject.
    const escapeDir = path.join(ALLOWED, 'session-a');
    fs.mkdirSync(escapeDir, { recursive: true });
    insideLink = path.join(escapeDir, 'evil-link.jsonl');
    try {
      fs.unlinkSync(insideLink);
    } catch {
      /* ignore */
    }
    fs.symlinkSync(outsideFile, insideLink);
  });

  after(() => {
    try {
      fs.unlinkSync(insideLink);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects path traversal with ..', async () => {
    const bad = path.join(ALLOWED, '..', '..', 'package.json');
    await assert.rejects(
      () => readMessages(bad, { allowedRoot: ALLOWED }),
      (err) => err && /path|allow|escape|root|\.\./i.test(err.message)
    );
  });

  it('rejects .. segments even when they stay inside allowedRoot', async () => {
    // Do not use path.join — it normalizes away '..'. Keep raw segments.
    const sneaky = `${ALLOWED}${path.sep}session-a${path.sep}..${path.sep}session-a${path.sep}basic.jsonl`;
    assert.ok(sneaky.includes(`${path.sep}..${path.sep}`));
    await assert.rejects(
      () => readMessages(sneaky, { allowedRoot: ALLOWED }),
      (err) =>
        err &&
        (err.code === 'path_escape' || /\.\.|escape|path/i.test(err.message))
    );
    // Control: same file without .. is fine
    const ok = path.join(ALLOWED, 'session-a', 'basic.jsonl');
    const res = await readMessages(ok, { allowedRoot: ALLOWED });
    assert.ok(res.messages.length > 0);
  });

  it('rejects absolute path outside allowedRoot', async () => {
    await assert.rejects(
      () => readMessages(outsideFile, { allowedRoot: ALLOWED }),
      (err) => err && /path|allow|escape|root/i.test(err.message)
    );
  });

  it('rejects symlink that escapes allowedRoot', async () => {
    await assert.rejects(
      () => readMessages(insideLink, { allowedRoot: ALLOWED }),
      (err) => err && /path|allow|escape|root|symlink/i.test(err.message)
    );
  });
});

describe('transcript-reader mapping', () => {
  it('maps user text, agent text, tool_use; skips meta/progress types', async () => {
    const file = path.join(ALLOWED, 'session-a', 'basic.jsonl');
    const { messages, offset } = await readMessages(file, { allowedRoot: ALLOWED });
    assert.ok(offset > 0);
    assert.ok(messages.length >= 3);

    const roles = messages.map((m) => m.role);
    assert.ok(roles.includes('user'));
    assert.ok(roles.includes('agent'));
    assert.ok(roles.includes('system'));

    const user = messages.find((m) => m.role === 'user');
    assert.equal(user.text, '请总结一下今日进度');
    assert.ok(user.ts);

    const agentTexts = messages.filter((m) => m.role === 'agent').map((m) => m.text);
    assert.ok(agentTexts.some((t) => t.includes('脚手架') || t.includes('查看')));

    const tools = messages.filter((m) => m.role === 'system' && m.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.match(tools[0].summary, /Read/i);
    assert.ok(tools[0].ts);

    // mode / ai-title / system / last-prompt / tool_result-only user must not appear as chat
    assert.ok(!messages.some((m) => m.text === 'transient'));
    assert.ok(!messages.some((m) => m.role === 'user' && /note line one/.test(m.text || '')));
  });

  it('handles dense tool-use segments', async () => {
    const file = path.join(ALLOWED, 'session-a', 'tools-dense.jsonl');
    const { messages } = await readMessages(file, { allowedRoot: ALLOWED });
    const tools = messages.filter((m) => m.role === 'system' && m.kind === 'tool');
    assert.ok(tools.length >= 3, `expected ≥3 tools, got ${tools.length}`);
    const summaryBlob = tools.map((t) => t.summary).join('\n');
    assert.match(summaryBlob, /Edit/i);
    assert.match(summaryBlob, /Write/i);
    assert.match(summaryBlob, /Bash/i);
    const agents = messages.filter((m) => m.role === 'agent');
    assert.ok(agents.some((m) => /三个文件/.test(m.text)));
  });

  it('preserves CJK and long assistant output', async () => {
    const file = path.join(ALLOWED, 'session-a', 'cjk-long.jsonl');
    const { messages } = await readMessages(file, { allowedRoot: ALLOWED });
    const user = messages.find((m) => m.role === 'user');
    assert.match(user.text, /中文/);
    const agent = messages.find((m) => m.role === 'agent');
    assert.ok(agent.text.includes('中文句子'));
    assert.ok(agent.text.includes('line-49'));
    assert.ok(agent.text.length > 200);
    // isMeta user skipped
    assert.ok(!messages.some((m) => m.text === 'meta should skip'));
  });
});

describe('transcript-reader incremental offset', () => {
  it('continues from byte offset and ignores already-read lines', async () => {
    const file = path.join(ALLOWED, 'session-a', 'incremental.jsonl');
    const first = await readMessages(file, { afterOffset: 0, allowedRoot: ALLOWED });
    assert.ok(first.messages.length >= 2);
    assert.ok(first.offset > 0);

    const second = await readMessages(file, {
      afterOffset: first.offset,
      allowedRoot: ALLOWED,
    });
    assert.equal(second.messages.length, 0);
    assert.equal(second.offset, first.offset);

    // re-read from 0 gets full set again
    const again = await readMessages(file, { afterOffset: 0, allowedRoot: ALLOWED });
    assert.equal(again.messages.length, first.messages.length);
  });

  it('leaves incomplete trailing half-line for next read', async () => {
    const dir = path.join(ALLOWED, 'session-a');
    const file = path.join(dir, 'partial-runtime.jsonl');
    const line1 =
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T14:00:00.000Z',
        message: { role: 'user', content: 'complete line' },
      }) + '\n';
    const incompletePrefix =
      '{"type":"assistant","timestamp":"2026-07-01T14:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"half';
    fs.writeFileSync(file, line1 + incompletePrefix, 'utf8');

    try {
      const r1 = await readMessages(file, { afterOffset: 0, allowedRoot: ALLOWED });
      assert.equal(r1.messages.length, 1);
      assert.equal(r1.messages[0].role, 'user');
      // offset stops after last complete line; half-line not consumed
      assert.equal(r1.offset, Buffer.byteLength(line1, 'utf8'));

      // Finish the incomplete record by rewriting the full file (simulates
      // writer completing the line, then we resume from r1.offset).
      const completeAssistant =
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-01T14:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'half then full' }],
          },
        }) + '\n';
      fs.writeFileSync(file, line1 + completeAssistant, 'utf8');

      const r2 = await readMessages(file, {
        afterOffset: r1.offset,
        allowedRoot: ALLOWED,
      });
      assert.equal(r2.messages.length, 1);
      assert.equal(r2.messages[0].role, 'agent');
      assert.match(r2.messages[0].text, /half then full/);
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });
});
