# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Please do not open a public issue for it.

Say what you found, where in the code it lives, and how to reproduce it. A report about the hosted service
at aipotluck.org is welcome too, as long as you only test against your own account and data.

We will confirm we have your report and tell you what we plan to do about it. Fixes are made in the private
monorepo this snapshot comes from, deployed there first, and arrive here with the next snapshot. Tell us if
you would like to be credited.

## What this snapshot leaves out

Secrets, deployment settings and account ids are not in this tree. The optional S1 safety judge's
policies (`web/src/lib/chat/server/rules-s1.json`) and the semantic guards' precomputed example embeddings
(`web/src/lib/chat/server/data/guard-vectors.json`) ship as placeholders.

`web/src/lib/chat/server/rules.json` is the screening policy: its categories, the queries that detect
them, and the copy a declined turn shows. It is here in full, but it detects nothing on its own. It is
enforced by the Shieldstral guard, which needs the `guard-primary` flag on and `GUARD_SHADOW_URL` set.
With that flag off (the default), the screen is Coop (`COOP_URL`, `COOP_API_KEY`), whose rules live in
the Coop service and are not in this repository. With neither configured, moderation allows everything
off a deployment; on a deployment (`DEPLOY_ENV` or `VERCEL_ENV` set to `production` or `preview`) the
child-safety check fails closed and every turn is declined.
