# Qwen3 + LM Studio Setup

Two-profile model setup for Bibliary local vibecoding workshop.

## Profiles

| Profile | Model key | File | Quant | VRAM | Use |
|---|---|---|---|---|---|
| **BIG** | `qwen/qwen3.6-35b-a3b` | `Qwen3.6-35B-A3B-Q4_K_M.gguf` | Q4_K_M | 24+ GB | Dataset generator + production |
| **SMALL** | `qwen/qwen3-4b-2507` | `Qwen3-4B-Instruct-2507-Q8_0.gguf` | Q8_0 | 8/16 GB | Lightweight target |

Both share the same official Qwen Team sampling preset:
`temperature=0.7, top_p=0.8, top_k=20, min_p=0`. Dataset generator additionally uses `presence_penalty=1.0` to reduce repeats in long T1 passages.

## Installation

1. Install LM Studio 0.4.0+ from [lmstudio.ai](https://lmstudio.ai).
2. Open the in-app model search, type `qwen3.6-35b-a3b` and download the `Q4_K_M` GGUF (22.07 GB).
3. Search `qwen3-4b-2507` and download the `Q8_0` GGUF (4.28 GB).
4. Open the local server panel (left sidebar in LM Studio), make sure it listens on `http://localhost:1234`.

## Recommended LM Studio load settings

In the **Load** tab of each model:

```
GPU offload: max
Flash attention: on
KV cache type: Q8_0 (only if you go above 128K context)
Eval batch size: 512
TTL: 1800 (BIG) / 600 (SMALL)
```

## Sampling preset (both models)

```
temperature 0.7
top_p       0.8
top_k       20
min_p       0
presence_penalty 1.0
max_tokens  4096   # 16384 for chat / thinking mode
```

## YaRN: extending context up to 1M

Native context for `qwen3.6-35b-a3b` is **262 144 tokens**. For 1M you need YaRN
`rope_scaling` patched into the model config.

In LM Studio open the model card → **Custom config** → paste:

```json
{
  "rope_scaling": {
    "rope_type": "yarn",
    "factor": 4.0,
    "original_max_position_embeddings": 262144
  }
}
```

Formula: `factor = target / native`. For 512K use `2.0`, for 1M use `4.0`. Static
YaRN slightly degrades performance on short prompts — only enable when you
actually need long-context generation.

For `qwen3-4b-2507` native context is `32768`. YaRN to `131072`:

```json
{
  "rope_scaling": {
    "rope_type": "yarn",
    "factor": 4.0,
    "original_max_position_embeddings": 32768
  }
}
```

## Verifying setup from Bibliary

```bash
docker compose up -d
npm run electron:dev
```

In the app:
1. Open the **Models** route — server status should be online, both profiles
   visible.
2. Click `Load` on the BIG profile — within ~30s you should see it appear under
   *Loaded models (in memory)*.
3. Switch to **Dataset** route, press *Start batch*. Watch live T1/T2/T3 phases
   and progress bar.

If the server shows offline, confirm LM Studio's local server is running and
that `LM_STUDIO_URL` in `.env` matches its port (default `http://localhost:1234`).
