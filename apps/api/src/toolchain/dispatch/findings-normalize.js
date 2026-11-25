/**
 * #207 — normalize a read-only sibling's captured stdout into a findings artifact.
 *
 * cline (`--json --plan`), vibe (`--output json`) and codex (`exec`) often run in a
 * read-only mode where they cannot write the findings file themselves. Their stdout is
 * still the deliverable, so it is persisted at `findingsPath` via protectedWriteFile.
 *
 * Fail-closed rule: blank stdout is never disguised as a finding. An empty/whitespace-only
 * capture returns `{ ok: false, reason: 'empty_stdout' }` and the relay records
 * `ok_no_findings` instead of claiming success.
 */

export const NORMALIZED_FINDINGS_SCHEMA = 'relay-findings-normalized/v1'

/** Pull the human-usable payload out of a CLI JSON envelope without guessing too hard. */
function extractEnvelopePayload(doc) {
  const bag = {
    findings: doc.findings ?? doc.prioritized_work ?? doc.items ?? doc.cases ?? [],
    multiOptionCases: doc.multi_option_cases ?? doc.options ?? [],
    summary: doc.summary ?? doc.headline ?? doc.text ?? null,
    notes: Array.isArray(doc.notes) ? doc.notes : []
  }
  // Preserve anything we did not map explicitly so evidence is never dropped.
  bag.envelope = doc
  return bag
}

/**
 * Normalize captured stdout.
 * Returns { ok: true, doc } or { ok: false, reason: 'empty_stdout' | 'unparseable_json_envelope' }.
 */
export function normalizeStdoutFindings({
  stdout = '',
  sibling = 'unknown',
  job = null,
  mode = null,
  round = null,
  window = null,
  generatedAt = null
} = {}) {
  const raw = String(stdout ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'empty_stdout' }

  let doc = null
  try {
    doc = JSON.parse(trimmed)
  } catch {
    doc = null
  }

  if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
    const payload = extractEnvelopePayload(doc)
    if (!payload.summary && (!Array.isArray(payload.findings) || payload.findings.length === 0)) {
      // A structured envelope with nothing usable in it is not evidence.
      return { ok: false, reason: 'empty_envelope' }
    }
    return {
      ok: true,
      doc: {
        schema: NORMALIZED_FINDINGS_SCHEMA,
        format: 'json-envelope',
        sibling,
        job,
        mode,
        round,
        window,
        source: 'stdout',
        summary: payload.summary || null,
        findings: payload.findings,
        multiOptionCases: payload.multiOptionCases,
        notes: payload.notes,
        envelope: payload.envelope,
        generatedAt: generatedAt || new Date().toISOString()
      }
    }
  }

  return {
    ok: true,
    doc: {
      schema: NORMALIZED_FINDINGS_SCHEMA,
      format: typeof doc === 'string' || Array.isArray(doc) ? 'json-scalar' : 'text',
      sibling,
      job,
      mode,
      round,
      window,
      source: 'stdout',
      summary: trimmed.slice(0, 400),
      body: raw,
      generatedAt: generatedAt || new Date().toISOString()
    }
  }
}
