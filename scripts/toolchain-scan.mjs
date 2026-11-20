#!/usr/bin/env node
import { scanToolchain } from '../apps/api/src/toolchain/index.js'

const args = new Set(process.argv.slice(2))
const inventory = scanToolchain()

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
  process.exit(0)
}

const lines = [
  `Toolchain Scan (${inventory.schemaVersion}, read-only)`,
  `OS: ${inventory.os.family} (${inventory.os.platform}/${inventory.os.arch})${inventory.os.distro ? ` — ${inventory.os.distro}` : ''}${inventory.os.isWsl ? ' [WSL]' : ''}`,
  `Current Shell: ${inventory.shells.currentShell}`,
  `Node: ${inventory.node.active.available ? `${inventory.node.active.path} (${inventory.node.active.version || 'unknown'}, ${inventory.node.active.installMethod})` : 'missing'}`,
  `Python: ${inventory.python.active.available ? `${inventory.python.active.path} (${inventory.python.active.version || 'unknown'}, ${inventory.python.active.pythonKind})` : 'missing'}`,
  `uv: ${inventory.python.uv.available ? `${inventory.python.uv.path} (${inventory.python.uv.version || 'unknown'})` : 'missing'}`,
  `Project .venv: ${inventory.python.projectVenv.detected ? inventory.python.projectVenv.root : 'not detected'}`,
  `Utilities available: ${inventory.utilities.filter((u) => u.available).map((u) => u.name).join(', ') || 'none'}`,
  `AI CLIs available: ${inventory.aiClis.filter((c) => c.available).map((c) => c.name).join(', ') || 'none'}`
]
process.stdout.write(`${lines.join('\n')}\n`)
