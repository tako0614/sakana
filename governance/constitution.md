# Sakana Community Constitution

## 1. Supremacy and public authority

This constitution is the highest rule of the community. A law, judgment, or
administrative act that conflicts with it has no effect. The governance bot may
exercise only the powers described by an active, versioned constitution and by
laws enacted under it.

## 2. Equal treatment and due process

Members are equal before the community rules. No member may be punished without
notice of the alleged violation, access to the evidence used against them, and a
reasonable opportunity to answer. A person is treated as not responsible unless
the judicial panel proves every element required by the applicable law.

## 3. Principle of legality

Only conduct prohibited by a law that was effective when the conduct occurred
may be punished. The law must state the prohibited conduct, the elements that
must be proved, and the allowed sanction types and maximums. Retroactive,
analogical, and above-maximum punishment is prohibited.

## 4. Legislation

Artificial intelligence may draft bills from formal petitions and periodic
reviews of recurring community disputes. A draft has no authority. Every bill
must complete public draft, constitutional review, debate, and voting stages in
that order. The active constitutional policy defines the minimum periods and
vote thresholds.

## 5. Voting and trusted users

The electorate scope is selected from the scopes allowed by the active policy
and is snapshotted when voting opens. The default all-member scope includes
every non-bot server member; a trusted-only scope may also be selected when the
policy permits it. A vote must meet both its ratio and participation quorum.
The server may optionally designate one Discord role as the trusted-user role;
the role name has no constitutional meaning. Trusted users may exercise the
veto and sanction-approval powers defined by the constitutional policy. When no
trusted role exists, trusted powers are unavailable rather than silently given
to another role. Every ballot and trusted action is public.

## 6. Judicial power

Judicial and constitutional decisions are produced by isolated panels that do
not possess Discord, database-mutation, browser, or other execution tools. A
normal finding of responsibility requires the panel threshold in the active
policy. Constitutional compliance requires the stricter constitutional-review
threshold. Every decision must identify the exact law version, offense, and
evidence records on which it relies.

## 7. Sanctions and appeal

Sanctions are limited to the allowlist in the active constitutional policy and
to the maximum written in the applicable law. A law may autonomously define a
named restriction profile by combining implementation-provided primitives such
as message quotas, link or attachment restrictions, reactions, voice, agent
usage, and governance participation. A law may not introduce executable code,
arbitrary Discord permissions, secrets, or a new primitive. Trusted approval
and appeal are required at the thresholds in that policy. Once an eligible
appeal is filed and while its review is pending, the member may speak only in
their private court thread inside this Discord server. Time spent under that
restriction counts toward a finite timeout.

## 8. Constitutional review and remedies

Every bill receives review before voting. Any human member may challenge an
enacted law, judgment, or administrative act afterward. An unconstitutional act
is stopped, reversible sanctions are reversed, and affected cases are marked for
remedy review.

## 9. Technical operator

The Discord owner and explicitly configured technical operators may bootstrap,
pause, recover, and audit the system. They may not manufacture a vote, verdict,
or law. Technical actions and trusted-role membership changes are published to
the audit ledger. Discord permission hierarchy remains an external technical
limit; if the bot cannot enforce a decision safely, it must fail closed.

## 10. Amendment

After bootstrap, this constitution and its constitutional policy may be changed
only through the amendment procedure and vote threshold in the active policy.
Security invariants that keep language-model output separate from executable
authority are implementation safeguards and cannot be disabled by model output.
