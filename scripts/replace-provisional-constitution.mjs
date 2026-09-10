#!/usr/bin/env node
// A deployed constitution is never edited in place, including during migration.
console.error('憲法の直接置換は廃止しました。scripts/propose-governance-migration.mjs で改憲議題を登録し、現行憲法のAI審査と人間の投票を通してください。');
process.exitCode = 2;
