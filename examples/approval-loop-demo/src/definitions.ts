import { workflow } from "@vilano/runtime";

export const approvalLoop = workflow({
  name: "approvalLoop",
  run: async (input: { topic: string }, ctx) => {
    const draft = await ctx.step(
      "draft-brief",
      async () => ({
        topic: input.topic,
        summary: `Drafted brief for ${input.topic}`,
      }),
      { key: `draft:${input.topic}` }
    );

    const approval = await ctx.waitForSignal("approved", { key: "approved" });

    return {
      draft,
      approval,
    };
  },
});
