import { legalDuration, validateLegalProcedure } from './legal-system.js';

export const procedureVisits = (context, state) => Number(context.visits?.[state] ?? 0);
export const procedureExhausted = (definition, context, state) => definition.config.maximumVisits !== undefined
  && procedureVisits(context, state) >= definition.config.maximumVisits;
export const recordProcedureVisit = (context, state) => ({ ...context,
  visits: { ...context.visits, [state]: procedureVisits(context, state) + 1 } });

// This executor knows operations, persistence and declared transitions, not institutions
// or political outcomes. A failed operation retains its identity for durable retry.
export async function runLegalProcedure({ procedure, state, context = {}, wakeAt = null, now = Date.now(), operations, persist, identity, maximumOperations = 100 }) {
  validateLegalProcedure(procedure);
  context = structuredClone(context);
  for (let step = 0; step < maximumOperations; step += 1) {
    const definition = procedure.states[state];
    if (!definition) throw new Error(`unknown persisted legal state: ${state}`);
    if (definition.handler === 'terminal') {
      await persist({ state, context, wakeAt: null, completed: true });
      return { state, context, completed: true };
    }
    if (wakeAt && wakeAt > now && definition.handler !== 'public_vote') return { state, context, wakeAt, completed: false };
    const visits = procedureVisits(context, state);
    if (procedureExhausted(definition, context, state)) {
      context.exhausted = { state, visits, reason: '法律で定められた試行回数に達しました。' };
      state = definition.on.exhausted;
      await persist({ state, context, wakeAt: null, event: 'exhausted' });
      continue;
    }
    if (definition.handler === 'wait') {
      if (!wakeAt) {
        wakeAt = now + legalDuration(definition.duration);
        await persist({ state, context, wakeAt, event: 'waiting' });
        return { state, context, wakeAt, completed: false };
      }
      state = definition.on.expired;
      if (!state) throw new Error('legal wait has no expired outcome');
      wakeAt = null;
      await persist({ state, context, wakeAt, event: 'expired' });
      continue;
    }
    const operation = operations[definition.handler];
    if (typeof operation !== 'function') throw new Error(`operation is not available for this subject: ${definition.handler}`);
    const key = context.pending?.state === state
      ? context.pending.key : `${identity}:${state}:${visits + 1}`;
    context.pending = { state, key };
    await persist({ state, context, wakeAt: null, event: 'operation_started' });
    const result = await operation({ state, definition, context: structuredClone(context), key });
    if (result?.restart) return { restarted: true };
    if (result?.suspended) {
      context = { ...context, ...(result.context ?? {}) };
      await persist({ state, context, wakeAt: result.wakeAt ?? null, event: 'waiting' });
      return { state, context, wakeAt: result.wakeAt ?? null, completed: false };
    }
    if (!result || !Object.hasOwn(definition.on, result.outcome)) throw new Error(`undeclared legal outcome: ${state}.${result?.outcome}`);
    context = recordProcedureVisit({ ...context, ...(result.context ?? {}) }, state);
    delete context.pending;
    const previousState = state;
    state = definition.on[result.outcome];
    wakeAt = result.wakeAt ?? null;
    await persist({ state, context, wakeAt, event: result.outcome, previousState, operationKey: key });
  }
  // A runtime resource boundary is never a political rejection or a judgment.
  throw new Error('legal procedure yielded at the runtime operation limit; saved work will resume');
}
