import { z } from "zod";

export const PHASES = ["T1", "T2", "T3"] as const;
export type ChunkPhase = (typeof PHASES)[number];
export const LINES_PER_CHUNK = PHASES.length;

const SamplingPartialSchema = z
  .object({
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    min_p: z.number().optional(),
    presence_penalty: z.number().optional(),
    max_tokens: z.number().optional(),
  })
  .strict();

export const BatchSettingsSchema = z.object({
  profile: z.enum(["BIG", "SMALL"]),
  contextLength: z.number().int().positive(),
  batchSize: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  fewShotCount: z.number().int().nonnegative(),
  sampling: SamplingPartialSchema,
  samplingOverrides: z
    .object({
      T1: SamplingPartialSchema.optional(),
      T2: SamplingPartialSchema.optional(),
      T3: SamplingPartialSchema.optional(),
    })
    .partial()
    .optional(),
});

export type BatchSettings = z.infer<typeof BatchSettingsSchema>;
