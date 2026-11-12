#!/usr/bin/env node
// Objective: Rotate the OpenCode CLI model daily so one exhausted free tier does not block the workspace.
// Requirements: Change OPENCODE_AI_MODEL only when the UTC day changes; alternate providers; never rotate a key into the database or git.
// Decisions: Rotation state lives in /tmp/opencode because it is local scheduling state, not workspace data; .env is the only sink so the server sees the model after restart.
// Relevant Files: scripts/rotate-model.mjs, scripts/model-study.mjs, workspace, .env
// Important Context: User file. .env is gitignored; only free-tier model ids are listed here.
// Work State: Completed: Added with the ai model rotate command; Active: None; Blocked: None; Next Move: Maintain as needed.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const providers = {
  'console-openrouter': [
    'console-openrouter/liquid/lfm-3-1.7b:free',
    'console-openrouter/nvidia/nemotron-3.5-lightning:free',
    'console-openrouter/cohere/north-mini-code:free',
    'console-openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    'console-openrouter/google/gemma-4-26b-a4b-it:free',
    'console-openrouter/liquid/lfm-2.5-2.6b:free',
    'console-openrouter/nvidia/nemotron-3.5-super-vl:free',
    'console-openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'console-openrouter/thinkingmachines/inkling-2-small:free',
    'console-openrouter/recursive/flint-v1.0:free'
  ],
  'console-google': [
    'console-google/gemini-4-argon',
    'console-google/gemini-3.8-flash',
    'console-google/gemini-3.7-flash',
    'console-google/gemini-flash-latest',
    'console-google/gemini-3.5-flash-lite',
    'console-google/gemini-robotics-er-2-preview'
  ]
}

const stateFile = '/tmp/opencode/rotation-state.json'
let state = { day: 0, openrouterIndex: 0, googleIndex: 0 }
try { 
  const content = readFileSync(stateFile, 'utf8')
  state = JSON.parse(content)
} catch {}

const today = Math.floor(Date.now() / 86400000)
if (state.day !== today) {
  state.day = today
  state.openrouterIndex = (state.openrouterIndex + 1) % providers['console-openrouter'].length
  state.googleIndex = (state.googleIndex + 1) % providers['console-google'].length
  writeFileSync(stateFile, JSON.stringify(state))
}

// Alternate between providers daily
const useOpenRouter = today % 2 === 0
const model = useOpenRouter 
  ? providers['console-openrouter'][state.openrouterIndex]
  : providers['console-google'][state.googleIndex]

const envPath = resolve('/home/sunilkr/Code/.env')
let env = readFileSync(envPath, 'utf8')
if (env.includes('OPENCODE_AI_MODEL=')) {
  env = env.replace(/^OPENCODE_AI_MODEL=.*/m, `OPENCODE_AI_MODEL=${model}`)
} else {
  env += `\nOPENCODE_AI_MODEL=${model}`
}
writeFileSync(envPath, env)

console.log(`🔄 Rotated to ${useOpenRouter ? 'OpenRouter' : 'Google'} model: ${model}`)
console.log(`   State: day=${today}, openrouterIndex=${state.openrouterIndex}, googleIndex=${state.googleIndex}`)