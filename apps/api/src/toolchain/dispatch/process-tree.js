import { spawnSync as nodeSpawnSync } from 'node:child_process'

/**
 * Terminates a child and its descendants. POSIX: kill the whole process group (children are spawned
 * detached). Windows: `taskkill /PID <pid> /T /F` (signals are not meaningful there).
 */
export function terminateTree({ child, platform = process.platform, signal = 'SIGTERM', kill = process.kill.bind(process), spawnSync = nodeSpawnSync }) {
  const pid = child?.pid
  if (!pid) {
    try { child?.kill?.(signal) } catch { /* already gone */ }
    return
  }
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    kill(-pid, signal)
  } catch {
    try { kill(pid, signal) } catch { /* already gone */ }
  }
}
