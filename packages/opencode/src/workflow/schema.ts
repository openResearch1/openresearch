import z from "zod"

export namespace WorkflowSchema {
  export const Policy = z
    .object({
      can_next: z.array(z.string()).default([]),
      can_wait_interaction: z.boolean().default(false),
      can_edit_future: z.boolean().default(false),
      allowed_edit_ops: z.array(z.enum(["insert", "delete"])).default([]),
    })
    .meta({ ref: "WorkflowStepPolicy" })
  export type Policy = z.infer<typeof Policy>

  export const Step = z
    .object({
      kind: z.string(),
      title: z.string(),
      summary: z.string(),
      prompt: z.string(),
      policy: Policy,
    })
    .meta({ ref: "WorkflowStepTemplate" })
  export type Step = z.infer<typeof Step>

  export const Flow = z
    .object({
      title: z.string(),
      summary: z.string(),
      steps: z.array(z.string()),
    })
    .meta({ ref: "WorkflowFlow" })
  export type Flow = z.infer<typeof Flow>

  export const Template = z
    .object({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      description: z.string().optional(),
      defs: z.record(z.string(), Step),
      flows: z.record(z.string(), Flow),
      default_flow: z.string(),
    })
    .meta({ ref: "WorkflowTemplate" })
  export type Template = z.infer<typeof Template>
}
