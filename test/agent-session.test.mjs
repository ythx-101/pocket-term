/**
 * Tier A agent_session object handling (exact live herdr:claude shapes).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseAgentSession,
  resolveAgentSessionPath,
  findTranscriptBySessionId,
  agentSessionCacheKey,
  createStateManager,
} from '../lib/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECTS = path.join(__dirname, 'fixtures', 'projects');

describe('parseAgentSession — live object shapes', () => {
  it('kind=id (observed live after claude integration)', () => {
    const pane = {
      pane_id: 'w9:pA',
      agent: 'claude',
      agent_session: {
        source: 'herdr:claude',
        agent: 'claude',
        kind: 'id',
        value: 'f5af12fc-caf6-46fc-b45c-96bbe16cf4c9',
      },
    };
    assert.deepEqual(parseAgentSession(pane), {
      kind: 'id',
      value: 'f5af12fc-caf6-46fc-b45c-96bbe16cf4c9',
    });
  });

  it('kind=path object shape', () => {
    const pane = {
      pane_id: 'w9:p1',
      agent_session: {
        source: 'herdr:claude',
        agent: 'claude',
        kind: 'path',
        value: '/home/user/.claude/projects/-home-user/abc.jsonl',
      },
    };
    assert.deepEqual(parseAgentSession(pane), {
      kind: 'path',
      value: '/home/user/.claude/projects/-home-user/abc.jsonl',
    });
  });

  it('legacy string agent_session still works', () => {
    assert.deepEqual(
      parseAgentSession({
        agent_session: '/home/user/.claude/projects/-home-user/legacy.jsonl',
      }),
      { kind: 'path', value: '/home/user/.claude/projects/-home-user/legacy.jsonl' }
    );
  });

  it('missing / unknown → null', () => {
    assert.equal(parseAgentSession({}), null);
    assert.equal(
      parseAgentSession({
        agent_session: { kind: 'other', value: 'x' },
      }),
      null
    );
  });
});

describe('resolveAgentSessionPath', () => {
  const knownId = 'tier-a-session-id';
  let tmpRoot;
  let subdir;
  let jsonlPath;

  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-tiera-'));
    subdir = path.join(tmpRoot, '-root');
    await fs.mkdir(subdir, { recursive: true });
    jsonlPath = path.join(subdir, `${knownId}.jsonl`);
    await fs.writeFile(
      jsonlPath,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
      'utf8'
    );
  });

  after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('kind=path resolves under allowedRoot', async () => {
    const resolved = await resolveAgentSessionPath(
      { kind: 'path', value: jsonlPath },
      tmpRoot
    );
    assert.equal(resolved, await fs.realpath(jsonlPath));
  });

  it('kind=id finds <value>.jsonl one subdir deep', async () => {
    const found = await findTranscriptBySessionId(tmpRoot, knownId);
    assert.ok(found);
    assert.equal(path.basename(found), `${knownId}.jsonl`);

    const resolved = await resolveAgentSessionPath(
      { kind: 'id', value: knownId },
      tmpRoot
    );
    assert.equal(resolved, await fs.realpath(jsonlPath));
  });

  it('kind=id that does not resolve → null (Tier B)', async () => {
    const resolved = await resolveAgentSessionPath(
      {
        kind: 'id',
        value: '00000000-0000-0000-0000-000000000000',
      },
      tmpRoot
    );
    assert.equal(resolved, null);
  });

  it('kind=path outside allowedRoot → null', async () => {
    const resolved = await resolveAgentSessionPath(
      { kind: 'path', value: '/etc/passwd' },
      tmpRoot
    );
    assert.equal(resolved, null);
  });

  it('rejects id with path separators', async () => {
    const resolved = await resolveAgentSessionPath(
      { kind: 'id', value: '../escape' },
      tmpRoot
    );
    assert.equal(resolved, null);
  });

  it('fixture projects: resolve existing synthetic session file by id', async () => {
    // Place a uuid-named jsonl under fixtures/projects/session-a/
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const file = path.join(FIXTURE_PROJECTS, 'session-a', `${id}.jsonl`);
    await fs.writeFile(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'tier a ok' }],
        },
      }) + '\n',
      'utf8'
    );
    try {
      const resolved = await resolveAgentSessionPath(
        { kind: 'id', value: id },
        FIXTURE_PROJECTS
      );
      assert.ok(resolved);
      assert.ok(resolved.endsWith(`${id}.jsonl`));
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  });
});

describe('createStateManager resolvePaneTranscript cache', () => {
  it('caches id resolution as Tier A; unknown id stays Tier B', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-mgr-'));
    const sub = path.join(tmpRoot, 'proj');
    await fs.mkdir(sub, { recursive: true });
    const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const file = path.join(sub, `${id}.jsonl`);
    await fs.writeFile(file, '{}\n', 'utf8');
    const stateDir = path.join(tmpRoot, 'state');
    await fs.mkdir(stateDir);

    // Stub client unused — we only exercise resolvePaneTranscript (no start()).
    const client = {
      rpc: async () => {
        throw new Error('rpc should not be called');
      },
      subscribe: () => ({ dead: false, close() {} }),
    };

    const mgr = createStateManager({
      client,
      stateDir,
      allowedRoot: tmpRoot,
    });
    try {
      const liveShape = {
        source: 'herdr:claude',
        agent: 'claude',
        kind: 'id',
        value: id,
      };
      const pathA = await mgr._internal.resolvePaneTranscript({
        pane_id: 'w1:p1',
        agent_session: liveShape,
      });
      assert.ok(pathA);
      const rt1 = mgr._internal.ensureRuntime('w1:p1');
      assert.equal(rt1.tier, 'A');
      assert.equal(
        rt1.sessionCacheKey,
        agentSessionCacheKey({ kind: 'id', value: id })
      );

      const again = await mgr._internal.resolvePaneTranscript({
        pane_id: 'w1:p1',
        agent_session: liveShape,
      });
      assert.equal(again, pathA);

      const pathB = await mgr._internal.resolvePaneTranscript({
        pane_id: 'w1:p2',
        agent_session: {
          source: 'herdr:claude',
          agent: 'claude',
          kind: 'id',
          value: 'nonexistent-id-zzzz',
        },
      });
      assert.equal(pathB, null);
      assert.equal(mgr._internal.ensureRuntime('w1:p2').tier, 'B');
    } finally {
      await mgr.stop();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
