import { service, workflow } from "@vilano/runtime";

type BriefKey = {
  briefId: string;
};

export const researchAgent = service({
  name: "researchAgent",
  key: (input: BriefKey) => input.briefId,
  init: async (input: BriefKey) => ({
    briefId: input.briefId,
    findings: [] as string[],
  }),
  onAsk: {
    investigate: async (payload: { topic: string; angle: string }, state) => {
      const finding = `${payload.angle}: ${payload.topic}`;
      const findings = [...state.findings, finding];

      return {
        state: {
          ...state,
          findings,
        },
        reply: {
          finding,
          findings,
        },
      };
    },
    history: async (_payload: void, state) => ({
      reply: {
        findings: state.findings,
      },
    }),
  },
});

export const writerAgent = service({
  name: "writerAgent",
  key: (input: BriefKey) => input.briefId,
  init: async (input: BriefKey) => ({
    briefId: input.briefId,
    audience: "general",
    drafts: [] as string[],
  }),
  onSend: {
    setAudience: async (payload: { audience: string }, state) => ({
      state: {
        ...state,
        audience: payload.audience,
      },
    }),
  },
  onAsk: {
    draft: async (payload: { topic: string; findings: string[] }, state) => {
      const draft = [
        `Audience: ${state.audience}`,
        `Topic: ${payload.topic}`,
        ...payload.findings.map((finding) => `- ${finding}`),
      ].join("\n");

      return {
        state: {
          ...state,
          drafts: [...state.drafts, draft],
        },
        reply: {
          audience: state.audience,
          draft,
        },
      };
    },
    history: async (_payload: void, state) => ({
      reply: {
        drafts: state.drafts,
      },
    }),
  },
});

export const reviewerAgent = service({
  name: "reviewerAgent",
  key: (input: BriefKey) => input.briefId,
  init: async (input: BriefKey) => ({
    briefId: input.briefId,
    notes: [] as string[],
  }),
  onAsk: {
    review: async (payload: { draft: string }, state) => {
      const note = payload.draft.includes("risks:")
        ? "approved for operator review"
        : "add an explicit risks section";

      return {
        state: {
          ...state,
          notes: [...state.notes, note],
        },
        reply: {
          approved: note === "approved for operator review",
          note,
        },
      };
    },
    status: async (_payload: void, state) => ({
      reply: {
        reviews: state.notes.length,
        latestNote: state.notes[state.notes.length - 1] ?? null,
      },
    }),
  },
});

export const multiAgentCoordinator = workflow({
  name: "multiAgentCoordinator",
  run: async (input: { briefId: string; topic: string; audience: string }, ctx) => {
    const researcher = await ctx.connect(researchAgent, { briefId: input.briefId });
    const writer = await ctx.connect(writerAgent, { briefId: input.briefId });
    const reviewer = await ctx.connect(reviewerAgent, { briefId: input.briefId });

    const market = await researcher.ask.investigate({
      topic: input.topic,
      angle: "market",
    });
    const risks = await researcher.ask.investigate({
      topic: input.topic,
      angle: "risks",
    });

    await writer.send.setAudience({ audience: input.audience });
    const draft = await writer.ask.draft({
      topic: input.topic,
      findings: [market.finding, risks.finding],
    });

    const review = await reviewer.ask.review({ draft: draft.draft });
    const reviewerStatus = await reviewer.ask.status();

    return {
      briefId: input.briefId,
      researchFindings: [market.finding, risks.finding],
      draft: draft.draft,
      review,
      reviewerStatus,
      agentRunIds: {
        researchAgent: researcher.id,
        writerAgent: writer.id,
        reviewerAgent: reviewer.id,
      },
    };
  },
});
