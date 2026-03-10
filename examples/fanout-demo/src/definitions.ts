import { workflow } from "@vilano/runtime";

export const researchSlice = workflow({
  name: "researchSlice",
  run: async (input: { topic: string; angle: string }, ctx) => {
    return await ctx.step(
      "collect-slice",
      async () => ({
        angle: input.angle,
        summary: `${input.angle}: ${input.topic}`,
      }),
      { key: `collect:${input.angle}` }
    );
  },
});

export const parallelReport = workflow({
  name: "parallelReport",
  run: async (input: { topic: string }, ctx) => {
    const market = ctx.spawn(
      researchSlice,
      { topic: input.topic, angle: "market" },
      { key: "market" }
    );
    const operations = ctx.spawn(
      researchSlice,
      { topic: input.topic, angle: "operations" },
      { key: "operations" }
    );
    const risks = ctx.spawn(
      researchSlice,
      { topic: input.topic, angle: "risks" },
      { key: "risks" }
    );

    const sections = await Promise.all([
      market.result(),
      operations.result(),
      risks.result(),
    ]);

    return {
      topic: input.topic,
      sections,
    };
  },
});
