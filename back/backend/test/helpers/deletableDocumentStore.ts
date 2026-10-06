import type { DeletableDocumentStore } from "../../src/persistence/documentStore";
import { MemoryDocumentStore } from "./formationFakes";

/**
 * The in-memory document store with `delete`, for tests of code that removes a customer's upload
 * and runs no command (a command opens a file store on disk itself). As on the file store, a
 * missing name is not an error.
 */
export class DeletableMemoryDocumentStore
  extends MemoryDocumentStore
  implements DeletableDocumentStore
{
  delete(name: string): void {
    this.files.delete(name);
  }
}
