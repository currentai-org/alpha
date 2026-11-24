# The agent service on AWS, beside the E2B hosts

The agent service (`api/app.py`) and its model gateway (`api/gateway_serve.py`) on EC2, in the same account and
region as an E2B stack (`../e2b/`), so the agent reaches E2B over a VPC peering and the WireGuard link app
(`../../e2b-link/`) is no longer needed. Nothing here is tied to one account: the account is whatever `AWS_PROFILE` names, the region is `var.region`, and the state bucket is passed at
init, so standing it up in a second account is the same steps with a different profile and bucket.

## What it builds

```
web app ──HTTPS──▶ ALB ──host: agent_hostname──▶ agent instance :8731 ──peering──▶ E2B host :3000, :3002
E2B sandboxes ─────▶ ALB ──host: gateway_hostname─▶ gateway instance :8733 (nonce routes)
agent instance ─────────────────────────────────▶ gateway instance :8732 (grants, private)
```

- **Its own VPC** (`10.20.0.0/16`), peered to the E2B stack's VPC (found by its `Name` tag, `var.e2b_name`). Not
  subnets inside the E2B VPC: an E2B host cutover builds a new VPC and destroys the old one, and a subnet of ours
  would block that destroy. A cutover now means `-var e2b_name=<new stack>` and a re-apply here, which moves only
  the peering.
- **One instance per role**: the gateway holds the model tokens, the agent holds none. Both use Nitro
  types that encrypt in transit, so Embed's plain-HTTP ports and the gateway's private port never cross a network in
  the clear. No SSH; shell access is SSM.
- **The agent's `/data`** (tasks.db, session scratch) is its own encrypted EBS volume with `prevent_destroy`, so it
  outlives an instance replacement.
- **An ALB with one ACM certificate** for both names, TLS 1.2+, HTTP redirected. The security groups admit the
  instances' ports only from the ALB (and the gateway's private port only from the agent).
- **The containers cannot reach instance credentials**: IMDSv2 with a hop limit of 1. The agent's egress allowlist
  (`deploy/entrypoint.sh`) runs inside its own container network namespace with `NET_ADMIN`.

## Sizing

The agent runs on a `c7i.xlarge` (4 vCPU, 8 GiB) with a 20 GB `/data` volume, the gateway on a `c7i.large`
(2 vCPU, 4 GiB; the smallest type with in-transit encryption that builds the image comfortably). The ALB checks
`GET /healthz` every 15 s, and its 300 s deregistration delay matches the agent's drain on shutdown.

## Monthly cost (on-demand list prices in one EU region, 730 hours)

| item | USD |
|---|---|
| agent, c7i.xlarge at $0.2037/h | 148.70 |
| gateway, c7i.large at $0.10185/h | 74.35 |
| ALB, $0.027/h plus about one LCU at $0.008/h | 25.55 |
| gp3, 90 GB (40 + 30 root, 20 data) at $0.0952/GB | 8.57 |
| public IPv4, two instances and two ALB nodes at $0.005/h | 14.60 |
| two advanced-tier SSM parameters | 0.10 |
| **total, before data transfer and S3 (a few dollars)** | **about 272** |

Prices from the AWS Price List API; other regions differ. A one-year Compute Savings Plan takes roughly a quarter
off the two instances. A test stack that never sees load can run its agent on a `c7i.large` (about $74 less).

## Secrets and env

Nothing secret is in Terraform state. `deploy.sh` renders each role's env from three sources (`render_env.py`) and
writes it to one SecureString parameter per role, which only that role's instance can read:

1. the tracked Fly toml's `[env]` (`fly/agent-app.toml`, `fly/agent-proxy.toml`), so model and limit changes still
   land in one file for both platforms;
2. the Doppler keys named in `agent.keys` or `gateway.keys`, plus the stack's own `<role>.<stack>.keys` where one
   exists, from the Doppler project `agent-service` and the config named by `DOPPLER_CONFIG` (required; there is
   no default). `agent.production.keys` carries production's staged permission policy, trust thresholds and slot
   capacity, and the render refuses a production agent env whose policy is `allow` or missing;
3. this stack's addresses from `terraform output deploy`: the gateway's private URL, the E2B URLs, the public
   gateway URL, and `GATEWAY_PRIVATE_HOST=0.0.0.0` (the gateway's private port binds `::` by default, which is
   IPv6-only, and this VPC is IPv4).

A key missing from Doppler stops the deploy and is named; values are never printed. Each host keeps the env
of its current and previous release in a root-only directory on its encrypted volume, so a rollback runs the
previous release with its own env.

**Before the first deploy**, the Doppler config needs every key the two `.keys` files name: the provider tokens
for the gateway, and for the agent `E2B_API_KEY` (`terraform output -raw e2b_api_key` in `../e2b`), `E2B_TEMPLATE`
and the rest. Copy each value into the Doppler config, not into a file.

## Stand up

With an admin profile for the account that holds the E2B stack. Nothing here touches the E2B stack's own state; it
adds one route and two security-group rules to the E2B side.

    cd agent-service/deploy/aws/agent
    export AWS_PROFILE=<account admin profile>
    # once per account: the versioned, KMS-encrypted, public-blocked state bucket ../e2b uses works here too
    terraform init -backend-config=bucket=<state bucket> -backend-config=region=<region>
    VARS="-var e2b_name=<E2B stack name> -var agent_hostname=<agent name> -var gateway_hostname=<gateway name>"

    # 1. The certificate alone, then its validation records.
    terraform apply $VARS -target=aws_acm_certificate.this
    terraform output certificate_validation_records   # add each as a CNAME in the names' DNS zone

    # 2. Everything else. The apply waits (up to 30 min) for the certificate to validate.
    terraform apply $VARS
    terraform output alb_dns_name                       # CNAME both names to this

    # 3. The release: source, env, gateway, then agent.
    export DOPPLER_CONFIG=<config holding this stack's keys>
    ./deploy.sh --check-source
    ./deploy.sh

`deploy.sh` refuses unless `agent-service/` is clean and matches the commit it deploys: `AGENT_DEPLOY_REF` (a
branch, a tag or a commit) when set, otherwise the stack's branch (`STACK=develop` deploys `origin/develop`,
`STACK=production` deploys `origin/main`). It uploads that commit's `agent-service/` tree, writes both env
parameters, then runs `potluck-release` on each host over SSM. The host builds the image, restarts the container
and waits for its own `/healthz` (the agent's must name the new commit); when that fails it switches back to the
previous release and the deploy stops. Last, the script checks that the public agent name, through the ALB, serves
the new commit. `AGENT_AWS_DEPLOY_UNMERGED=<reason>` is the break-glass.

A second stack (production beside a test stack) is the same steps in its own workspace
(`terraform workspace select -or-create production`), with `-var stack=production`, its own `e2b_name`, a
`vpc_cidr` that does not overlap the first (`10.21.0.0/16`) and its own `DOPPLER_CONFIG`.

## First deploy checklist

1. **Stand up** as above.
2. **Health-check the stack** before anything points at it:
   - `curl https://<agent name>/healthz`: status ok, and the build is the commit you deployed.
   - `curl https://<gateway name>/healthz`: 200.
   - The build stamp and then a real task: `cd agent-service && AGENT_BASE=https://<agent name>
     AGENT_SMOKE_TOKEN=<from Doppler> fly/verify-deploy.sh`. The task runs code, so it proves the agent reached
     E2B over the peering and the sandbox reached the gateway's public name.
3. **Point the web app at it**: the web app finds the agent by `AGENT_SERVICE_URL` and sends `AGENT_SERVICE_TOKEN`
   as its bearer, an HS256 token signed with the agent's `WEBUI_SECRET_KEY`. Set the URL to
   `https://<agent name>`, keeping the old value to go back to.
4. **Watch** agent-mode turns succeed in the agent's logs.
5. **Roll back** a bad release with `./deploy.sh --rollback`, which returns both hosts to their previous release.

`.github/workflows/agent-service-deploy.yml` runs `deploy.sh` from CI with a deploy role, a read-only Doppler service token for the stack's config, and the state bucket,
all from repository variables and secrets. It verifies with `fly/verify-deploy.sh` (the script keeps its old
directory) and, when that fails, runs `deploy.sh --rollback` and verifies the build that was serving. A run with
any of them missing fails rather than skipping.

## Changing a host

An instance ignores later changes to its image and boot script, so an apply never replaces a serving host as a side
effect. To change one on purpose: `terraform apply -replace='aws_instance.host["gateway"]'` (or `["agent"]`, whose
data volume re-attaches), then `./deploy.sh` to release onto it. The agent is down for the replacement, a few
minutes; on a test stack that is acceptable, and production should point `AGENT_SERVICE_URL` at a second stack instead.

## A second account

Same steps in the other account once its E2B stack exists: its own admin profile, its own state bucket at init, and
the same Doppler keys in the organisation's Doppler. Nothing in this directory names an account.
