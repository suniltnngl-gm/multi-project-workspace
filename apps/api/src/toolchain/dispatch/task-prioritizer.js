/**
 * SP-009 deterministic task prioritizer for the swarm lifecycle.
 *
 * Ranks actionable tasks by:
 *   1. Priority tier (P0 > P1 > P2 > P3) + blocker/unblocks boost + cost-tier preference
 *      (local/daily favored over weekly/remote) - replan decay
 *   2. Pool-LRU tie-breaker (lastUsedByPool ascending)
 *   3. Lexical taskId tie-breaker
 */

export const PRIORITY_WEIGHTS = Object.freeze({
  P0: 100,
  P1: 70,
  P2: 40,
  P3: 10
})

export const COST_TIER_BONUS = Object.freeze({
  local: 15,
  daily: 10,
  monthly: 5,
  weekly: 0,
  remote: -5
})

export function scoreTask(task) {
  const priorityKey = String(task?.priority || 'P2').toUpperCase()
  const base = PRIORITY_WEIGHTS[priorityKey] ?? PRIORITY_WEIGHTS.P2
  const blockerBonus = task?.blocker ? 25 : 0
  const unblocksBonus = Math.min(50, Math.max(0, Number(task?.unblocksCount || 0)) * 10)
  const costKey = String(task?.costTier || 'daily').toLowerCase()
  const costBonus = COST_TIER_BONUS[costKey] ?? 0
  const replanPenalty = Math.max(0, Number(task?.replanCount || 0)) * 5
  return base + blockerBonus + unblocksBonus + costBonus - replanPenalty
}

export function rankTasks(tasks, { lastUsedByPool = {} } = {}) {
  const lru = (t) => {
    const pool = t?.pinned?.compositeKey?.split(':')[0] ?? t?.taskId ?? ''
    return lastUsedByPool[pool] ?? 0
  }
  return tasks.slice().sort((a, b) => {
    const diff = scoreTask(b) - scoreTask(a)
    if (diff !== 0) return diff
    const lruDiff = lru(a) - lru(b)
    if (lruDiff !== 0) return lruDiff
    return String(a.taskId || '').localeCompare(String(b.taskId || ''))
  })
}

/**
 * Select a safe parallel batch for a 2-core / 4-thread host:
 * - At most `maxLocalCpu` (default 1) local CPU job per batch
 * - Distinct quota pools only (no concurrent hits on the same pool)
 * - At most 1 `build` writer on the default checkout (unless distinct `worktree` is set)
 */
export function selectParallelBatch(tasks, { maxParallel = 2, maxLocalCpu = 1, lastUsedByPool = {} } = {}) {
  const ranked = rankTasks(tasks, { lastUsedByPool })
  const batch = []
  const usedPools = new Set()
  const usedWorktrees = new Set()
  const usedWriteFiles = new Set()
  const usedReadFiles = new Set()
  let localCpuCount = 0

  for (const t of ranked) {
    if (batch.length >= maxParallel) break
    const pool = t?.pinned?.compositeKey?.split(':')[0] ?? t?.costTier ?? t?.taskId
    if (usedPools.has(pool)) continue

    const isLocal = pool === 'local-llama-cpp' || t?.costTier === 'local'
    if (isLocal && localCpuCount >= maxLocalCpu) continue

    const wFiles = Array.isArray(t.writeFiles) ? t.writeFiles : []
    const rFiles = Array.isArray(t.readFiles) ? t.readFiles : []
    if (wFiles.some((f) => usedWriteFiles.has(f) || usedReadFiles.has(f))) continue
    if (rFiles.some((f) => usedWriteFiles.has(f))) continue

    const nextJob = (t.jobs || []).find((j) => j.status === 'pending')
    if (nextJob?.type === 'build') {
      const wt = t.worktree || 'default-checkout'
      if (usedWorktrees.has(wt)) continue
      usedWorktrees.add(wt)
    }

    usedPools.add(pool)
    for (const f of wFiles) usedWriteFiles.add(f)
    for (const f of rFiles) usedReadFiles.add(f)
    if (isLocal) localCpuCount++
    batch.push(t)
  }
  return batch
}
