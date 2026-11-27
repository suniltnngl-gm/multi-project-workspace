# COLAB-MCP-001 Phase C — CLI Contract Inspection (Session Lifecycle)

**Date:** 2026-10-30
**Tool:** `colab` CLI v0.7.5
**Auth:** OAuth2 (user flow, `<colab-cli-token-path>`)
**Scope:** Read-only inspection of session lifecycle commands

---

## 1. Command Interface Summary

| Command | Purpose | Key Options |
|---------|---------|-------------|
| `colab new` | Create session | `--session`, `--gpu`, `--tpu`, `--high-mem` |
| `colab sessions` | List active sessions | — |
| `colab status` | Session status | `--session <name>` |
| `colab stop` | Stop session | `--session <name>` |

---

## 2. Command Contracts

### 2.1 `colab new` — Create Session

**Syntax:**
```bash
colab new [--session NAME] [--gpu GPU] [--tpu TPU] [--high-mem]
```

**Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--session`, `-s` | string | Session name (auto-generated if omitted) |
| `--gpu` | string | GPU variant: T4, L4, G4, H100, A100 |
| `--tpu` | string | TPU variant: v5e1, v6e1 |
| `--high-mem` | flag | High-RAM shape (requires Pro/Pro+) |

**Output (success):**
```
[colab] Creating session 'name'...
[colab] Session READY.
```

**Exit codes:**
- `0` — Success
- `1` — Error (quota exceeded, auth failure, etc.)

**Behavior:**
- Auto-generates session name if `--session` omitted (format: `<random>`)
- Session ID format: `m-s-<random>` (e.g., `m-s-<example>`)
- Blocks until session reaches `READY` state
- GPU/TPU availability depends on Colab subscription tier

---

### 2.2 `colab sessions` — List Active Sessions

**Syntax:**
```bash
colab sessions
```

**Output format:**
```
[name] m-<id> | Hardware: CPU | Shape: Standard | Variant: DEFAULT
```

**Example:**
```
[inspect-test] m-s-<example> | Hardware: CPU | Shape: Standard | Variant: DEFAULT
[concurrent-test] m-s-<example> | Hardware: CPU | Shape: Standard | Variant: DEFAULT
```

**Empty state:**
```
[colab] No active sessions found on server.
```

**Exit codes:**
- `0` — Success (even if no sessions)
- `1` — Error (auth, network)

---

### 2.3 `colab status` — Session Status

**Syntax:**
```bash
colab status --session <name>
```

**Required option:** `--session` / `-s` (session name)

**Output (success):**
```
[name] m-<id> | Hardware: CPU | Shape: Standard | Variant: DEFAULT | Status: IDLE
```

**Status values observed:** `IDLE`, `RUNNING`

**Error case (session not found):**
```
[colab] Session 'nonexistent' not found.
Exit code: 1
```

---

### 2.4 `colab stop` — Stop Session

**Syntax:**
```bash
colab stop --session <name>
```

**Required option:** `--session` / `-s` (session name)

**Output (success):**
```
[colab] Stopping session 'name'...
[colab] Session terminated.
```

**Exit codes:**
- `0` — Success
- `1` — Session not found / error

**Error cases:**
```
[colab] Session 'nonexistent' not found.
Exit code: 1
```

**Behavior on stop:**
- Session is **terminated and removed** from active sessions list
- Session no longer appears in `colab sessions`
- Session state is **not preserved** — stop = terminate + delete
- Kernel state is discarded; files written to `/content` persist on runtime filesystem

---

## 3. Session Output Format Specifications

### Session Line Format (from `colab sessions` / `colab status`)
```
[name] m-<id> | Hardware: <hw> | Shape: <shape> | Variant: <variant> | Status: <status>
```

**Regex for parsing:**
```
^\[(.+?)\]\s+m-s-[a-z0-9]+\s+\|\s+Hardware:\s+(\w+)\s+\|\s+Shape:\s+(\w+)\s+\|\s+Variant:\s+(\w+)(?:\s+\|\s+Status:\s+(\w+))?$
```

**Capture groups:**
1. Session name (display name)
2. Session ID (m-s-...)
3. Hardware type
4. Shape
5. Variant
6. Status (optional, only in `status` command)

### Session ID Format
```
m-s-<alphanumeric>   # e.g., m-s-<example>
```

### Status Values
| Value | Meaning |
|-------|---------|
| `IDLE` | Session ready, no execution |
| `RUNNING` | Code executing |
| `CREATING` | Provisioning (transient) |

---

## 4. Error Handling & Exit Codes

### Exit Code Conventions
| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (session not found, auth failure, network, etc.) |

### Common Error Messages

| Scenario | Error Output | Exit Code |
|----------|--------------|-----------|
| Session not found (status) | `[colab] Session 'name' not found.` | 1 |
| Session not found (stop) | `[colab] Session 'name' not found.` | 1 |
| Session not found (exec) | `[colab] Session 'name' not found.` | 1 |
| Auth expired | OAuth flow triggered | 1 |
| Quota exceeded | Error message | 1 |

### Error Output Format
```
[colab] Error: <message>
```
- Always on stderr
- Exit code 1

---

## 5. Session Lifecycle Behavior

### Creation (`colab new`)
```
[colab] Creating session 'name'...
[colab] Session READY.
```
- Blocks until `READY` state
- Auto-generates name if `--session` omitted
- GPU/TPU/high-mem options respected based on tier

### Listing (`colab sessions`)
- Returns all active sessions (including those created via web UI)
- Empty state: `[colab] No active sessions found on server.`

### Status Check (`colab status`)
- Returns hardware, shape, variant, status
- Status: `IDLE` or `RUNNING`

### Stop Behavior (`colab stop`)
- **Terminates AND deletes** session
- Session removed from active list
- **No preservation** of kernel state
- Files in `/content` persist on runtime filesystem
- Session cannot be resumed

---

## 6. Execution Behavior (`colab exec`)

### Input Methods
| Method | Syntax |
|--------|--------|
| Stdin pipe | `echo "code" \| colab exec --session <name>` |
| File | `colab exec --session <name> --file script.py` |

### Timeout Behavior
- Default: 30 seconds (`--timeout 30`)
- On timeout: `TimeoutError` with traceback, exit code 1
- Output before timeout captured in stdout

### Concurrency
- Multiple `colab exec` calls to **same session** are **sequential** (queued)
- Second command waits for first to complete
- No parallel execution within same session

### Exit Codes
| Scenario | Exit Code |
|----------|-----------|
| Success | 0 |
| Session not found | 1 |
| Timeout | 1 (with traceback) |
| Kernel error | 1 |
| Invalid args | 1 |

---

## 7. Session State Persistence

| Operation | Kernel State | Files in `/content` | Session Record |
|-----------|--------------|---------------------|----------------|
| `colab stop` | **Discarded** | **Persist** | **Deleted** |
| `colab stop` + `colab new` (same name) | Fresh kernel | Persist | New session ID |

**Key finding:** `colab stop` = terminate + delete. No pause/resume.

---

## 8. Session ID Format

```
m-s-<alphanumeric>
```
Example: `m-s-<example>`

Regex: `^m-s-[a-z0-9]+$`

---

## 9. Concurrency Behavior

| Scenario | Behavior |
|----------|----------|
| Multiple `colab exec` to same session | **Sequential** (queued, sequential execution) |
| Multiple `colab exec` to different sessions | Parallel (independent) |
| `colab exec` during `colab stop` | Second command fails (session not found) |

---

## 10. Error Handling Summary

| Scenario | Exit Code | Stdout | Stderr |
|----------|-----------|--------|--------|
| Success | 0 | Result | (empty) |
| Session not found | 1 | (empty) | `[colab] Session 'x' not found.` |
| Timeout | 1 | Partial output | Traceback + `TimeoutError` |
| Kernel error | 1 | Partial | Traceback |
| Invalid args | 1 | (empty) | Usage / error |
| Auth expired | 1 | (empty) | OAuth flow / error |

---

## 11. Summary for Adapter Implementation

### Required Tool Contracts

| MCP Tool | CLI Command | Input | Output |
|----------|-------------|-------|--------|
| `colab_session_create` | `colab new [--session NAME] [--gpu GPU] [--tpu TPU] [--high-mem]` | `name?`, `gpu?`, `tpu?`, `high_mem?` | `{session_name, session_id, hardware, shape, variant}` |
| `colab_session_list` | `colab sessions` | — | `[{name, session_id, hardware, shape, variant, status}]` |
| `colab_session_get` | `colab status --session <name>` | `session` | `{name, session_id, hardware, shape, variant, status}` |
| `colab_session_stop` | `colab stop --session <name>` | `session` | `{session, terminated: true}` |

### Parser Regex
```regex
^\[(.+?)\]\s+m-s-[a-z0-9]+\s+\|\s+Hardware:\s+(\w+)\s+\|\s+Shape:\s+(\w+)\s+\|\s+Variant:\s+(\w+)(?:\s+\|\s+Status:\s+(\w+))?$
```

### Error Mapping
| CLI Error | MCP Error Code |
|-----------|----------------|
| Session not found | `SESSION_NOT_FOUND` (404) |
| Name conflict | `SESSION_ALREADY_EXISTS` (409) |
| Not ready | `SESSION_NOT_READY` (409) |
| Timeout | `EXECUTION_TIMEOUT` (408) |
| Kernel error | `KERNEL_ERROR` (500) |
| Auth expired | `AUTH_EXPIRED` (401) |
| Quota exceeded | `QUOTA_EXCEEDED` (429) |

---

## 12. Test Strategy (Per Requirements)

| Test | Approach |
|------|----------|
| Unit tests | Mock `subprocess.run`, verify CLI args, parse output |
| Integration | Real CLI calls (create → list → get → stop) |
| Error cases | Mock subprocess to return error codes |
| Concurrency | Spawn parallel `colab exec` to same session |
| Timeout | Short timeout + long-running code |
| Auth expiry | Simulate expired token (mock) |

**No real sessions created/stopped during unit tests** — mock subprocess.

---

*End of CLI Contract Inspection*
*Ready for Phase C implementation authorization*