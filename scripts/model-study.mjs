#!/usr/bin/env node
// Objective: Study OpenCode provider and model availability daily with a minimal prompt.
// Requirements: Test one model at a time; default to free models; never spend real task quota just to measure a model; treat a live 429 as authoritative and record its retry hint.
// Decisions: The study shell calls `opencode run` directly instead of the API so it can vary the model id per test; results persist under the OS temp directory (WORKSPACE_TMP_DIR override) so study output never enters the repository; free-model filtering keeps the daily run bounded.
// Relevant Files: scripts/model-study.mjs, scripts/opencode-console.mjs, scripts/rotate-model.mjs, apps/api/src/modelClient.js
// Important Context: User file. Run only alongside a main task in scope, not as idle quota burn.
// Work State: Completed: Added for daily free-model study; Active: None; Blocked: None; Next Move: Maintain as needed.
/**
 * Daily model study: test all available OpenCode models with a simple "hi" prompt.
 * Records latency, response quality, errors, and quota status without burning quota on main tasks.
 * Run daily to build a model capability matrix.
 */
import { join } from 'node:path'
import { loadWorkspaceEnv, workspaceTmpDir } from './env.mjs'
import { spawn } from 'node:child_process'

loadWorkspaceEnv()

const TEST_PROMPT = 'hi'
const TIMEOUT_MS = 30000
const TMP_DIR = workspaceTmpDir()
const STATE_FILE = join(TMP_DIR, 'model-study.json')
const RESULTS_DIR = join(TMP_DIR, 'model-study-results')

async function getAvailableModels() {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (d) => stdout += d)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`opencode models exited ${code}`))
      else resolve(stdout.trim().split('\n').filter(Boolean).map(l => l.trim()))
    })
  })
}

async function testModel(modelId, testNumber, total) {
  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn('opencode', ['run', TEST_PROMPT, '--format', 'json', '--model', modelId], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS
    })

    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => stdout += d)
    child.stderr.on('data', (d) => stderr += d)

    child.on('close', (code) => {
      const latencyMs = Date.now() - start
      const result = {
        model: modelId,
        testNumber,
        total,
        timestamp: new Date().toISOString(),
        latencyMs,
        exitCode: code,
        success: false,
        response: '',
        error: null,
        quotaExhausted: false,
        retryAfter: null
      }

      if (code === 0) {
        // Parse JSON events for text response
        let textContent = ''
        for (const line of stdout.trim().split('\n')) {
          try {
            const event = JSON.parse(line.trim())
            if (event.type === 'text' && event.part?.text) {
              textContent += event.part.text
            }
          } catch {}
        }
        result.success = true
        result.response = textContent.slice(0, 500)
      } else {
        // Check for quota error in stderr/stdout
        const combined = stdout + stderr
        if (combined.includes('quota') || combined.includes('429') || combined.includes('RESOURCE_EXHAUSTED')) {
          result.quotaExhausted = true
          // Try to extract retry delay
          const retryMatch = combined.match(/"retryDelay":"(\d+)s"/) || combined.match(/retry in ([\dhms\s]+)/)
          if (retryMatch) result.retryAfter = retryMatch[1]
        }
        result.error = stderr.slice(0, 500) || stdout.slice(0, 500) || `Exit code ${code}`
      }

      resolve(result)
    })

    child.on('error', (err) => {
      resolve({
        model: modelId,
        testNumber,
        total,
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - start,
        exitCode: -1,
        success: false,
        response: '',
        error: err.message,
        quotaExhausted: false,
        retryAfter: null
      })
    })
  })
}

async function loadState() {
  try {
    const content = await import('node:fs/promises').then(fs => fs.readFile(STATE_FILE, 'utf8'))
    return JSON.parse(content)
  } catch {
    return { lastRun: null, runs: [] }
  }
}

async function saveState(state) {
  await import('node:fs/promises').then(fs => fs.mkdir(RESULTS_DIR, { recursive: true }))
  await import('node:fs/promises').then(fs => fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2)))
}

function printSummary(results) {
  console.log('\n' + '='.repeat(80))
  console.log('MODEL STUDY SUMMARY')
  console.log('='.repeat(80))
  console.log(`Test prompt: "${TEST_PROMPT}"`)
  console.log(`Timestamp: ${new Date().toISOString()}`)
  console.log(`Total models tested: ${results.length}`)
  
  const successful = results.filter(r => r.success && !r.quotaExhausted)
  const quotaExhausted = results.filter(r => r.quotaExhausted)
  const failed = results.filter(r => !r.success && !r.quotaExhausted)
  
  console.log(`\n✅ Successful: ${successful.length}`)
  console.log(`⚠️  Quota exhausted: ${quotaExhausted.length}`)
  console.log(`❌ Failed: ${failed.length}`)
  
  if (successful.length > 0) {
    console.log('\n--- Successful models ---')
    for (const r of successful) {
      const preview = r.response.replace(/\n/g, ' ').slice(0, 80)
      console.log(`  ${r.model}: ${r.latencyMs}ms - "${preview}..."`)
    }
  }
  
  if (quotaExhausted.length > 0) {
    console.log('\n--- Quota exhausted ---')
    for (const r of quotaExhausted) {
      console.log(`  ${r.model}: retryAfter=${r.retryAfter || 'unknown'}`)
    }
  }
  
  if (failed.length > 0) {
    console.log('\n--- Failed ---')
    for (const r of failed) {
      console.log(`  ${r.model}: ${r.error?.slice(0, 100)}`)
    }
  }
  
  console.log('\n' + '='.repeat(80))
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const onlyFree = !args.includes('--all') // default to free models only
  
  console.log('🔬 Starting daily model study...')
  console.log(`Mode: ${onlyFree ? 'free models only' : 'all models'}`)
  
  const models = await getAvailableModels()
  console.log(`Found ${models.length} models`)
  
  // Filter free models if requested
  const testModels = onlyFree 
    ? models.filter(m => m.includes(':free') || m.startsWith('opencode/') && m.endsWith('-free'))
    : models
  
  console.log(`Testing ${testModels.length} models${dryRun ? ' (dry run)' : ''}`)
  
  if (dryRun) {
    for (const m of testModels) console.log(`  - ${m}`)
    return
  }
  
  const results = []
  for (let i = 0; i < testModels.length; i++) {
    const model = testModels[i]
    process.stdout.write(`\r[${i+1}/${testModels.length}] Testing ${model}... `)
    const result = await testModel(model, i+1, testModels.length)
    results.push(result)
    if (result.success) process.stdout.write('✅')
    else if (result.quotaExhausted) process.stdout.write('⚠️')
    else process.stdout.write('❌')
  }
  console.log('\n')
  
  printSummary(results)
  
  // Save results
  const state = await loadState()
  state.lastRun = new Date().toISOString()
  state.runs.push({ timestamp: state.lastRun, results })
  // Keep last 30 runs
  if (state.runs.length > 30) state.runs = state.runs.slice(-30)
  await saveState(state)
  
  // Also save individual run for easy access
  const runFile = `${RESULTS_DIR}/run-${Date.now()}.json`
  await import('node:fs/promises').then(fs => fs.writeFile(runFile, JSON.stringify({ timestamp: state.lastRun, results }, null, 2)))
  console.log(`\nResults saved to ${STATE_FILE} and ${runFile}`)
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})