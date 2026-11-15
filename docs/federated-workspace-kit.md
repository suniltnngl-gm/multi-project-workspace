# Federated workspace repository kit

## Model and authority boundary

The workspace follows Model 3 (Hybrid Core + Plugin Split): `multi-project-workspace` is the control plane and registered repositories remain independent execution spokes. Repositories join through `workspace.manifest.json` and a root `workspace-repo.json`; no Git history merge is required.

The manifest and descriptors are declarative topology records. Their capability metadata and provenance are descriptive-only and never grant task, model, provider, quota, or execution authority. Task #97 authorization permit v1.0 remains authoritative. P3-B through P3-F are not implemented by this kit.

## Repository verification targets

Core exposes npm aliases:

- `npm run verify:unit`
- `npm run verify:contract`
- `npm run verify:readiness`
- `npm run verify:subtree -- preflight|postflight`

A spoke without a package manifest (currently curl-ai-bridge) uses the equivalent portable Node entrypoints:

- `node scripts/workspace-verify.mjs unit`
- `node scripts/workspace-verify.mjs contract`
- `node scripts/workspace-verify.mjs readiness`

Readiness output is versioned and separates `executionReady` from `toolingReady`. Diagnostics disclose deferred governance and security work; readiness does not certify permit enforcement.

## Merge/split safety

`scripts/workspace-subtree.mjs` provides read-only preflight and postflight checks. It validates manifest registration, descriptor schema, path containment, governance declaration, lockfile policy, host-path portability, and descriptive provenance. It does not invoke `git subtree`, rewrite history, stage files, or mutate repositories. A postflight `--expectedCommit` detects an unexpected HEAD change.

Any actual `git subtree add`, `git subtree split`, merge, branch, commit, push, release, or deployment remains a separate operator-authorized operation.

## Reusable GitHub Actions workflow

`.github/workflows/reusable-repo-verify.yml` is a Tier-2 `workflow_call` workflow. A caller should pin it by immutable commit SHA:

```yaml
jobs:
  governance:
    uses: <owner>/multi-project-workspace/.github/workflows/reusable-repo-verify.yml@<40-character-commit-sha>
    with:
      descriptor_path: workspace-repo.json
      governance_required: true
```

The `curl-ai-bridge` spoke must invoke this workflow with `governance_required: false` while its `AGENTS.md` remains deferred under Priority 2. This suppresses only the hard gate; it does not create an `AGENTS.md`, waive other checks, or claim governance compliance. A spoke with governance present should pass `governance_required: true`. The workflow checks out its own Core kit using `github.workflow_sha`, so the validator/schema are from the same immutable revision as the reusable workflow.

This workflow is staged in the Core working tree and is not callable from GitHub until the Core revision containing it is committed and published. No caller workflow is installed in Bridge as part of this task.

## Current registry

The manifest currently registers only:

- `multi-project-workspace` — `core`, default branch `master`.
- `curl-ai-bridge` — `adapter`, default branch `main`.

Bridge's observed working branch is recorded separately. Its missing `AGENTS.md` is explicitly marked `deferred-priority-2`; this kit does not create or imply that file. No third repository is onboarded.
