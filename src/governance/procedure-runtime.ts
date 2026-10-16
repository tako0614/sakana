import { legalDuration, validateLegalProcedure } from './legal-system.js';
import type { LegalProcedure, ProcedureState, WorkflowContext } from './types.js';

export const procedureVisits = (context: WorkflowContext, state: string): number => Number(context.visits?.[state] ?? 0);
export const procedureExhausted = (definition: ProcedureState, context: WorkflowContext, state: string): boolean => definition.config.maximumVisits !== undefined
  && procedureVisits(context, state) >= definition.config.maximumVisits;
export const recordProcedureVisit = (context: WorkflowContext, state: string): WorkflowContext => ({ ...context,
  visits: { ...context.visits, [state]: procedureVisits(context, state) + 1 } });

export interface ProcedureOperationInput {
  state: string;
  definition: ProcedureState;
  context: WorkflowContext;
  key: string;
}

/** 操作の結果。outcome は state の on に宣言された結果だけを受け付ける。 */
export interface ProcedureOperationResult {
  restart?: boolean;
  suspended?: boolean;
  outcome?: string;
  context?: WorkflowContext;
  wakeAt?: number | null;
}

export type ProcedureOperation = (input: ProcedureOperationInput) => Promise<ProcedureOperationResult | null | undefined>;

export interface ProcedurePersistPatch {
  state: string;
  context: WorkflowContext;
  wakeAt: number | null;
  completed?: boolean;
  event?: string;
  previousState?: string;
  operationKey?: string;
}

export interface RunLegalProcedureInput {
  procedure: LegalProcedure;
  state: string;
  context?: WorkflowContext;
  wakeAt?: number | null;
  now?: number;
  operations: Partial<Record<string, ProcedureOperation>>;
  persist: (patch: ProcedurePersistPatch) => unknown;
  identity: string;
  maximumOperations?: number;
}

export type RunLegalProcedureResult =
  | { restarted: true }
  | { restarted?: undefined; state: string; context: WorkflowContext; wakeAt?: number | null; completed: boolean };

// This executor knows operations, persistence and declared transitions, not institutions
// or political outcomes. A failed operation retains its identity for durable retry.
export async function runLegalProcedure({ procedure, state, context = {}, wakeAt = null, now = Date.now(), operations, persist, identity, maximumOperations = 100 }: RunLegalProcedureInput): Promise<RunLegalProcedureResult> {
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
      // 試行回数を定める state には終端の exhausted が必ずある (validateLegalProcedure)。
      const exhausted = definition.on.exhausted;
      if (exhausted === undefined) throw new Error(`unknown persisted legal state: ${String(exhausted)}`);
      state = exhausted;
      await persist({ state, context, wakeAt: null, event: 'exhausted' });
      continue;
    }
    if (definition.handler === 'wait') {
      if (!wakeAt) {
        wakeAt = now + legalDuration(definition.duration);
        await persist({ state, context, wakeAt, event: 'waiting' });
        return { state, context, wakeAt, completed: false };
      }
      const expired = definition.on.expired;
      if (!expired) throw new Error('legal wait has no expired outcome');
      state = expired;
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
    const outcome = result?.outcome;
    const next = typeof outcome === 'string' && Object.hasOwn(definition.on, outcome) ? definition.on[outcome] : undefined;
    if (!result || outcome === undefined || next === undefined) throw new Error(`undeclared legal outcome: ${state}.${String(outcome)}`);
    context = recordProcedureVisit({ ...context, ...(result.context ?? {}) }, state);
    delete context.pending;
    const previousState = state;
    state = next;
    wakeAt = result.wakeAt ?? null;
    await persist({ state, context, wakeAt, event: outcome, previousState, operationKey: key });
  }
  // A runtime resource boundary is never a political rejection or a judgment.
  throw new Error('legal procedure yielded at the runtime operation limit; saved work will resume');
}
