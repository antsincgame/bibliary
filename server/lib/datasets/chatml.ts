import type { ShareGptLine } from "./sharegpt.js";

/**
 * Phase 8c — ChatML rendering layer над ShareGPT conversations.
 *
 * ChatML — string-template format используемый Qwen / OpenAI fine-tuning
 * / DeepSeek / GLM. Каждая roles конверсации wrap'ается в
 * `<|im_start|>{role}\n{content}<|im_end|>` блок, join'ятся через \n.
 *
 * Output JSONL convention HuggingFace SFTTrainer:
 *   {"text": "<|im_start|>system\n...<|im_end|>\n<|im_start|>user\n..."}
 *
 * Этот формат самый прямой для passing в Unsloth / Axolotl без
 * additional formatter — модель видит готовый prompt-completion блок.
 */

/* Маркеры стандарта Qwen / OpenAI ChatML — самый распространённый
 * вариант. Llama / Mistral используют [INST]...[/INST] — отдельный
 * формат, добавится отдельным коммитом если будет реальный спрос. */
const IM_START = "<|im_start|>";
const IM_END = "<|im_end|>";

const ROLE_MAP: Record<ShareGptLine["conversations"][number]["from"], string> = {
  system: "system",
  human: "user",
  gpt: "assistant",
};

export interface ChatMlLine {
  text: string;
  metadata: ShareGptLine["metadata"];
}

export function renderChatMlLine(line: ShareGptLine): ChatMlLine {
  const blocks = line.conversations.map(
    (turn) => `${IM_START}${ROLE_MAP[turn.from]}\n${turn.value}${IM_END}`,
  );
  return {
    text: blocks.join("\n"),
    metadata: line.metadata,
  };
}
