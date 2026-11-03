# AIKA MVP — verify that a "private" AI app is really contained

**One-line pitch:** AIKA runs an AI app on an internal-only network, forces any outbound traffic
through an allowlist proxy, then tests and proves what got out (and what didn't).

## What it demonstrates
1. A **clean** app passes: it answers via the local model and makes no unapproved connections.
2. A **leaky** app (hidden "analytics" call that tries to send prompts outside) is **caught and blocked**.
3. An **independent collector** outside the app records any request that reaches it. It must stay at zero.
4. A report (`report.html` + `report.json`) with evidence files and an explicit limitations section.

## Requirements
Docker (with Compose v2) and Node.js 18+. No npm packages needed. No internet needed after the first image build
(the base image `node:20-alpine` is pulled once).

## Run it
```bash
# Clean app
node cli/aika.js verify

# Leaky app (the demo moment)
node cli/aika.js verify --leak
```
Reports land in `artifacts/<timestamp>/`. Add `--keep` to leave the containers running.

Docker-free sanity test of the proxy/collector logic: `node tests/smoke.js`


## Offline install (new)
For machines with no internet. Three steps, two machines.

**On a connected build machine** (needs Docker + Node):
```bash
node cli/aika.js bundle
```
This builds the image, exports it to `images.tar`, copies the files, and writes `manifest.json` + `SHA256SUMS` into
`dist/aika-bundle-0.1.0/`. It prints a **manifest fingerprint**. Share it with the other side on a separate channel.

**On the isolated machine** (Docker + Node installed separately; copy the folder over on approved media):
```bash
node cli/aika.js verify-bundle      # checks every file against the manifest, no network
node cli/aika.js install            # re-checks, then loads the image into Docker
node cli/aika.js verify --offline   # runs the checks with no build and no pulls
node cli/aika.js verify --offline --leak
```
`--offline` also probes whether the machine can reach the public internet. If it can, the **offline-proof** check fails,
so you cannot accidentally claim an offline run from a connected machine.

Offline limitations (stated honestly):
- Checksums catch corruption and accidental changes. They do not prove who made the bundle. Signing is a later step.
- The offline-proof probe tests routes to two public addresses only.
- Docker and Node must already be installed on the isolated machine.
- The model is still a stub. Real model weights in the bundle are the next step.
- Not yet tested on a truly disconnected machine. That is your first job.

Docker-free tests: `node tests/smoke.js` and `node tests/bundle-test.js`


## Dashboard (read-only)
```bash
node cli/aika.js dashboard --open
```
Writes `dashboard.html`: an architecture diagram, the latest leaky and clean runs side by side, run history,
and the offline bundle's manifest fingerprint. It is built from the reports AIKA already wrote.
It has no scripts and makes no network requests, so it also works on the disconnected machine.
It only displays results. It does not run tests or change policy.
Run `verify` (and `verify --leak`) first so there is something to show.


## Real local model (opt-in, new)
By default the demo uses a **stub** model that returns canned answers. Add `--model` to use a **real** small open-weight
model (default `qwen2.5:0.5b`, served by Ollama) that is baked into a Docker image and carried inside the offline bundle.
```bash
# On the connected build machine (downloads the model once; several minutes, large file):
node cli/aika.js bundle --model
# On the isolated machine, from the bundle folder:
node cli/aika.js verify-bundle
node cli/aika.js install
node cli/aika.js verify --offline --model --leak
```
- `--model` adds a `real-model` check that fails if the answer came from the stub, and the report names the model used.
- Choose another model with `AIKA_MODEL` (for example `set AIKA_MODEL=llama3.2:1b` on Windows). Check its license first.
- The model runs on the internal network only, so it has no route out. Its own network behaviour is blocked but not separately tested yet.
- The first answer on a laptop CPU can take a minute. The verifier waits for it.
- Not yet tested against a real Ollama in this repo's CI: run it once on your machine and send me any error.
- Docker-free test of our side of the connection (mock server, not a real model): `node tests/ollama-mode-test.js`
- If `bundle --model` fails with a builder error (for example `EOF`), build the model image by hand and skip the build step:
  ```
  docker pull ollama/ollama:latest
  docker run -d --name aika-model-build -e OLLAMA_MODELS=/models -e OLLAMA_HOST=0.0.0.0:11434 ollama/ollama:latest
  docker exec aika-model-build ollama pull qwen2.5:0.5b
  docker commit aika-model-build aika/model:0.1
  docker rm -f aika-model-build
  node cli/aika.js bundle --model --skip-build
  ```

## How it works
- `docker-compose.yml`: `app` and `llm` sit on an `internal: true` network (no route out). Only `proxy`
  is on both networks; it forwards only hosts in `policy.json` → `allowed_hosts`.
- `approved-api` and `evil-api` are stand-ins for the outside world, so the demo is deterministic and offline.
- `cli/aika.js verify` runs probes **inside the app container**: functional test, direct-connection tests,
  allowed/denied proxy tests, and a check of the collector's hit count. Then it gathers logs and writes the report.

## Honest limitations (also printed in every report)
- External services are simulated on a local Docker network, not the real internet.
- Only the listed paths are tested. DNS exfiltration, covert channels, and host-level firewall rules are not.
- Container-level isolation only; host/Docker daemon are trusted.
- Evidence for review, not a certification.

## Next steps (after the application)
1. Packet capture sidecar (`tcpdump`) attached to the app's network namespace; add the `.pcap` to the evidence.
2. Real-ollama mode: add an `ollama` service on `internal`, set `LLM_MODE=ollama` and `LLM_URL=http://ollama:11434`.
3. Host-level enforcement (nftables) as a second layer, plus tests for DNS.
4. Run on a second clean machine and record both runs.

## Suggested 2–3 minute demo script
1. "Most 'private AI' apps still phone home. Here's a clean app." → run `verify` → green report.
2. "Now an app with a hidden analytics call." → run `verify --leak`.
3. Show the verdict: CONTAINED, attempts blocked, collector saw zero requests.
4. Open `report.html`, point to evidence files and the limitations section.
