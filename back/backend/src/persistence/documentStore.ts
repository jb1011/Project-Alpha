import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

  put(name: string, contents: string): PutResult {
    const path = join(this.root, name);
    writeFileSync(path, contents, "utf8");
    return { id: name, path, uri: pathToFileURL(path).href };
  }

  get(id: string): string {
    return readFileSync(join(this.root, id), "utf8");
  }
}
