// ============================================================
// Zod request schemas — central, unified validation layer (C4)
//
// Strategy: Zod validates the request ENVELOPE (top-level body shape) and
// produces consistent, structured error messages. The proven, hardened
// recursive step sanitization in validation.ts (validateSteps) is kept as a
// second pass for the deep `steps` tree (legacy-format handling, size limits,
// nested if/while/try/switch blocks). This unifies error handling without
// discarding battle-tested logic.
// ============================================================

import { z } from 'zod';
import type { Response } from 'express';

// `steps` is validated in depth by validateSteps(); here we only assert it is
// a non-empty array so Zod can short-circuit obviously-bad payloads with a
// clean message before the deep validator runs.
const stepsEnvelope = z
  .array(z.unknown(), { invalid_type_error: 'Steps must be an array' })
  .min(1, 'Steps cannot be empty');

// headless accepts boolean | string | number (coerced later by validateHeadless)
const headlessLoose = z.union([z.boolean(), z.string(), z.number()]).optional();

// Step 28: optional trigger data injected as the workflow's initial item
// stream. Either a webhook-style envelope ({ source:'webhook', body, headers,
// query, method }) or a manual payload ({ data: ... }). We validate it loosely
// here (an object) and let TriggerEngine map it to items[] in the worker.
const triggerDataLoose = z
  .object({}, { invalid_type_error: 'triggerData must be an object' })
  .passthrough()
  .optional()
  .nullable();

export const runBodySchema = z.object({
  userId: z.union([z.string(), z.number()], {
    required_error: 'userId is required',
    invalid_type_error: 'userId must be a string or number',
  }),
  steps: stepsEnvelope,
  headless: headlessLoose,
  webhookUrl: z.string().url('webhookUrl must be a valid URL').optional().nullable(),
  triggerData: triggerDataLoose,
});

// Basic cron shape check (5 or 6 space-separated fields). Detailed scheduling
// validity is enforced downstream by BullMQ's repeatable-job parser.
const cronField = z
  .string({ required_error: 'Cron expression required' })
  .trim()
  .min(1, 'Cron expression required')
  .refine(
    (c) => {
      const parts = c.split(' ').filter((p) => p.length > 0);
      return parts.length >= 5 && parts.length <= 6;
    },
    { message: 'Invalid cron format. Expected 5-6 parts: "minute hour day month weekday"' }
  );

export const scheduleBodySchema = z.object({
  userId: z.union([z.string(), z.number()], {
    required_error: 'userId is required',
    invalid_type_error: 'userId must be a string or number',
  }),
  cron: cronField,
  name: z.string().max(120).optional(),
  steps: stepsEnvelope,
  headless: headlessLoose,
  webhookUrl: z.string().url('webhookUrl must be a valid URL').optional().nullable(),
});

// [G2] Saved-workflow create/update envelope (Step 17). userId is taken from the
// URL path (and auth-bound), so it is NOT part of the body. `steps` is asserted
// here as a non-empty array and deep-validated by validateSteps() in the route.
export const workflowBodySchema = z.object({
  name: z
    .string({ required_error: 'name is required', invalid_type_error: 'name must be a string' })
    .trim()
    .min(1, 'name cannot be empty')
    .max(120, 'name must be at most 120 characters'),
  description: z.string().max(2000, 'description too long').optional().nullable(),
  steps: stepsEnvelope,
  headless: headlessLoose,
  webhookUrl: z.string().url('webhookUrl must be a valid URL').optional().nullable(),
});

export type RunBody = z.infer<typeof runBodySchema>;
export type ScheduleBody = z.infer<typeof scheduleBodySchema>;
export type WorkflowBody = z.infer<typeof workflowBodySchema>;

// Flatten a ZodError into a single readable message + structured field list.
export const formatZodError = (err: z.ZodError): { error: string; details: { path: string; message: string }[] } => {
  const details = err.errors.map((e) => ({
    path: e.path.join('.') || '(body)',
    message: e.message,
  }));
  const first = details[0];
  return {
    error: first ? `${first.path}: ${first.message}` : 'Invalid request body',
    details,
  };
};

// Parse a request body against a schema. On failure, writes a 400 JSON response
// and returns null so the caller can simply `return`.
export const parseBody = <T>(schema: z.ZodSchema<T>, body: unknown, res: Response): T | null => {
  const result = schema.safeParse(body);
  if (!result.success) {
    const { error, details } = formatZodError(result.error);
    res.status(400).json({ success: false, error, details });
    return null;
  }
  return result.data;
};
