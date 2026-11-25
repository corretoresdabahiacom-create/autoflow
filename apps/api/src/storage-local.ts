import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageProvider } from "./storage";

/** Dev local: disco fora do repositório. Produção usará R2 privado (KI-015: não implementado/validado). */
export class LocalDiskStorage implements StorageProvider {
  constructor(private readonly root: string) {}
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("chave inválida");
    return full;
  }
  async put(key: string, bytes: Uint8Array) {
    const f = this.resolve(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, bytes);
  }
  async get(key: string) {
    try { return new Uint8Array(await readFile(this.resolve(key))); } catch { return null; }
  }
}
