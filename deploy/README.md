# Run Alpha from the published image

`compose.yaml` here runs Alpha from a prebuilt image, so your machine builds nothing. It starts the
app, Postgres and a SeaweedFS file store, and talks to one OpenAI-compatible model endpoint you name.
To run a small model on the same machine, or to build from source, use `../selfhost/` instead.

## Pull and run

You need Docker with Compose v2.20 or newer, and a model endpoint ending in `/v1`.

```sh
cd deploy
cp .env.example .env     # fill in BETTER_AUTH_SECRET, OPENAI_BASE_URL and the two FILES_ keys
docker compose pull
docker compose up -d
SMOKE_CHAT_PATH= ./smoke.sh   # one guest chat turn, end to end
```

Open http://localhost:3000. The app listens on 127.0.0.1 only. Before anyone else uses it, put a
TLS proxy in front, set `PUBLIC_ORIGIN` to its https origin and set `ALLOW_INSECURE_COOKIES=false`.

The image is `ghcr.io/currentai-org/alpha`, for linux/amd64 and linux/arm64. `compose.yaml` pins a
release tag (`0.1.0`). Other tags: `X.Y.Z` and `X.Y` for each release, `stable` for the newest
release, `main` and `sha-<commit>` when a maintainer runs the workflow by hand on main. There is no
`latest`.

No image can be pulled until the repository's first release tag has been published. This file never
builds, so what runs is always the pulled image. Until then, or to run your own changes, use
`../selfhost/`, which builds from this checkout under its own tag (about 6 GB of RAM once).

## Verify the image

`.github/workflows/image.yml` builds every image in this repository's CI. It signs each one with
[cosign](https://github.com/sigstore/cosign) keyless signing and records a build provenance
attestation. Check both before you run a new tag:

```sh
cosign verify ghcr.io/currentai-org/alpha:0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/currentai-org/alpha/\.github/workflows/image\.yml@refs/(tags/v.+|heads/main)$'

gh attestation verify oci://ghcr.io/currentai-org/alpha:0.1.0 --repo currentai-org/alpha
```

The first command passes only if the signature came from that workflow in this repository, run for a
version tag or for main. The second checks the provenance: which commit and which workflow run built
the image. Each platform image also carries an SPDX SBOM:

```sh
docker buildx imagetools inspect ghcr.io/currentai-org/alpha:0.1.0 --format '{{ json .SBOM }}'
```

To pin what you verified exactly, set `ALPHA_IMAGE=ghcr.io/currentai-org/alpha@sha256:<digest>` in
`.env`. `cosign verify` prints the digest.

## Upgrade

1. Read the release notes for the new version.
2. Back up the database: `docker compose exec db pg_dump -U alpha alpha > alpha-$(date +%F).sql`.
3. Verify the new tag as above, then set it in `.env`: `ALPHA_IMAGE=ghcr.io/currentai-org/alpha:<version>`.
4. `docker compose pull && docker compose up -d`.

The app applies database migrations when it starts. To roll back, set `ALPHA_IMAGE` back to the old
tag and restore the dump: a migration is not undone by starting an older image.
