/**
 * Objective: Implement and maintain apps/api/src/resourceMonitor.js.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: apps/api/src/resourceMonitor.js
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'

const DISK_SAMPLE_INTERVAL_MS = 5000

function parseAvailableMemory(contents) {
  const match = contents.match(/^MemAvailable:\s+(\d+)\s+kB$/m)
  if (!match) throw new Error('MemAvailable was not found in /proc/meminfo.')
  return Number(match[1]) / 1024
}

function parseDiskIoTimes(contents, blockDevices) {
  const deviceIoTimes = new Map()
  for (const line of contents.trim().split('\n')) {
    const fields = line.trim().split(/\s+/)
    const name = fields[2]
    if (!blockDevices.has(name)) continue
    const ioTimeMs = Number(fields[12])
    if (Number.isFinite(ioTimeMs)) deviceIoTimes.set(name, ioTimeMs)
  }
  if (deviceIoTimes.size === 0) {
    throw new Error('No physical disk activity counters were found in /proc/diskstats.')
  }
  return deviceIoTimes
}

function isPhysicalBlockDevice(name) {
  return !/^(?:loop|ram|zram|dm-|md)/.test(name)
}

export function createResourceMonitor({
  readText = readFile,
  readDirectory = readdir,
  getLoadAverage = () => os.loadavg()[0],
  getTime = () => performance.now(),
  wait = delay
} = {}) {
  let previousDiskSample
  let diskBusyPercent

  async function readSnapshot() {
    const [memoryInfo, diskStats, entries] = await Promise.all([
      readText('/proc/meminfo', 'utf8'),
      readText('/proc/diskstats', 'utf8'),
      readDirectory('/sys/block')
    ])
    const blockDevices = new Set(entries.filter(isPhysicalBlockDevice))
    return {
      loadAverage: getLoadAverage(),
      availableMemoryMb: parseAvailableMemory(memoryInfo),
      deviceIoTimes: parseDiskIoTimes(diskStats, blockDevices)
    }
  }

  return async function getResourceMetrics() {
    if (process.platform !== 'linux') {
      throw new Error('Local AI resource monitoring currently requires Linux.')
    }

    let current = await readSnapshot()
    let currentTime = getTime()
    if (!previousDiskSample) {
      previousDiskSample = { deviceIoTimes: current.deviceIoTimes, time: currentTime }
      await wait(DISK_SAMPLE_INTERVAL_MS)
      current = await readSnapshot()
      currentTime = getTime()
    }

    const elapsedMs = currentTime - previousDiskSample.time
    if (diskBusyPercent !== undefined && elapsedMs < DISK_SAMPLE_INTERVAL_MS) {
      return {
        loadAverage: current.loadAverage,
        availableMemoryMb: current.availableMemoryMb,
        diskBusyPercent
      }
    }

    const deviceBusyPercentages = []
    for (const [device, currentIoTime] of current.deviceIoTimes) {
      const previousIoTime = previousDiskSample.deviceIoTimes.get(device)
      if (previousIoTime === undefined) continue
      const deltaIoTime = currentIoTime - previousIoTime
      if (deltaIoTime < 0 || elapsedMs <= 0) {
        throw new Error(`Could not measure disk activity for ${device}.`)
      }
      deviceBusyPercentages.push(Math.min(100, deltaIoTime / elapsedMs * 100))
    }
    if (deviceBusyPercentages.length === 0) {
      throw new Error('Disk activity could not be measured for a physical device.')
    }

    previousDiskSample = { deviceIoTimes: current.deviceIoTimes, time: currentTime }
    diskBusyPercent = Math.max(...deviceBusyPercentages)
    return {
      loadAverage: current.loadAverage,
      availableMemoryMb: current.availableMemoryMb,
      diskBusyPercent
    }
  }
}
