/**
 * OpenCode config delivery check.
 *
 * The check exists because CodeMie injects provider config per run
 * (`OPENCODE_CONFIG_CONTENT`), but shared services and private standalone
 * launches have separate configuration contexts. Process markers cannot prove
 * effective profile delivery, and unrelated servers must not trigger kill advice.
 *
 * `findOpenCodeServers` takes `procRoot` so the scan runs against a fixture tree
 * instead of the live /proc.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  loadMock: vi.fn(),
}));

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    load: h.loadMock,
    listProfiles: vi.fn(),
    getActiveProfileName: vi.fn(),
  },
}));

import { OpenCodeConfigDeliveryCheck, findOpenCodeServers } from '../OpenCodeConfigDeliveryCheck.js';

/**
 * Fake procfs trees live under the system temp dir and are removed after the
 * suite, so a test run never leaves anything behind in the repository.
 */
const createdRoots: string[] = [];
const originalPlatform = process.platform;

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Build a fake procfs tree. `processes` maps pid -> { cmdline, env? }. */
function makeProc(processes: Record<string, { cmdline: string; env?: string | null }>): string {
  const root = mkdtempSync(join(tmpdir(), 'opencode-doctor-proc-'));
  createdRoots.push(root);
  for (const [pid, spec] of Object.entries(processes)) {
    const dir = join(root, pid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cmdline'), spec.cmdline);
    if (spec.env === null) {
      // Unreadable environment: no environ file at all.
      continue;
    }
    writeFileSync(join(dir, 'environ'), spec.env ?? '');
  }
  return root;
}

const nul = (...parts: string[]) => parts.join('\0');

describe('findOpenCodeServers', () => {
  it('detects a running opencode server', () => {
    const root = makeProc({
      100: { cmdline: nul('/home/u/.opencode/bin/opencode', 'serve', '--service'), env: '' },
    });

    const servers = findOpenCodeServers(root, 999);

    expect(servers).toHaveLength(1);
    expect(servers[0].pid).toBe(100);
    expect(servers[0].hasConfigMarkers).toBe(false);
  });

  it('observes configuration markers without treating them as proof of delivery', () => {
    const root = makeProc({
      100: {
        cmdline: nul('/home/u/.opencode/bin/opencode', 'serve', '--service'),
        env: nul('CODEMIE_BASE_URL=http://localhost:1234', 'OPENCODE_CONFIG_CONTENT={}'),
      },
    });

    const servers = findOpenCodeServers(root, 999);

    expect(servers[0].hasConfigMarkers).toBe(true);
  });

  it('ignores agent sessions and the CodeMie launcher', () => {
    const root = makeProc({
      100: { cmdline: nul('/home/u/.local/bin/opencode', 'run', 'do-something'), env: '' },
      101: {
        cmdline: nul('node', '/home/u/codemie-dev/bin/codemie-opencode.js'),
        env: nul('CODEMIE_BASE_URL=http://localhost:1234'),
      },
      102: { cmdline: nul('/usr/bin/opencode', 'run', 'serve'), env: '' },
      103: { cmdline: nul('/usr/bin/opencode-helper', 'serve'), env: '' },
    });

    expect(findOpenCodeServers(root, 999)).toEqual([]);
  });

  it('retains an unreadable environment as unknown rather than missing markers', () => {
    const root = makeProc({
      100: { cmdline: nul('/home/u/.opencode/bin/opencode', 'serve'), env: null },
    });

    const servers = findOpenCodeServers(root, 999);
    expect(servers).toHaveLength(1);
    expect(servers[0].hasConfigMarkers).toBeUndefined();
  });

  it('skips its own pid', () => {
    const root = makeProc({
      42: { cmdline: nul('/home/u/.opencode/bin/opencode', 'serve'), env: '' },
    });

    expect(findOpenCodeServers(root, 42)).toEqual([]);
  });

  it('does not present an unreadable proc root as an empty process list', () => {
    expect(() => findOpenCodeServers('/nonexistent-proc-root', 999)).toThrow();
  });
});

describe('OpenCodeConfigDeliveryCheck', () => {
  beforeEach(() => {
    h.loadMock.mockReset();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  it('reports info and does not warn without an active profile', async () => {
    h.loadMock.mockResolvedValue({ provider: 'ai-run-sso' });

    const result = await new OpenCodeConfigDeliveryCheck().run();

    expect(result.success).toBe(true);
    expect(result.details[0].status).toBe('info');
    expect(result.details[0].message).toContain('No profile base URL');
  });

  it('does not claim a foreign server shadows an isolated v2 launch or suggest killing it', async () => {
    h.loadMock.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: 'http://localhost:1234' });

    const procRoot = makeProc({
      4242: { cmdline: nul('/home/u/.opencode/bin/opencode', 'serve', '--service'), env: '' },
    });

    const result = await new OpenCodeConfigDeliveryCheck(procRoot).run();

    expect(result.success).toBe(true);
    expect(result.details[0].status).toBe('info');
    expect(result.details[0].message).toContain('pid 4242');
    expect(result.details[0].message).toContain('no configuration environment markers');
    expect(result.details[0].message).toContain('not verified');
    expect(result.details[0].message).not.toContain('ignore your profile');
    expect(result.details[0].hint).toContain('--standalone');
    expect(result.details[0].hint).toContain('shared or remote server');
    expect(result.details[0].hint).not.toMatch(/\b(?:pkill|kill|restart)\b/);
  });

  it.each([
    nul('CODEMIE_BASE_URL=http://localhost:1234'),
    nul('OPENCODE_CONFIG=/another-profile.json'),
    nul('OPENCODE_CONFIG_CONTENT='),
    null,
  ])('never verifies active profile delivery from environment markers alone: %s', async (env) => {
    h.loadMock.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: 'http://localhost:1234' });

    const procRoot = makeProc({
      7: {
        cmdline: nul('/home/u/.opencode/bin/opencode', 'serve', '--service'),
        env,
      },
    });

    const result = await new OpenCodeConfigDeliveryCheck(procRoot).run();

    expect(result.success).toBe(true);
    expect(result.details[0].status).toBe('info');
    expect(result.details[0].message).toContain('not verified');
    expect(result.details[0].message).toContain(env === null ? 'environment could not be read' : 'markers are present');
  });

  it('does not claim successful delivery when no OpenCode server is detected', async () => {
    h.loadMock.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: 'http://localhost:1234' });

    const procRoot = makeProc({
      3: { cmdline: nul('/usr/bin/bash', '-c', 'sleep 1'), env: '' },
    });

    const result = await new OpenCodeConfigDeliveryCheck(procRoot).run();

    expect(result.success).toBe(true);
    expect(result.details[0].status).toBe('info');
    expect(result.details[0].message).toContain('No pre-existing OpenCode server');
    expect(result.details[0].message).toContain('not verified');
  });
});
