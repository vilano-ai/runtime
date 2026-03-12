import { workflow } from "@vilano/runtime";

import { operator, optionsPayloadProbe, reviewer } from "./services";

export const reviewCoordinator = workflow({
  name: "reviewCoordinator",
  run: async (input: { repoId: string; note: string }, ctx) => {
    const reviewerRef = await ctx.connect(reviewer, { repoId: input.repoId });
    await reviewerRef.send.hint({ note: input.note });
    const status = await reviewerRef.ask.status();

    return { reviewerRunId: reviewerRef.id, status };
  },
});

export const approvalCoordinator = workflow({
  name: "approvalCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });
    const approval = await operatorRef.ask.awaitApproval();

    return { operatorRunId: operatorRef.id, approval };
  },
});

export const askTimeoutCoordinator = workflow({
  name: "askTimeoutCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });
    return await operatorRef.ask.awaitApproval(undefined, { timeout: "100ms" });
  },
});

export const servicePayloadShapeCoordinator = workflow({
  name: "servicePayloadShapeCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const probe = await ctx.connect(optionsPayloadProbe, { sessionId: input.sessionId });
    return await probe.ask.echo({ key: "payload-key", timeout: "payload-timeout" });
  },
});

export const serviceStatusCoordinator = workflow({
  name: "serviceStatusCoordinator",
  run: async (input: { sessionId: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });

    return {
      status: await operatorRef.status(),
      serviceRunId: operatorRef.id,
    };
  },
});

export const serviceTurnCoordinator = workflow({
  name: "serviceTurnCoordinator",
  run: async (input: { sessionId: string; topic: string }, ctx) => {
    const operatorRef = await ctx.connect(operator, { sessionId: input.sessionId });
    const pipeline = await operatorRef.ask.pipeline({ topic: input.topic });

    return {
      operatorRunId: operatorRef.id,
      pipeline,
    };
  },
});

export const singletonLookupCoordinator = workflow({
  name: "singletonLookupCoordinator",
  run: async (input: { sessionId: string; topic: string }, ctx) => {
    const connected = await ctx.connect(operator, { sessionId: input.sessionId });
    const typed = await ctx.lookup(operator, { sessionId: input.sessionId });
    const discovered = await ctx.lookupSingleton("operator", {
      sessionId: input.sessionId,
    });

    return {
      connectedRunId: connected.id,
      typedRunId: typed.id,
      discoveredRunId: discovered.id,
      discoveredDefinition: discovered.definitionName,
      discoveredKey: discovered.serviceKey,
      discoveredStatus: await discovered.status(),
      typedResult: await typed.ask.pipeline({ topic: `${input.topic}-typed` }),
      discoveredResult: await discovered.ask("pipeline", { topic: input.topic }),
    };
  },
});
