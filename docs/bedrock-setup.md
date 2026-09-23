# Running the loop's AI agents on your own AWS Bedrock

This guide is for a customer who wants the loop's AI agents (Builder, Auditor, Retro,
Demo, Redraft, @mention, Tool Install — and optionally Scout) to run their model
inference on **Amazon Bedrock, in your own AWS account**, instead of the dashboard
owner's Claude subscription.

**What this buys you:** the model calls, the billing, the CloudTrail audit trail, and
any Bedrock Guardrails you configure all live inside *your* AWS account. Nothing about
the model call touches the dashboard owner's infrastructure. The GitHub Actions job
still authenticates to AWS with short-lived, per-run credentials via OpenID Connect
(OIDC) — no long-lived AWS access keys are ever stored as a GitHub secret.

**Two things this does *not* change**, so you can set expectations correctly:

1. **The job still runs on a GitHub-hosted runner.** Your source code is checked out
   onto GitHub's infrastructure for the duration of the run — Bedrock only moves *where
   the model call happens*, not where the code is checked out. If "our code can never
   leave our network" is a hard requirement, ask about self-hosted runners in your own
   VPC; that's a separate, later option this guide doesn't cover.
2. **This only covers the loop's agents** (the workflows in `.github/workflows/`). It
   does not change how the dashboard itself runs its own AI features, which is a
   separate system with its own AWS account.

   > **Don't reuse this policy for the dashboard's own role.** The two use different
   > Bedrock APIs and therefore different IAM actions. The loop's agents go through
   > Claude Code's `InvokeModel` path, which is what the policy in Step 3 grants. The
   > dashboard's own AI calls (`lib/map-ai.ts`) default to Bedrock's newer *Mantle*
   > Messages API, which needs **`bedrock-mantle:CreateInference`** instead — granted
   > on the dashboard's ECS task role, not on the role you create here. Copying the
   > Step 3 policy onto the dashboard's role produces a confusing access-denied error
   > naming an action you never called.

No prior AWS experience is assumed — follow the steps in order.

---

## Before you start: the Scout is a special case

**The Scout does not switch to Bedrock even if you turn Bedrock on for everything
else, unless you explicitly opt it in too.** Anthropic's own documentation states
plainly: *"The WebSearch tool is not available on Amazon Bedrock."*
(<https://code.claude.com/docs/en/amazon-bedrock>, "Configure Claude Code" section —
verified 2026-08-31.)

The Scout's job depends on that tool: whenever its evidence for a proposal comes from
outside your codebase — a platform change, a competitor's release, a new API — it is
required to cite a dated external source, and WebSearch is how it finds one. Moving the
Scout to Bedrock silently removes half its evidence floor. It still runs, but its
proposals get thinner without telling you why.

So there are two independent switches:

- `aiProvider` in `.github/loop-config.json` — controls the **Builder, Auditor, Retro,
  Demo, Redraft, @mention, and Tool Install** workflows.
- `scout.aiProvider` in the same file, inside the existing `scout` block — controls
  **only the Scout**, and defaults to `"subscription"` independently of the setting
  above. Only set it to `"bedrock"` once you've accepted the WebSearch tradeoff above.

(`WebFetch`, also available to every agent in this loop, is a client-side tool and is
*not* listed as unavailable on Bedrock — but treat that as unconfirmed until you've
watched a real Scout run on Bedrock actually use it successfully.)

---

## Step 1 — Add a GitHub OIDC identity provider to your AWS account

This lets AWS trust short-lived tokens issued by GitHub Actions, so nothing needs a
stored AWS key.

1. Sign in to the [AWS IAM console](https://console.aws.amazon.com/iam/) with an
   account that can create IAM resources.
2. In the left sidebar, go to **Identity providers** → **Add provider**.
3. Choose **OpenID Connect**.
4. Fill in:
   - **Provider URL:** `https://token.actions.githubusercontent.com`
   - **Audience:** `sts.amazonaws.com`
5. Click **Get thumbprint**, then **Add provider**.

If your AWS account already has a GitHub OIDC provider set up (common if you use GitHub
Actions to deploy elsewhere), you can reuse it — skip to Step 2.

---

## Step 2 — Create the IAM role the loop will assume

This is the role your GitHub Actions job will assume, scoped so that **only workflows
running in your specific repository** can use it.

1. In the IAM console, go to **Roles** → **Create role**.
2. Choose **Custom trust policy** and paste the JSON below, replacing:
   - `<ACCOUNT_ID>` with your 12-digit AWS account ID,
   - `<OWNER>/<REPO>` with your GitHub org/user and repository name (e.g.
     `acme-corp/website`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:*"
        }
      }
    }
  ]
}
```

**This scoping is a security requirement, not a suggestion.** The `sub` condition is
what stops any *other* GitHub repository — including ones you don't control — from
assuming this role. Never widen it to `repo:*:*` or drop the condition entirely.

If you want it even tighter — for example, only workflows running on `main`, not every
branch or PR — use this instead of the wildcard `:*`:

```json
"StringLike": {
  "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:ref:refs/heads/main"
}
```

Be aware: the loop's Scout, Builder, and Auditor workflows run on `workflow_dispatch`
and on PR branches (not just `main`), so a `ref:refs/heads/main`-only trust policy will
block those from ever assuming the role. Use the `:*` form unless you have a specific
reason to restrict further, and test after tightening.

3. Give the role a name, e.g. `github-actions-loop-bedrock`.
4. Finish creating the role — you'll attach the permissions policy next.

---

## Step 3 — Attach the Bedrock permissions policy

This is the exact policy Anthropic's Claude Code documentation specifies for
`claude-code-action` on Bedrock
(<https://code.claude.com/docs/en/amazon-bedrock>, "IAM configuration" — verified
2026-08-31). Attach it to the role you just created (**Add permissions** → **Create
inline policy** → JSON tab):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowModelAndInferenceProfileAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListInferenceProfiles",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": [
        "arn:aws:bedrock:*:*:inference-profile/*",
        "arn:aws:bedrock:*:*:application-inference-profile/*",
        "arn:aws:bedrock:*:*:foundation-model/*"
      ]
    },
    {
      "Sid": "AllowMarketplaceSubscription",
      "Effect": "Allow",
      "Action": ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:CalledViaLast": "bedrock.amazonaws.com" } }
    }
  ]
}
```

What each part does:

- `bedrock:InvokeModel` / `InvokeModelWithResponseStream` — actually calling the model.
- `bedrock:ListInferenceProfiles` / `GetInferenceProfile` — **not optional in
  practice.** Without `GetInferenceProfile`, Claude Code recovers automatically by
  retrying each request once with an alternate shape — it still works, but every new
  model adds an extra network round-trip. Grant it and skip the tax.
- The `aws-marketplace` statement — Anthropic's models on Bedrock are distributed
  through the AWS Marketplace; this lets the role complete that subscription step the
  first time a model is invoked. It's scoped with `aws:CalledViaLast` so it only applies
  when Bedrock itself is the caller, not general Marketplace access.

You can tighten `Resource` further to specific inference-profile ARNs once you know
exactly which models this loop will use, if your security policy requires it.

---

## Step 4 — Request model access in the Bedrock console

You have to explicitly request access to Anthropic's models once per AWS account (and
once per region, if you use more than one).

1. Open the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/) in the
   region you plan to use (`us-west-2` is the loop templates' default — see Step 5 if
   you want a different one).
2. Go to **Model catalog**.
3. Select an Anthropic Claude model (e.g. Claude Sonnet 4.6).
4. Complete the use-case access form. Access is typically granted immediately.
5. **If you use cross-region inference** (the loop templates do, by default — model IDs
   like `us.anthropic.claude-sonnet-4-6`), repeat this for every region that inference
   profile can route to. For a `us.` prefixed profile, that's every `us-*` region AWS
   currently includes in it — check the specific profile in the Bedrock console under
   **Cross-region inference** before you assume you're done after one region.

If your AWS account is part of an AWS Organization, you can submit this once from the
management account instead of per member account — see AWS's
`PutUseCaseForModelAccess` API if that applies to you.

---

## Step 5 — Configure this repository

Two places need to know about this: a GitHub repository secret (the AWS role AWS
trusts), and your `.github/loop-config.json` (which agents actually use it).

### 5a. Add the GitHub repository secret

In your repository: **Settings → Secrets and variables → Actions → New repository
secret**.

| Name | Value |
|---|---|
| `AWS_ROLE_TO_ASSUME` | The ARN of the role you created in Step 2, e.g. `arn:aws:iam::123456789012:role/github-actions-loop-bedrock` |

This is the **only** new secret required for the standard setup in this guide. You do
not need to touch `CLAUDE_CODE_OAUTH_TOKEN` — it stays in place and is simply unused by
whichever workflows you switch to Bedrock.

### 5b. Set `.github/loop-config.json`

Add (or edit) these fields in the repo's `.github/loop-config.json`:

```json
{
  "aiProvider": "bedrock",
  "bedrockRegion": "us-west-2",
  "scout": {
    "aiProvider": "subscription"
  }
}
```

- `aiProvider` — `"subscription"` (default, unchanged behavior) or `"bedrock"`. Applies
  to every agent **except** the Scout.
- `bedrockRegion` — which AWS region `configure-aws-credentials` uses and where the
  model call lands. Defaults to `us-west-2` if omitted. Must be a region where you
  completed Step 4.
- `scout.aiProvider` — leave as `"subscription"` (or omit it entirely) unless you've
  read and accepted the WebSearch tradeoff described above. This key is nested inside
  the existing `scout` block alongside `productSummary`, `currentGoals`, etc.

A missing file, a missing field, or a value that isn't `"subscription"` or `"bedrock"`
all fall back to `"subscription"` — the workflows log a warning and keep running rather
than failing, so a typo never silently breaks the loop.

---

## Step 6 — Verify it worked

1. In your repository's **Actions** tab, pick any Bedrock-eligible workflow (e.g.
   **Claude — Builder**) and run it manually via **Run workflow**
   (`workflow_dispatch`) if it supports that trigger, or trigger it the normal way
   (label an issue `approved`, open a PR, etc.).
2. Open the run and find the **Configure AWS credentials (OIDC) for Bedrock** step. It
   should succeed and print the assumed role's identity. If it fails with something
   like `Not authorized to perform sts:AssumeRoleWithWebIdentity`, re-check the trust
   policy's `sub` condition against your exact `<OWNER>/<REPO>` from Step 2, and confirm
   the OIDC provider URL from Step 1 matches exactly.
3. Find the actual agent step underneath it (e.g. **Demo agent (Bedrock)**). If it fails
   immediately with an access-denied error mentioning `bedrock:InvokeModel`, re-check
   the permissions policy from Step 3 and that you completed model access (Step 4) in
   the same region set in `bedrockRegion`.
4. Once a run succeeds, confirm the compliance claim end-to-end: open **CloudTrail** in
   your own AWS account, in the region you used, and look for `InvokeModel` /
   `InvokeModelWithResponseStream` events around the time the run executed. Their
   presence in *your* CloudTrail — not the dashboard owner's — is the proof this is
   really running in your account.
5. Check your AWS Bedrock usage/cost dashboard for the corresponding spend. Model cost
   for this loop is now on your AWS bill, not the dashboard owner's subscription.

---

## Reference: what changed in the workflow templates

Every workflow that invokes `anthropics/claude-code-action@v1` (Scout, Builder,
Auditor, Demo, Retro, Redraft, @mention, Tool Install) now reads the provider fields
above at the start of its job and runs one of two paths for its agent step — the
Claude-subscription path (`claude_code_oauth_token`, today's default) or the Bedrock
path (`use_bedrock: "true"` plus the `aws-actions/configure-aws-credentials@v4` step
above it). The prompt and tool-permission text is identical between the two paths — the
templates use a single YAML anchor for each, referenced from both branches — so nothing
about *what* the agent is told to do changes based on where it runs; only *which
account pays for and logs the inference* changes.

The model each workflow passes (`opus` by default, or the alias picked on the dashboard's
Model tab) is left as a Claude Code alias, unchanged, in both modes — Claude Code resolves that alias correctly for whichever provider is
active (see "Pin model versions" at
<https://code.claude.com/docs/en/amazon-bedrock>), so there's no separate Bedrock model
ID hard-coded in the templates to drift out of sync with the subscription path.
