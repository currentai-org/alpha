// Free of imports on purpose. The chunk store (server/db/uploadChunks.ts) reads these, and
// the cleanup cron that sweeps it also runs under tsx in scripts/verify-cleanup.ts, outside Vite. (CUR-1780)
/** With the `chunked-uploads` flag on, a file may arrive in chunks and this ceiling, the
 * design's 20 MB, applies instead. Each chunk request stays under Vercel's body cap and the server
 * checks the reassembled file whole, so policy sets this number. */
export const CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE = 20_000_000;

/** Raw bytes per chunk. The multipart envelope around it adds well under 1 KB, so a chunk request
 * stays below the 4.5 MB body cap with room to spare. */
export const CUSTODIAL_UPLOAD_CHUNK_BYTES = 4_000_000;

