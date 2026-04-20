import { z } from "zod";

const DOMAINS = ["ui", "web", "mobile", "ux", "perf", "arch", "copy", "seo", "research"] as const;

export const ConceptSchema = z.object({
  principle: z.string().min(3).max(300),
  explanation: z.string().min(10).max(2000),
  domain: z.enum(DOMAINS),
  tags: z.array(z.string().min(1).max(50)).min(1).max(10),
});

export const ConceptArraySchema = z.array(ConceptSchema).min(1);

export type Concept = z.infer<typeof ConceptSchema>;
export type Domain = (typeof DOMAINS)[number];
