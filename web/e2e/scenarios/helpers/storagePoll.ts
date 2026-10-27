// Every preview and develop deployment shares one Hugging Face storage token, capped at 3,000 Hub calls (CUR-3681)
// per 5 minutes. A storage poll left on toPass's default intervals retries about once a second, so a
// 30 s wait spends about 30 listings or uploads, and a poll that got a busy answer spends the most.
// Spec polls made most of preview's storage calls in the worst throttle hour.
// These intervals keep a
// 30 s poll to five calls.

/** toPass intervals for a poll that lists or writes the storage bucket. */
export const STORAGE_POLL_INTERVALS = [2_000, 5_000, 10_000];
