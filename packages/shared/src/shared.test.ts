import { describe, expect, it } from "vitest";
import {
  canGrantRole,
  checkLimit,
  hasFeature,
  resolveEntitlements,
  resolvePermissions,
  validatePassword,
} from "./index";

const catalog = new Set(["a:read", "a:write", "b:read"]);

describe("permissões", () => {
  it("deny vence allow e override não cria permissão fora do catálogo", () => {
    const perms = resolvePermissions(
      ["a:read"],
      [
        { code: "a:write", effect: "allow" },
        { code: "a:read", effect: "deny" },
        { code: "x:root", effect: "allow" },
      ],
      catalog,
    );
    expect([...perms].sort()).toEqual(["a:write"]);
  });

  it("anti-escalada: só concede papel que seja subconjunto das próprias permissões", () => {
    expect(canGrantRole(new Set(["a:read", "b:read"]), ["a:read"])).toBe(true);
    expect(canGrantRole(new Set(["a:read"]), ["a:read", "a:write"])).toBe(false);
  });
});

describe("entitlements", () => {
  const base = { "units.max": 1, crm: false, "orders.monthly": null } as const;

  it("override do tenant prevalece sobre o plano", () => {
    const e = resolveEntitlements(base, { crm: true }, "active");
    expect(hasFeature(e, "crm")).toBe(true);
  });

  it("recurso ausente é negado (falha fechada)", () => {
    const e = resolveEntitlements(base, {}, "active");
    expect(hasFeature(e, "portal")).toBe(false);
    expect(checkLimit(e, "users.max", 0).ok).toBe(false);
  });

  it("limite numérico e ilimitado", () => {
    const e = resolveEntitlements(base, {}, "trial");
    expect(checkLimit(e, "units.max", 0).ok).toBe(true);
    expect(checkLimit(e, "units.max", 1)).toEqual({ ok: false, limit: 1 });
    expect(checkLimit(e, "orders.monthly", 10_000).ok).toBe(true);
  });

  it("assinatura suspensa/cancelada desliga tudo", () => {
    for (const s of ["suspended", "cancelled"] as const) {
      const e = resolveEntitlements({ crm: true, "units.max": 5 }, {}, s);
      expect(hasFeature(e, "crm")).toBe(false);
      expect(checkLimit(e, "units.max", 0).ok).toBe(false);
    }
  });
});

describe("senha", () => {
  it("aceita senha forte e rejeita problemas comuns", () => {
    expect(validatePassword("Tr0ca-Oleo!2026")).toBeNull();
    expect(validatePassword("curta1A!")).toBe("too_short");
    expect(validatePassword("password1234")).toBe("common");
    expect(validatePassword("Maria-Silva-2026!", "maria@x.com")).toBe("contains_email");
    expect(validatePassword("somenteminusculas")).toBe("low_variety");
    expect(validatePassword("uma frase bem longa e facil de lembrar")).toBeNull();
  });
});
