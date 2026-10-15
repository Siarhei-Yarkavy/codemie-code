/**
 * OpenCode config delivery health check
 *
 * CodeMie never writes its provider configuration into OpenCode's own config
 * files — it injects it per run through `OPENCODE_CONFIG_CONTENT` (inline) or
 * `OPENCODE_CONFIG` (temp file).
 *
 * OpenCode v2's shared service and a private `--standalone` server have different
 * configuration contexts. An unrelated shared server does not shadow a private
 * launch. Doctor does not know the next invocation's server selection, and a
 * process environment cannot prove which profile or configuration was loaded.
 * Report process observations as information, never as verified delivery or a
 * reason to terminate another session. No configuration values are exposed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigLoader } from '@/utils/config.js';
import type { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

/**
 * Configuration-related markers are observations only. They can be inherited,
 * empty or belong to another profile; they never prove effective configuration.
 */
const INJECTION_MARKERS = ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'CODEMIE_BASE_URL'];

interface ServerProcess {
  pid: number;
  cmdline: string;
  hasConfigMarkers: boolean | undefined;
}

export class OpenCodeConfigDeliveryCheck implements HealthCheck {
  name = 'OpenCode Config Delivery';

  /**
   * @param procRoot procfs mount point. Injectable so the scan can run against a
   *   fixture tree in tests; production always uses the real `/proc`.
   */
  constructor(private readonly procRoot: string = '/proc') {}

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      // This check observes URL-backed provider configuration only.
      const config = await ConfigLoader.load();
      if (!config?.baseUrl) {
        details.push({
          status: 'info',
          message: 'No profile base URL — OpenCode config delivery is not assessed'
        });
        return { name: this.name, success, details };
      }

      // Process environments are read through procfs; there is no portable
      // equivalent, so other platforms report what was not checked instead of
      // pretending the delivery path is verified.
      if (process.platform !== 'linux') {
        details.push({
          status: 'info',
          message: `Running OpenCode server detection is not supported on ${process.platform}`
        });
        return { name: this.name, success, details };
      }

      const servers = findOpenCodeServers(this.procRoot);

      if (servers.length === 0) {
        details.push({
          status: 'info',
          message: 'No pre-existing OpenCode server detected — config delivery is not verified'
        });
        return { name: this.name, success, details };
      }

      for (const server of servers) {
        const observation = server.hasConfigMarkers === undefined
          ? 'environment could not be read'
          : server.hasConfigMarkers
            ? 'configuration environment markers are present'
            : 'no configuration environment markers were found';
        details.push({
          status: 'info',
          message: `OpenCode server (pid ${server.pid}): ${observation} — active profile delivery is not verified`,
          hint: 'For OpenCode v2, use codemie-opencode --standalone for an isolated TUI. If you explicitly select a shared or remote server, verify its configuration without stopping unrelated sessions.'
        });
      }
    } catch (error) {
      details.push({
        status: 'error',
        message: 'Failed to check OpenCode config delivery',
        hint: error instanceof Error ? error.message : String(error)
      });
      success = false;
    }

    return { name: this.name, success, details };
  }
}

/**
 * Whether a command line belongs to an OpenCode *server* rather than an agent
 * session or the CodeMie launcher that spawns one.
 */
function isOpenCodeServerCmdline(segments: string[]): boolean {
  const executable = segments[0] ?? '';
  const base = executable.split('/').pop() ?? '';

  // The CodeMie launcher (`codemie-opencode`) wraps the binary and is not the
  // server itself; excluding it keeps the warning about foreign sessions.
  if (base.includes('codemie')) return false;

  const isOpenCodeBinary = base === 'opencode' || base === 'opencode-ai';

  if (!isOpenCodeBinary) return false;

  return segments[1] === 'serve';
}

/**
 * Read the environment of a process. Returns undefined when it cannot be read
 * (foreign user, exited mid-scan) so an unreadable environment is never
 * reported as missing configuration markers.
 */
function readEnvHasConfigMarkers(procRoot: string, pid: number): boolean | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), 'environ'), 'utf-8');
  } catch {
    return undefined;
  }

  const names = raw.split('\0').filter(Boolean).map((entry) => entry.split('=')[0]);
  return INJECTION_MARKERS.some((marker) => names.includes(marker));
}

/**
 * Enumerate running OpenCode server processes.
 *
 * An unreadable environment remains unknown, not missing. A failed procfs scan
 * propagates to the health check rather than pretending no servers exist.
 */
export function findOpenCodeServers(procRoot = '/proc', selfPid = process.pid): ServerProcess[] {
  const pids = readdirSync(procRoot);

  const servers: ServerProcess[] = [];

  for (const entry of pids) {
    const pid = Number(entry);
    if (!/^\d+$/.test(entry) || !Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue;

    let raw: string;
    try {
      raw = readFileSync(join(procRoot, entry, 'cmdline'), 'utf-8');
    } catch {
      continue;
    }

    const segments = raw.split('\0').filter(Boolean);
    if (!isOpenCodeServerCmdline(segments)) continue;

    const hasConfigMarkers = readEnvHasConfigMarkers(procRoot, pid);
    servers.push({ pid, cmdline: segments.join(' '), hasConfigMarkers });
  }

  return servers;
}
