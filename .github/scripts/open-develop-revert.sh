#!/usr/bin/env bash
# deploy.yml's revert job: the develop host's smoke failed after the alias moved, so the host is back on
# the build it served before. This pushes a branch reverting the commit that run deployed ($GITHUB_SHA)
# and opens a pull request for it, so the fix is one review away and main stops carrying the break.
#
# A pull request needs the repository setting "Allow GitHub Actions to create and approve pull requests".
# Without it, this opens an issue linking the branch instead. Either way a maintainer merges or closes
# it; nothing here merges. A pull request opened with this run's token starts no workflows, so its
# checks run once someone closes and reopens it, or pushes to it.
set -euo pipefail
sha=${GITHUB_SHA:?}
short=${sha:0:8}
branch="revert-develop-$short"
subject=$(git log -1 --format=%s "$sha")

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git revert --no-edit "$sha"
git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/$branch"

title="revert: $subject"
body=$(cat <<EOF
The develop host failed its smoke after it moved to $short, so deploy.yml moved it back to the build it served before ($RUN_URL).

This reverts $short. Read the smoke's failure in that run first: merge this if the commit is the cause, close it if not. Its checks start once it is closed and reopened, or pushed to.
EOF
)
if url=$(gh pr create --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --title "$title" --body "$body" 2>&1); then
	echo "opened $url" | tee -a "$GITHUB_STEP_SUMMARY"
	exit 0
fi
echo "::warning::could not open a pull request ($url); opening an issue instead"
compare="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/compare/main...$branch?expand=1"
issue=$(gh issue create --repo "$GITHUB_REPOSITORY" --title "develop broke at $short: revert ready" \
	--body "$body

Open the revert's pull request from $compare.")
echo "opened $issue" | tee -a "$GITHUB_STEP_SUMMARY"
