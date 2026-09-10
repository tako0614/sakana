// Law-defined selectors. Resolution receives Discord state explicitly so the
// compiler never depends on mutable roles or operational configuration.
export const HUMAN_SCOPES = ['all', 'trusted', 'administrators', 'operators', 'designated'];

export function validateHumanAuthority(value, { veto = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人間の権限対象が不正です。');
  const allowed = ['scope', 'users', 'roles', ...(veto ? ['required'] : [])];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !HUMAN_SCOPES.includes(value.scope)) throw new Error('未対応の人間の権限対象です。');
  for (const key of ['users', 'roles']) {
    if (value[key] === undefined) continue;
    if (value.scope !== 'designated' || !Array.isArray(value[key]) || value[key].length > 100
      || new Set(value[key]).size !== value[key].length || value[key].some((id) => typeof id !== 'string' || !/^\d{17,20}$/.test(id))) throw new Error('指定ユーザー・ロールは重複のないDiscord IDで定めてください。');
  }
  if (value.scope === 'designated' && !(value.users?.length || value.roles?.length)) throw new Error('承認されたユーザーまたはロールの指定が必要です。');
  if (veto && (!Number.isInteger(value.required) || value.required < 1 || value.required > 100)) throw new Error('拒否権の必要人数は1〜100人です。');
  return value;
}

export function selectHumanMembers(members, authority, { guild, trustedRoleId, operators = [], exclude = [] }) {
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

export function humanAuthorityLabel(authority) {
  if (!authority) return '指定なし';
  return { all: '全員', trusted: '特別有権者', administrators: 'Discord管理者', operators: '統治運営者',
    designated: `指定ユーザー${authority.users?.length ?? 0}人・指定ロール${authority.roles?.length ?? 0}件` }[authority.scope] ?? '指定なし';
}
