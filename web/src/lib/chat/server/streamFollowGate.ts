// stream-follow. The `stream-follow` flag decides whether a turn records its stream into
// `generation_events` and whether the follow route answers; with it off both do nothing and the app
// behaves as it did before. The flag is read once per turn on the writing side and once per request on
// the follow side, so a flip takes effect within the flag cache's minute.
import { flagEnabledOr } from "./flags";

export const STREAM_FOLLOW_FLAG = "stream-follow";

export function streamFollowEnabled(): boolean {
	return flagEnabledOr(STREAM_FOLLOW_FLAG, () => false);
}
