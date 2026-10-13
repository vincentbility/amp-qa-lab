# Amp QA automation lab

Public, minimal experiment for `vincentbility/amp-qa-lab`. This repository tests
GitHub events, Amp delivery, real Puck handoff and GitHub Actions bot reporting.
It contains only an automation harness: no application, database, production
configuration, credentials, private Puck identifiers or upstream Git history.

## Prerequisites

1. The owner creates this GitHub repository and grants the existing
   Amp GitHub App access to this repository only.
2. Publish this reviewed harness to `main`; keep `main` as GitHub's default branch.
   GitHub Actions must be enabled. Reporter credentials stay in Actions.
3. Create a dedicated Amp workspace project pointing to this repository, base
   `main`, without adding production secrets. Workspace inheritance still exists;
   a separate project is not an enforceable credential sandbox.
4. Create the `amp-qa-pilot` label and a label-filtered PR-opening spawner targeting
   that exact project before opening a labeled test PR. Keep other repositories
   and the upstream project's settings unchanged.
5. Each execution user selects their own real Puck with personal-scope
   `AMP_GITHUB_PUCK_THREAD_ID`, as described in [AGENTS.md](AGENTS.md). No shared
   route file or project Pre-setup Script is needed. Questions from a different
   or unverifiable author remain ROUTING_BLOCKED, never go to the subscriber's
   Puck. Automatic execution as other authors has not been established.

## Local validation

```sh
node --check .github/scripts/amp-pr-reporter.mjs
node --test .github/scripts/amp-pr-reporter.test.mjs
```

## Live acceptance

Open a same-repository Markdown-only PR labeled `amp-qa-pilot`. Test fresh issue
and review comments: a question, an explicit QA request, an ambiguous mention and
a no-mention control. Require real native delivery or a verified bot receipt,
one source reaction, actual correlated Puck replies and correctly placed
`github-actions[bot]` answers. Direct/receipt duplicates share one source key.
Never manually forward a missing event and count it as automatic delivery.

Verify a missing personal route discloses ROUTING_BLOCKED with zero Puck/QA
calls, then configure the execution user's own route and test fresh matching-
author issue/review questions. Numeric author/dispatcher mismatch, spoofed
payload identities and absent/bot senders must reject personal answers. Mock
cross-user tests are not multi-user native delivery proof.

The review relay uses PR-controlled workflow YAML without checkout; the
privileged receiver and report dispatch use default-branch definitions and code.
The reporter is scoped to this lab only. It does not call a model or execute QA.
For QA this lab verifies only Markdown/preflight contracts and the trusted-base
reporter tests; it does not validate any application's behavior or reset services.

Record each layer's status separately. Unit tests, a successful relay, an orb
summary or manually posting with the owner's account are not end-to-end PASS.
