# Writer v0.9 integration validation

2026-09-14. Adopted behavior is described in [Writer design](writer-design.md) and [Dream operations](dreaming.md).

## Implemented

- Atom Memory v0.9 declarative atomic create/revise/retire and incoming/outgoing one-hop inspection. Semantic links, including local cycles, do not create generation dependencies merely by sharing a commit.
- One Sakana Writer can inspect the existing Atom graph and navigate scoped raw archive text, reply context and keyset search. It records events with source outcomes and continuation rather than treating a transport batch as a permanent topic.
- The host records actual model inputs, checkpoints the change plan before commit and recovers the same operation after interruption. Source/index waits retain work; continuation clears the previous Writer batch ID and advances a new episode.
- Public channels in a guild have a separate shared policy projection. Private channel scopes stay separate. Live read authorization and generation checks apply before delivery and before projection commits.
- Initial history, new sources and current-Atom review share a fenced scheduler. Daily review starts at 04:00 JST without a four-batch cap. Exact legacy refresh generations become new work; a marker arriving after work formation cannot be acknowledged by that older work.
- Ling Flash free-first/paid same-model fallback and Qwen3 Embedding 8B use the persistent Evex budget. The library does not execute these providers or own the schedule.

## Completed checks

`npm run check` passed, including the full precheck and existing governance, provider, archive, message, runtime and Dream checks. Specific regressions cover:

- Public cross-channel organization, private source rejection, reply-aware source navigation and multi-episode continuation.
- Source edits during model execution; revoked public access before append and between append/pointer publication; stale index marker recovery.
- Claim ownership/fence takeover, late refresh markers, exact-generation acknowledgements, queue restart and cost admission.
- Required conditions, negation, recurrence and disagreement in deterministic Writer fixtures.
- Actual model-payload token issuance, retained tool outputs and replay without additional provider requests.

Atom Memory passed 246 tests on Node 26.1.0 and the minimum Node 22.13.0, 16 research tests, 14 runnable documentation examples and 6 documented outputs. The local npm tarball and the published registry package each passed 91 tests, strict TypeScript, three shipped examples and actual v0.8 data migration in an empty consumer/cache. Prior published v0.4/v0.5.1/v0.6/v0.7 data migration checks also passed.

## Library release

Atom Memory 0.9.0 was published as npm `latest`. The registry tarball exactly matches the validated tarball. Source/tag: `d703cdb3fa7a5a041ce1b4cf80e1cdfd9ac7678d` / `v0.9.0`. GitHub CI passed on Node 22 and 24. The documentation deployment `21946ccc-cd2d-40bf-86d7-d2ce8df293b1` was read back from `atom-memory.takos.jp`: 19 pages and the release manifest matched the release. See the library's `validation/release-v0.9.0.json` and `validation/docs-v0.9.0-readback.json`.

## Deployment and evaluation boundary

No new real Ling or Qwen provider call was made in this run. The local OpenRouter credential is absent. Deterministic fixture success does not establish real-model event resolution, full Evex-history completion, throughput or billed cost.

Production Bot deployment is pending connection recovery. Both `root@192.168.0.117` and the Proxmox host `root@192.168.0.22` rejected SSH public-key authentication. Proxmox HTTP responds but authenticated browser CDP inspection times out; no production service or database was changed. Once access is available, follow [deployment](deployment.md), preserve the raw archive and runtime databases, rebuild the nested library, restart the service and verify the Dream job/ledger before advancing the experiment.
