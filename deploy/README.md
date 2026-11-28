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

The server deletes expired guest data itself, once a day, with no cron: `../selfhost/README.md`
("Expired guest data") says what goes and how to confirm a run with `docker compose logs web`.

The image is `ghcr.io/currentai-org/alpha`, for linux/amd64 and linux/arm64. `compose.yaml` pins a
release tag (`0.3.0-preview.2`). <!-- x-release-please-version --> Other tags: `X.Y.Z` and `X.Y` for each release, `stable` for the newest
release, `main` and `sha-<commit>` when a maintainer runs the workflow by hand on main. There is no
`latest`. Pre-release tags (`X.Y.Z-preview.N`, `-rc.N`) publish only their own tag, never `X.Y` or `stable`.
Releases are semver tags (`vX.Y.Z` in git, `X.Y.Z` on the image), never date tags. `main` is the
edge build for testing: pin a release tag or a digest, not `main`.

This file never builds, so what runs is always the pulled image. To run your own changes, use
`../selfhost/`, which builds from this checkout under its own tag (about 6 GB of RAM once).

## Verify the image

`.github/workflows/image.yml` builds every image in this repository's CI. It signs each one with
[cosign](https://github.com/sigstore/cosign) keyless signing and records a build provenance
attestation. Check both before you run a new tag:

<!-- x-release-please-start-version -->

```sh
cosign verify ghcr.io/currentai-org/alpha:0.3.0-preview.2 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/currentai-org/alpha/\.github/workflows/image\.yml@refs/(tags/v.+|heads/main)$'

gh attestation verify oci://ghcr.io/currentai-org/alpha:0.3.0-preview.2 --repo currentai-org/alpha
```

The first command passes only if the signature came from that workflow in this repository, run for a
version tag or for main. The second checks the provenance: which commit and which workflow run built
the image. Each platform image also carries an SPDX SBOM:

```sh
docker buildx imagetools inspect ghcr.io/currentai-org/alpha:0.3.0-preview.2 --format '{{ json .SBOM }}'
```

<!-- x-release-please-end -->

To pin what you verified exactly, set `ALPHA_IMAGE=ghcr.io/currentai-org/alpha@sha256:<digest>` in
`.env`. `cosign verify` prints the digest.

## Upgrade

The app applies database migrations when it starts, and only forward: starting an older image does not
undo them. Back up first, every time.

1. Read the release notes for each version between yours and the new one. They name every database
   migration and every breaking configuration change in it.
2. Back up the database and the `files` volume, which holds SeaweedFS's data, that is people's files:
   `ALPHA_COMPOSE_DIR=. ../selfhost/backup.sh` writes `backups/<UTC time>/` here, with `db.sql.gz` and
   `files.tar.gz`. It stops `web` and `files` for the seconds the volume copy takes.
3. Verify the new tag as above, then set it in `.env`: `ALPHA_IMAGE=ghcr.io/currentai-org/alpha:<version>`.
4. `docker compose pull && docker compose up -d`.

To roll back, set `ALPHA_IMAGE` back to the old tag and restore the backup from step 2 into a fresh
stack. Anything written after that backup is lost:

```sh
docker compose down -v      # deletes the db and files volumes
docker compose up -d
ALPHA_COMPOSE_DIR=. ../selfhost/restore.sh backups/<the backup from step 2>
```

Keep `.env` safe apart from the backups: `BETTER_AUTH_SECRET` signs every session, and
`../selfhost/README.md` ("What to keep safe") lists what each piece protects.
