import { isArray, isRecord, oneOf, type HumanAuthority, type HumanScope } from './types.js';

// Law-defined selectors. Resolution receives Discord state explicitly so the
// compiler never depends on mutable roles or operational configuration.
export const HUMAN_SCOPES: HumanScope[] = ['all', 'trusted', 'administrators', 'operators', 'designated'];

export function validateHumanAuthority(value: unknown, { veto = false }: { veto?: boolean } = {}): HumanAuthority {
  assertHumanAuthority(value, veto);
  return value;
}

function idCount(ids: unknown): number {
  return isArray(ids) ? ids.length : 0;
}

function assertHumanAuthority(value: unknown, veto: boolean): asserts value is HumanAuthority {
  if (!isRecord(value)) throw new Error('人間の権限対象が不正です。');
  const allowed = ['scope', 'users', 'roles', ...(veto ? ['required'] : [])];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !oneOf(HUMAN_SCOPES, value.scope)) throw new Error('未対応の人間の権限対象です。');
  for (const key of ['users', 'roles']) {
    const ids: unknown = value[key];
    if (ids === undefined) continue;
    if (value.scope !== 'designated' || !isArray(ids) || ids.length > 100
      || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !/^\d{17,20}$/.test(id))) throw new Error('指定ユーザー・ロールは重複のないDiscord IDで定めてください。');
  }
  if (value.scope === 'designated' && !(idCount(value.users) || idCount(value.roles))) throw new Error('承認されたユーザーまたはロールの指定が必要です。');
  const required = value.required;
  if (veto && (typeof required !== 'number' || !Number.isInteger(required) || required < 1 || required > 100)) throw new Error('拒否権の必要人数は1〜100人です。');
}

/** 権限対象を判定するときに読む、Discord の GuildMember の項目。 */
export interface HumanMemberCandidate {
  id: string;
  user?: { bot?: boolean } | null;
  roles?: { cache?: { has(id: string): boolean } | null } | null;
  permissions?: { has?(permission: bigint): boolean } | null;
}

export interface HumanSelectionContext {
  guild: { ownerId: string };
  trustedRoleId?: string | null;
  operators?: readonly string[];
  exclude?: readonly (string | null | undefined)[];
}

export function selectHumanMembers(
  members: { values(): Iterable<HumanMemberCandidate> },
  authority: HumanAuthority,
  { guild, trustedRoleId, operators = [], exclude = [] }: HumanSelectionContext
): string[] {
  return [...members.values()].filter((member) => {
    if (member.user?.bot || exclude.includes(member.id)) return false;
    switch (authority.scope) {
      case 'all': return true;
      case 'trusted': return Boolean(trustedRoleId && member.roles?.cache?.has(trustedRoleId));
      case 'administrators': return member.id === guild.ownerId || Boolean(member.permissions?.has?.(8n));
      case 'operators': return member.id === guild.ownerId || operators.includes(member.id);
      case 'designated': return authority.users?.includes(member.id) || authority.roles?.some((id) => member.roles?.cache?.has(id));
      default: throw new Error('未対応の人間の権限対象です。');
    }
  }).map((member) => member.id);
}

const SCOPE_LABELS: Readonly<Record<string, string>> = { all: '全員', trusted: '特別有権者', administrators: 'Discord管理者', operators: '統治運営者' };

/** 表示に使う権限対象の項目。保存済みの承認記録 (scope を直接持つ旧形式) もそのまま渡せる。 */
export interface AuthorityLabelSource {
  scope?: string;
  users?: readonly unknown[];
  roles?: readonly unknown[];
}

export function humanAuthorityLabel(authority: AuthorityLabelSource | null | undefined): string {
  if (!authority) return '指定なし';
  if (authority.scope === 'designated') return `指定ユーザー${authority.users?.length ?? 0}人・指定ロール${authority.roles?.length ?? 0}件`;
  return SCOPE_LABELS[String(authority.scope)] ?? '指定なし';
}
