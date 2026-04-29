import { z } from "zod";

export const IntentSchema = z.object({
  rawPrompt: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  hints: z.object({
    payerLocation: z.string().optional(),
    contractType: z.string().optional()
  })
});

