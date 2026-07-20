/**
 * M3-P1: config externalization — homedir defaults + PT2_PROJECTS_ROOT.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ALLOWED_ROOT } from '../lib/transcript-reader.js';
import { DEFAULT_SOCKET_PATH } from '../lib/herdr-client.js';
import { startServer } from '../server.js';

describe('config externalization (M3-P1)', () => {
  it('DEFAULT_ALLOWED_ROOT is $HOME/.claude/projects', () => {
    assert.equal(
      DEFAULT_ALLOWED_ROOT,
      path.join(os.homedir(), '.claude/projects')
    );
  });

  it('DEFAULT_SOCKET_PATH is $HOME/.config/herdr/herdr.sock', () => {
    assert.equal(
      DEFAULT_SOCKET_PATH,
      path.join(os.homedir(), '.config/herdr/herdr.sock')
    );
  });

  it('PT2_PROJECTS_ROOT is wired into startServer state manager', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-projects-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const projectsRoot = path.join(tmp, 'projects');
    await fs.mkdir(projectsRoot);

    const prev = process.env.PT2_PROJECTS_ROOT;
    process.env.PT2_PROJECTS_ROOT = projectsRoot;

    const client = {
      rpc: async (method) => {
        if (method === 'ping') {
          return {
            type: 'pong',
            version: 'test',
            protocol: 16,
            capabilities: {},
          };
        }
        if (method === 'session.snapshot') {
          return {
            type: 'snapshot',
            snapshot: {
              workspaces: [],
              tabs: [],
              panes: [],
              agents: [],
            },
          };
        }
        if (method === 'pane.read') {
          return { read: { text: '' } };
        }
        throw new Error(`unexpected rpc: ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };

    let srv;
    try {
      srv = await startServer({
        host: '127.0.0.1',
        port: 0,
        stateDir,
        client,
        // leave allowedRoot unset so env path is used
      });
      assert.equal(srv.manager._internal.allowedRoot, projectsRoot);
    } finally {
      if (srv) await srv.close();
      if (prev === undefined) delete process.env.PT2_PROJECTS_ROOT;
      else process.env.PT2_PROJECTS_ROOT = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('options.allowedRoot wins over PT2_PROJECTS_ROOT', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-projects-opt-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const viaEnv = path.join(tmp, 'env-root');
    const viaOpt = path.join(tmp, 'opt-root');
    await fs.mkdir(viaEnv);
    await fs.mkdir(viaOpt);

    const prev = process.env.PT2_PROJECTS_ROOT;
    process.env.PT2_PROJECTS_ROOT = viaEnv;

    const client = {
      rpc: async (method) => {
        if (method === 'ping') {
          return {
            type: 'pong',
            version: 'test',
            protocol: 16,
            capabilities: {},
          };
        }
        if (method === 'session.snapshot') {
          return {
            type: 'snapshot',
            snapshot: { workspaces: [], tabs: [], panes: [], agents: [] },
          };
        }
        if (method === 'pane.read') return { read: { text: '' } };
        throw new Error(`unexpected rpc: ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };

    let srv;
    try {
      srv = await startServer({
        host: '127.0.0.1',
        port: 0,
        stateDir,
        client,
        allowedRoot: viaOpt,
      });
      assert.equal(srv.manager._internal.allowedRoot, viaOpt);
    } finally {
      if (srv) await srv.close();
      if (prev === undefined) delete process.env.PT2_PROJECTS_ROOT;
      else process.env.PT2_PROJECTS_ROOT = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
