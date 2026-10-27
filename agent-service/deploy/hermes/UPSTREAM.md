# Hermes upstream pin

The agent service builds NousResearch/hermes-agent at one release tag, plus the patches in this
directory. `deploy/Dockerfile` holds the pin (`HERMES_SHA`) and each patch's exit condition.

| Field | Value |
| --- | --- |
| Release | v0.21.6 |
| Commit | `818c13be1dc4fd28987e1e881a9408224afd4535` |
| Patches | `0002-acp-confirm-execute.patch` |
| Retired | `0001-acp-configurable-toolsets.patch`, replaced by upstream's `platform_toolsets.acp` |
| Review cadence | monthly, or sooner when an upstream ACP adapter fix is needed |

## Bumping

Upstream ships several commits a day, so review by release tag, not commit by commit.

1. `gh release list -R NousResearch/hermes-agent` names the newest tag.
2. Check out that tag and apply each patch with `git apply --check`. A patch that no longer
   applies fails the image build, which is intended.
3. Run upstream's `tests/acp_adapter` with the patches applied.
4. Load our `config.yaml` shape through upstream's `_get_platform_tools(load_config(), "acp")`.
   It must return exactly the toolsets `acp_client._write_acp_toolsets` writes.
5. Confirm an ACP session's system prompt still carries `Conversation started:`. Then move
   `_HERMES_SHA_DATE_ANCHOR_VERIFIED` in `api/test_agent_service.py` to the new commit.
6. Run `scripts/date_anchor_probe.py` against the redeployed pair.
7. Update this file.
