import { createLegalTask, getActiveConstitution, getConstitution, getLegalSnapshot, listLegalTasks,
  listLaws, recordInstitutionEffect, saveLegalSnapshot, updateLegalTask, enqueueAction, ensureLegalRecoveryProposal } from './db.js';
import { legalDuration } from './legal-system.js';
import { runLegalProcedure } from './procedure-runtime.js';
import { runInstitutionTask } from './llm.js';

export function dispatchInstitutionEvent(guildId, event, input, eventId, now = Date.now()) {
  const constitution = getActiveConstitution(guildId);
  if (!constitution?.policy.autonomous || constitution.rules.recovery) return [];
  const snapshotHash = saveLegalSnapshot(constitution);
  return Object.entries(constitution.rules.procedures)
    .filter(([, procedure]) => procedure.trigger?.event === event)
    .map(([id, procedure]) => createLegalTask({ guildId, procedureId: id, snapshotHash,
      eventKey: `${guildId}:${id}:${event}:${eventId}`, state: procedure.initial, input, now }));
}

export async function runInstitutionProcedures(guild, now = Date.now()) {
  const active = getActiveConstitution(guild.id);
  if (!active?.policy.autonomous) return;
  if (active.rules.recovery) {
    ensureLegalRecoveryProposal(guild.id, now);
    return;
  }
  const snapshotHash = saveLegalSnapshot(active);
  for (const [id, procedure] of Object.entries(active.rules.procedures)) {
    if (procedure.trigger?.event !== 'schedule') continue;
    const source = active.rules.sources[`procedure:${id}`];
    createLegalTask({ guildId: guild.id, procedureId: id, snapshotHash,
      eventKey: `${guild.id}:${id}:${source.hash}:${Math.floor(now / legalDuration(procedure.trigger.interval))}`,
      state: procedure.initial, input: { event: 'schedule' }, now });
  }
  for (const task of listLegalTasks(guild.id, { now })) {
    try {
      const snapshot = getLegalSnapshot(task.snapshot_hash);
      if (!snapshot || snapshot.guildId !== guild.id) throw new Error('機関の適用法令snapshotが不正です。');
      const constitution = { ...getConstitution(snapshot.constitutionId), ...snapshot };
      const procedure = snapshot.rules.procedures[task.procedure_id];
      await runLegalProcedure({ procedure, state: task.state, context: task.context, wakeAt: task.wake_at,
        now, identity: `institution:${task.id}`,
        persist: (patch) => updateLegalTask(task.id, patch),
        operations: {
          async agent_task({ definition, key, context }) {
            const institution = snapshot.rules.institutions[definition.config.institution];
            const result = await runInstitutionTask({ guildId: guild.id, constitution, institution, procedure,
              input: { ...context.input, laws: listLaws(guild.id, { limit: 10000 }) } });
            const effect = recordInstitutionEffect({ task, eventKey: key, result, effect: definition.config.effect, constitution: active });
            enqueueAction({ guildId: guild.id, actionType: 'institution_notice', targetId: task.id,
              payload: { text: `${institution.name}: ${result.output.title}\n${result.output.summary}\n${result.output.reasons.join('\n')}` },
              idempotencyKey: `institution-notice:${key}` });
            return { outcome: 'completed', context: { result, effect } };
          },
          async notice({ definition, key }) {
            enqueueAction({ guildId: guild.id, actionType: 'institution_notice', targetId: task.id,
              payload: { text: definition.config.text ?? procedure.mandate }, idempotencyKey: key });
            return { outcome: 'completed' };
          }
        }
      });
    } catch (error) { updateLegalTask(task.id, { error }); }
  }
}
