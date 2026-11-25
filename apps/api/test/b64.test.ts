import { describe, expect, it } from "vitest";
import { fromB64, fromB64Url } from "../src/crypto";

describe("base64 tolerante", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
  const std = Buffer.from(bytes).toString("base64");
  it("aceita padrão com '=', com quebra de linha (PowerShell), sem padding e url-safe", () => {
    for (const v of [std, `${std}\r\n`, ` ${std}\n`, std.replace(/=+$/, "")]) expect([...fromB64(v)]).toEqual([...bytes]);
    expect([...fromB64Url(Buffer.from(bytes).toString("base64url"))]).toEqual([...bytes]);
  });
  it("continua rejeitando lixo", () => { expect(() => fromB64("@@@@")).toThrow(); });
});
