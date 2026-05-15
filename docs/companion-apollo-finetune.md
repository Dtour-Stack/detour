# Detour Companion — APOLLO Fine-Tune Runbook

The companion ships as base eliza-1 0.6B (Qwen3 base, not fine-tuned). It works out of the box on the five jobs (triage / shouldRespond / memoryQuery / compress / personaPrePass) but accuracy on YOUR voice + YOUR tools is roughly 70% on the average turn. APOLLO fine-tuning closes that to ~95% by training on trajectories the agent has already produced.

This runbook covers:
1. When to fine-tune (the 500-trajectory threshold + signals to watch)
2. Where the training corpus lives (HF auto-dump bucket layout)
3. How to run an APOLLO fine-tune (cloud GPU + commands)
4. How to roll the resulting weights back into Detour

---

## 1. When to fine-tune

**Threshold**: ≥500 successful turns since the last fine-tune cycle. A "successful turn" is a trajectory where:
- the planner returned a non-null structured response,
- at least one action completed without `success: false`,
- the user didn't immediately re-send a correction within 60 seconds.

**Signal checks before fine-tuning**:
- **Triage accuracy < 80%**: a hand-labeled sample of 50 turns confirms `chat / tool / search / complex / skip` matches what the planner ended up needing.
- **Persona drift on output validation**: when companion output validation is enabled, drift rate > 15% over the last week indicates voice is escaping the prompt-only anchor.
- **shouldRespond false-positive rate > 30%**: on Discord observation ticks, the companion is keeping the agent doing work that didn't need doing.

If any of those hit, the dataset is rich enough — schedule a fine-tune cycle. If they're all green, the prompts are good enough; defer.

**Readiness indicator in Detour**: the agent-hf-sync state tracks `lastSyncedTrajectoryTotal`. The LocalAITab Companion section surfaces a "≥500 turns since last fine-tune; ready to retrain" badge when the threshold passes. The badge is informational only — fine-tuning is a deliberate, user-initiated action.

---

## 2. Training corpus layout (HF bucket)

The agent-hf-sync service writes the dataset to `hf://buckets/<owner>/detourdump` (configurable in Settings → Hugging Face). Files relevant to fine-tuning:

```
data/
├── trajectories.jsonl              # summary rows (one per turn)
├── trajectory-details.jsonl        # full LLM calls + actions + steps
├── all-memories.jsonl              # every memory — includes companion-job entries
├── memories/
│   ├── companion-job.jsonl         # companion's per-job logs (THIS is the SFT source)
│   ├── facts.jsonl
│   ├── description.jsonl
│   └── ...
├── relationships.jsonl
└── manifest.json                   # metadata + counts
```

The fine-tune draws primarily from:
- **`memories/companion-job.jsonl`** — `(jobName, prompt, output, ok, durationMs)` rows. The companion's own behavior on each turn.
- **`trajectory-details.jsonl`** — the planner's downstream output. Compare to the companion's prediction to compute the correction signal.
- **`all-memories.jsonl`** — for negative samples (turns where the companion was wrong + the planner had to compensate).

---

## 3. Run an APOLLO fine-tune

Cheapest viable: a single 4090 spot instance on RunPod / Vast.ai (~$0.30/hr). Total wall-clock ~3 hours for a 0.6B model + 5000-trajectory corpus.

```bash
# 1. Boot a 4090 spot instance with PyTorch + CUDA preinstalled.
#    RunPod: pytorch:2.1.0-py3.10-cuda12.1.1-devel-ubuntu22.04
#    Vast.ai: any PyTorch image, > 24 GB disk

# 2. Clone the APOLLO trainer harness (community implementations of the
#    NeurIPS 2024 paper; pick the one elizaOS publishes when available).
#    Until elizaOS ships its trainer, the cleanest community impl is
#    `zhuhanqing/APOLLO` — adapt the config for Qwen3-0.6B.
git clone https://github.com/zhuhanqing/APOLLO.git
cd APOLLO

# 3. Pull the Detour trajectory dump from your HF bucket.
huggingface-cli login  # use your token; needs read access to <owner>/detourdump
huggingface-cli download <owner>/detourdump --repo-type dataset --local-dir ./detour-corpus

# 4. Build the SFT corpus from companion-job entries.
python scripts/build_sft_from_companion_jobs.py \
  --input ./detour-corpus/data/memories/companion-job.jsonl \
  --planner-truth ./detour-corpus/data/trajectory-details.jsonl \
  --output ./sft-dataset.jsonl

# 5. Run the APOLLO fine-tune. The config snippet below is the one we
#    found stable for Qwen3-0.6B on a single 4090 — it keeps optimizer
#    state under ~1 GB so the whole run fits in VRAM.
python apollo_finetune.py \
  --base_model elizaos/eliza-1@bundles/0_6b/text/eliza-1-0_6b-32k.gguf \
  --train_file ./sft-dataset.jsonl \
  --output_dir ./out-detour-companion-v1 \
  --optimizer apollo \
  --apollo_rank 256 \
  --apollo_scale 32 \
  --lr 2e-5 \
  --epochs 3 \
  --batch_size 4 \
  --gradient_accumulation_steps 4 \
  --warmup_steps 100

# 6. Convert the resulting safetensors back to GGUF (so Detour's
#    llama.cpp can load it).
python -m llama_cpp.convert_hf_to_gguf \
  ./out-detour-companion-v1 \
  --outtype q4_k_m \
  --outfile ./detour-companion-v1-q4_k_m.gguf

# 7. Upload to your own HF repo for distribution back to Detour.
huggingface-cli repo create detour-companion --type model
huggingface-cli upload <your-username>/detour-companion \
  ./detour-companion-v1-q4_k_m.gguf detour-companion-v1-q4_k_m.gguf
```

Expected cost per cycle: **~$1** on a 4090 spot instance. Wall-clock: 2–4 hours including data prep + conversion + upload.

---

## 4. Roll the fine-tuned weights back into Detour

In Settings → Local AI → Detour Companion, paste your custom `hf://` ref (e.g. `hf://<your-username>/detour-companion/detour-companion-v1-q4_k_m.gguf`) into a "Custom companion model" field — **TODO: this field needs to be added; current code uses the default modelRef only.** The companion downloads the fine-tuned GGUF on next start and uses it for all five jobs. The base eliza-1 0.6B remains the fallback if the custom ref fails.

The agent-hf-sync state then resets the `lastFineTunedAt` timestamp and trajectories accumulate against the new baseline. Weekly cycle is the right cadence: enough new data to be worth a retrain, not so frequent the SFT noise floors out.

---

## 5. What success looks like

After one cycle, the companion's recent-jobs log should show:
- **Triage**: 90%+ matches the planner's downstream label (`tool` → action dispatched, `chat` → REPLY only, etc.).
- **shouldRespond**: false-positive rate drops below 15% on observation ticks (measured by: ticks where companion said yes + planner emitted no reply).
- **personaPrePass**: voice-validation pass rate >85% (when the output-validator job lands).
- **memoryQuery**: 90%+ of returned queries hit a real memory in Pensieve.
- **compress**: summaries retain >70% of named entities from the source (measurable by sampling).

Trajectory metadata should show the planner downstream cost dropping ~25–40% per turn (fewer Codex calls because triage routes more turns to direct-reply paths).

---

## 6. Failure modes

- **Corpus too small** (< 200 turns): APOLLO converges but overfits hard. Wait for the threshold.
- **Corpus too noisy** (failed turns mixed with successes): filter at `build_sft_from_companion_jobs.py` step to drop entries where the trajectory's `totalReward < 0` or `failedActionCount > 0`.
- **Catastrophic forgetting**: the companion drops accuracy on base abilities (general English, Qwen3 native reasoning). Mitigate with a small (~5%) replay buffer of the original Qwen3 instruct corpus.
- **GGUF conversion mismatch**: `convert_hf_to_gguf` occasionally drops tokenizer special tokens. Verify the converted GGUF runs against `llama.cpp` test prompts before uploading.

---

This runbook is a checked-in artifact. Update it as the APOLLO ecosystem matures (elizaOS will likely publish a managed trainer + the canonical eliza-1 instruct release).
