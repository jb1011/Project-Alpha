import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface PutResult {
  id: string; // == the file name (logical doc id)
  path: string; // absolute path on disk
  uri: string; // file:// URI used as metadataURI in v1
}

export interface DocumentStore {
  /** Text write. ATOMIC: a thin UTF-8 wrapper over `putBytes`, same tmp+fsync+rename ceremony. */
  put(name: string, contents: string): PutResult;
  get(id: string): string;
  /** Binary write (legal PDFs, canonical manifest bytes). ATOMIC — see the impl note. */
  putBytes(name: string, bytes: Buffer): PutResult;
  getBytes(id: string): Buffer;
}

/** Local-filesystem doc store. Interface allows S3 / Vercel Blob later (deferred). */
export class FileDocumentStore implements DocumentStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = isAbsolute(root) ? root : resolve(process.cwd(), root);
    mkdirSync(this.root, { recursive: true });
  }

  /** Resolve id under the doc root and reject any path that escapes it (traversal guard). */
  private safePath(id: string): string {
    const root = resolve(this.root);
    const p = resolve(join(root, id));
    if (p !== root && !p.startsWith(root + sep))
      throw new Error(`document id escapes the store root: ${id}`);
    return p;
  }

  /**
   * Text write — a UTF-8 wrapper over the ATOMIC byte path, deliberately.
   *
   * The old in-place `writeFileSync` was the torn-write hazard `putBytes` exists to avoid, and
   * "which artifacts get the ceremony" is not a distinction the store should be making: the
   * TERMS doc is hashed into the manifest, the manifest is hashed onto the chain, and the served
   * metadata is what a verifier reads. Every one of them is a document whose truncated form is
   * indistinguishable from its whole form until someone recomputes a hash and finds it wrong.
   * One code path, always atomic, so no future caller can pick the unsafe one by accident.
   */
  put(name: string, contents: string): PutResult {
    return this.putBytes(name, Buffer.from(contents, "utf8"));
  }

  get(id: string): string {
    return this.getBytes(id).toString("utf8");
  }

  /**
   * ATOMIC binary write: temp file in the SAME directory -> write -> fsync -> rename.
   *
   * Why the ceremony (audit M7): these bytes get HASHED, and the hash gets anchored on-chain
   * forever. A torn or truncated file whose hash is already anchored is a permanently
   * unverifiable anchor — there is no amendment path that can fix what the chain already
   * committed to. So:
   *  - same directory, because rename() is only atomic within one filesystem;
   *  - `wx` on the temp, so a colliding leftover is an ERROR rather than a silent overwrite of
   *    another writer's in-flight bytes;
   *  - fsync BEFORE rename, so a power loss can lose the whole file but never publish a
   *    half-written one under the real name (the DB runs synchronous=NORMAL for the same
   *    "re-derivable, never corrupt" reason);
   *  - rename, which replaces the target atomically on POSIX;
   *  - and the write itself LOOPS. `writeSync` is allowed to write fewer bytes than it was
   *    given (a large buffer, a signal, a full-ish pipe or disk), and its return value is the
   *    only thing that says so. A single unchecked call therefore fsync'd and published a
   *    SHORT file under the anchored name — the exact outcome the rest of this ceremony exists
   *    to prevent, reached through the front door.
   */
  putBytes(name: string, bytes: Buffer): PutResult {
    const path = this.safePath(name);
    // The temp name is derived from the target's own safe path, so it cannot escape the root
    // either, and it carries pid + a counter so two writers never pick the same one.
    const tmp = `${path}.tmp-${process.pid}-${nextTempSeq()}`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      // Write to completion: writeSync returns how many bytes it actually took.
      let written = 0;
      while (written < bytes.length) {
        const n = writeSync(fd, bytes, written, bytes.length - written);
        if (n <= 0)
          throw new Error(
            `document write stalled after ${written}/${bytes.length} bytes for ${name}`,
          );
        written += n;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch (e) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // already closed / never opened — the unlink below is what matters
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup: a leftover temp is inert (it is never read, and `wx` gives the
        // next writer a fresh name), so it must not mask the real failure below.
      }
      throw e;
    }
    return { id: name, path, uri: pathToFileURL(path).href };
  }

  getBytes(id: string): Buffer {
    return readFileSync(this.safePath(id));
  }
}

/** Monotonic per-process counter for temp-file names (two writes in the same millisecond). */
let tempSeq = 0;
function nextTempSeq(): number {
  tempSeq = (tempSeq + 1) % Number.MAX_SAFE_INTEGER;
  return tempSeq;
}
