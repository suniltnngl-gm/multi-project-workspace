import * as nodeFs from 'node:fs'
import os from 'node:os'

const MIB = 1024 * 1024

/**
 * Host telemetry with injectable getters. Memory: Linux /proc/meminfo MemAvailable (counts reclaimable cache),
 * os.freemem() elsewhere or when /proc/meminfo is unreadable. Pure given its getters.
 */
export function gatherTelemetry({
  platform = process.platform,
  readFile = (p) => nodeFs.readFileSync(p, 'utf8'),
  freemem = () => os.freemem(),
  loadavg = () => os.loadavg(),
  cpuCount = () => os.cpus().length
} = {}) {
  let freeMemoryMb = null
  let memorySource = 'os_freemem'
  if (platform === 'linux') {
    try {
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFile('/proc/meminfo'))
      if (m) {
        freeMemoryMb = Number(m[1]) / 1024
        memorySource = 'proc_meminfo_memavailable'
      }
    } catch { /* fall back to freemem */ }
  }
  if (freeMemoryMb === null) {
    try { freeMemoryMb = freemem() / MIB } catch { freeMemoryMb = Number.NaN }
  }
  let load = [0, 0, 0]
  try { load = loadavg() } catch { /* keep zeros */ }
  let cpus = 0
  try { cpus = cpuCount() } catch { cpus = 0 }
  return { freeMemoryMb, loadAvg1: Number(load?.[0] ?? 0), loadAvg: load, cpuCount: cpus, platform, memorySource }
}
