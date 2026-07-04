import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface PutResult {
  id: string; // == the file name (logical doc id)
  path: string; // absolute path on disk
  uri: string; // file:// URI used as metadataURI in v1
}

export interface DocumentStore {
  put(name: string, contents: string): PutResult;
  get(id: string): string;
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

  put(name: string, contents: string): PutResult {
    const path = this.safePath(name);
    writeFileSync(path, contents, "utf8");
    return { id: name, path, uri: pathToFileURL(path).href };
  }

  get(id: string): string {
    return readFileSync(this.safePath(id), "utf8");
  }
}
