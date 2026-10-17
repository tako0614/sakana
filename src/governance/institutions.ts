import type { Guild } from 'discord.js';
import { createLegalTask, getActiveConstitution, getConstitution, getLegalSnapshot, listLegalTasks,
  listLaws, recordInstitutionEffect, saveLegalSnapshot, updateLegalTask, enqueueAction, ensureLegalRecoveryProposal } from './db.js';
import { legalDuration } from './legal-system.js';
import { runLegalProcedure } from './procedure-runtime.js';
import { runInstitutionTask } from './llm.js';
import {
  isArray,
  isEffectiveLegalSystem,
  isRecord,
  isStringArray,
  type Constitution,
  type InstitutionTaskOutput,
  type InstitutionTaskResult,
  type LegalTask
} from './types.js';

function taskOutput(value: unknown): InstitutionTaskOutput | null {
  if (!isRecord(value) || typeof value.decision !== 'string' || typeof value.title !== 'string'
    || typeof value.summary !== 'string' || !isStringArray(value.reasons)) return null;
  return { decision: value.decision, title: value.title, summary: value.summary, reasons: value.reasons };
}

// 機関の席の結論は llm.js が検査して返す。ここでも記録と告知に使う形を確かめ、崩れていれば何も記録しない。
function institutionResult(value: unknown): InstitutionTaskResult {
  const output = isRecord(value) ? taskOutput(value.output) : null;
  const outputs = isRecord(value) && isArray(value.outputs) ? value.outputs.map(taskOutput) : null;
  if (!isRecord(value) || typeof value.decision !== 'string' || !output || !outputs || outputs.some((entry) => entry === null)) {
    throw new Error('機関のAI席の結論を読めませんでした。');
  }
  return { decision: value.decision, output, outputs: outputs.filter((entry) => entry !== null) };
}

export function dispatchInstitutionEvent(guildId: string, event: string, input: unknown, eventId: unknown, now = Date.now()): LegalTask[] {
  const constitution = getActiveConstitution(guildId);
  const rules = constitution?.rules;
  // 自律統治の憲法は必ず v2 の法体系を持つ。
  if (!constitution?.policy.autonomous || !isEffectiveLegalSystem(rules) || rules.recovery) return [];
  const snapshotHash = saveLegalSnapshot(constitution);
  return Object.entries(rules.procedures)
    .filter(([, procedure]) => procedure.trigger?.event === event)
    .map(([id, procedure]) => createLegalTask({ guildId, procedureId: id, snapshotHash,
      eventKey: `${guildId}:${id}:${event}:${String(eventId)}`, state: procedure.initial, input, now }));
}

export async function runInstitutionProcedures(guild: Guild, now = Date.now()): Promise<void> {
  const active = getActiveConstitution(guild.id);
  if (!active?.policy.autonomous) return;
  const activeRules = active.rules;
  if (!isEffectiveLegalSystem(activeRules)) return;
  if (activeRules.recovery) {
    ensureLegalRecoveryProposal(guild.id, now);
    return;
  }
  const snapshotHash = saveLegalSnapshot(active);
  for (const [id, procedure] of Object.entries(activeRules.procedures)) {
    if (procedure.trigger?.event !== 'schedule') continue;
    const source = activeRules.sources[`procedure:${id}`];
    if (!source) throw new Error(`procedure:${id} の制定根拠がありません。`);
    createLegalTask({ guildId: guild.id, procedureId: id, snapshotHash,
      eventKey: `${guild.id}:${id}:${source.hash}:${Math.floor(now / legalDuration(procedure.trigger.interval))}`,
      state: procedure.initial, input: { event: 'schedule' }, now });
  }
  for (const task of listLegalTasks(guild.id, { now })) {
    try {
      const snapshot = getLegalSnapshot(task.snapshot_hash);
      if (!snapshot || snapshot.guildId !== guild.id) throw new Error('機関の適用法令snapshotが不正です。');
      const rules = snapshot.rules;
      if (!isEffectiveLegalSystem(rules)) throw new Error('機関の適用法令snapshotが不正です。');
      const stored = getConstitution(snapshot.constitutionId);
      if (!stored) throw new Error('機関の適用法令snapshotが不正です。');
      // 案件を受けた時点の法体系 (snapshot) の実行規則と実行値で、その憲法を読み替える。
      const constitution: Constitution = { ...stored, rules, policy: snapshot.policy };
      const procedure = rules.procedures[task.procedure_id];
      if (!procedure) throw new Error('procedure: object required');
      await runLegalProcedure({ procedure, state: task.state, context: task.context, wakeAt: task.wake_at,
        now, identity: `institution:${task.id}`,
        persist: (patch) => updateLegalTask(task.id, patch),
        operations: {
          async agent_task({ definition, key, context }) {
            const institutionName = definition.config.institution;
            const institution = institutionName === undefined ? undefined : rules.institutions[institutionName];
            if (!institution) throw new Error('法律で機関が設置されていません。');
            const result = institutionResult(await runInstitutionTask({ guildId: guild.id, constitution, institution, procedure,
              input: { ...(isRecord(context.input) ? context.input : {}), laws: listLaws(guild.id, { limit: 10000 }) } }));
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
