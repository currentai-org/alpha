#!/usr/bin/env bash
# The run summary for a Grype JSON report, and the image gate. Used by the public repo's image workflow and
# by web-image.yml.
#
#   deploy/grype-summary.sh <report.json> <label> [--gate | --gate-ours]
#
# Counts every finding by severity, split by whether a fixed version exists (Grype's fix.state), so the
# summary shows what a self-hoster's own scan of the image will report, unfixed findings included. Then
# lists every high or critical finding with a fix, with the path it was found at (artifact.locations), so a
# red run names the file to change. With --gate it exits 1 when there is any such finding, or when the
# scan wrote no report: the scan itself never fails the build, this does.
#
# --gate-ours blocks only on findings in what the image adds (npm packages, Node, binaries), not in the
# Debian base image's own packages (Grype's artifact.type "deb"). Pull requests use it: a fix Debian
# publishes for a flaw already in the pinned base would otherwise turn every image-touching PR red, and
# no such PR can fix it. The base image moves by Dependabot's digest PRs, and a release publish gates on
# everything with --gate.
set -euo pipefail

usage="usage: grype-summary.sh <report.json> <label> [--gate | --gate-ours]"
report=${1:?$usage}
label=${2:?$usage}
gate=false
ours_only=false
case "${3:-}" in
"") ;;
--gate) gate=true ;;
--gate-ours) gate=true ours_only=true ;;
*) echo "$usage" >&2; exit 2 ;;
esac

echo "### Known vulnerabilities, $label (Grype)"
echo
if [ ! -s "$report" ]; then
	echo "The scan wrote no report, so nothing was counted."
	if $gate; then
		echo
		echo "Failing: an image that was not scanned is not handed on."
		exit 1
	fi
	exit 0
fi

jq -r '
	def row($name; $ms):
		[$ms[] | .vulnerability.severity] as $sev
		| "| \($name) | \([$sev[] | select(. == "Critical")] | length) | \([$sev[] | select(. == "High")] | length) | \([$sev[] | select(. == "Medium")] | length) | \([$sev[] | select(. == "Low")] | length) | \([$sev[] | select(. as $s | ["Critical","High","Medium","Low"] | index($s) | not)] | length) |";
	.matches as $all
	| "| | Critical | High | Medium | Low | Other |\n|---|---|---|---|---|---|",
	  row("All findings"; $all),
	  row("With a fix available"; [$all[] | select(.vulnerability.fix.state == "fixed")]),
	  row("No fix upstream yet"; [$all[] | select(.vulnerability.fix.state != "fixed")])' "$report"
echo
# $1: "ours" (not a Debian base package) or "base" (artifact.type deb).
fixable_in() {
	jq -r --arg where "$1" '[.matches[]
		| select(.vulnerability.severity == "Critical" or .vulnerability.severity == "High")
		| select(.vulnerability.fix.state == "fixed")
		| select((.artifact.type == "deb") == ($where == "base"))
		| "\(.artifact.type) \(.artifact.name) \(.artifact.version): \(.vulnerability.id) (\(.vulnerability.severity)), fixed in \((.vulnerability.fix.versions // []) | join(", ")), at \([.artifact.locations[]?.path] | join(" "))"]
		| unique | .[]' "$report"
}
fixable_ours=$(fixable_in ours)
fixable_base=$(fixable_in base)
for where in ours base; do
	if [ "$where" = ours ]; then
		echo "High and critical with a fix available, in what the image adds (type package version: vulnerability, fix, path):"
		list=$fixable_ours
	else
		echo "High and critical with a fix available, in the Debian base image's packages:"
		list=$fixable_base
	fi
	echo
	echo '```'
	if [ -z "$list" ]; then echo "none"; else printf '%s\n' "$list" | sed -n '1,60p'; fi
	echo '```'
	echo
done

echo
echo "High and critical with no fix upstream yet, by package (type, package version: count):"
echo
echo '```'
jq -r '[.matches[]
	| select(.vulnerability.severity == "Critical" or .vulnerability.severity == "High")
	| select(.vulnerability.fix.state != "fixed")
	| "\(.artifact.type) \(.artifact.name) \(.artifact.version)"]
	| group_by(.) | map("\(.[0]): \(length)") | sort
	| if length == 0 then ["none"] else .[:80] end | .[]' "$report"
echo '```'

if $ours_only; then
	fixable=$fixable_ours
	if [ -n "$fixable_base" ]; then
		echo
		echo "Not failing on the base image's $(printf '%s\n' "$fixable_base" | wc -l) fixable finding(s): this change did not bring them. Merge Dependabot's digest PR for the base image; a release publish fails on them."
	fi
else
	fixable=$(printf '%s\n%s' "$fixable_ours" "$fixable_base" | sed '/^$/d')
fi
if $gate && [ -n "$fixable" ]; then
	echo
	echo "Failing: $(printf '%s\n' "$fixable" | wc -l) high or critical finding(s) have a fixed version. Take it, or add the finding to .grype.yaml with why it does not apply."
	exit 1
fi
