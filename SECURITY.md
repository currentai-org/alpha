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

Secrets, deployment settings and account ids are not in this tree. The policies and reference vectors for
the optional safety judge ship as placeholders (`web/src/lib/chat/server/rules-s1.json`,
`web/src/lib/chat/server/data/guard-vectors.json`); the screen that runs by default reads
`web/src/lib/chat/server/rules.json`, which is here in full.
