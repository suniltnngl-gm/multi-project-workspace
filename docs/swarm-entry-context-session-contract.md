# Swarm Entry, Context, Prompt and Session Contract

## Entry
Bash 3.2+ launches Node.js >=22 after resolving the physical root and checking package, manifest and swarm implementation markers. The existing ai swarm route must always use this entrypoint. Live run/step/merge/deploy are refused; plan and dry-run are local-only.

## Context
Versioned Draft 2020-12 JSON binds project, task, authority, decisions, blockers, evidence, next action and provenance. SHA-256 covers canonical JSON excluding its digest. Secret-shaped keys and common bearer/API token values are redacted. Imports/exports copy validated metadata only; they never mutate workspace.sqlite or grant authority. Traversal, absolute paths, symlink components and overwrite by default are rejected.

## Prompt
Immutable prefix order: role/identity; mandate/authority; output schema; tool/budget limits; evidence; stop conditions. Dynamic task/context/turn payload is separate. Fingerprint includes prefix version/content and provider/model but excludes dynamic turns. Provider cache hints remain none_unverified.

## Sessions
Session metadata binds provider, CLI, model, project, task, run and lineage. Native capabilities are verified/unsupported/unknown and default unknown. Metadata import/export is not native session portability. Resume refuses unknown capabilities and no native adapter is claimed. No credentials are stored.

## Limits
No network egress, provider inference, quota use, package install, deployment, CI trigger, commit or push. Node owns structured data; Bash is launcher only.
