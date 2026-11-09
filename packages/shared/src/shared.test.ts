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

import { computeEffectiveStatuses, canExecuteItem, diffVersions, inheritsApproval, itemHash, lineTotalCents, normalizePhoneBR, normalizePlate } from "./estimates";

describe("estimates (regras puras)", () => {
  const base = { description: "Troca de óleo", category: "service" as const, qty: 1, unitPriceCents: 15000 };
  it("hash muda com qtd, preço, escopo e categoria; ignora espaços extras", () => {
    const h = itemHash(base);
    expect(itemHash({ ...base, description: "  Troca   de óleo " })).toBe(h);
    expect(itemHash({ ...base, qty: 2 })).not.toBe(h);
    expect(itemHash({ ...base, unitPriceCents: 15001 })).not.toBe(h);
    expect(itemHash({ ...base, description: "Troca de óleo e filtro" })).not.toBe(h);
    expect(itemHash({ ...base, category: "part" })).not.toBe(h);
  });
  it("total da linha em inteiros", () => {
    expect(lineTotalCents(1.5, 1999)).toBe(2999); // 2998,5 → 2999
    expect(lineTotalCents(3, 3333)).toBe(9999);
  });
  it("placa e telefone", () => {
    expect(normalizePlate("abc-1d23")).toBe("ABC1D23");
    expect(normalizePlate("ABC-1234")).toBe("ABC1234");
    expect(normalizePlate("12")).toBeNull();
    expect(normalizePhoneBR("(71) 99999-1234")).toBe("+5571999991234");
    expect(normalizePhoneBR("123")).toBeNull();
  });
  it("diff e herança", () => {
    const mk = (k: string, over = {}) => { const c = { ...base, ...over }; return { ...c, lineKey: k, hash: itemHash(c) }; };
    const v1 = [mk("a"), mk("b"), mk("c")];
    const v2 = [mk("a"), mk("b", { qty: 2 }), mk("d")];
    const d = diffVersions(v1, v2);
    expect(d.unchanged).toEqual(["a"]);
    expect(d.changed.map((c) => c.lineKey)).toEqual(["b"]);
    expect(d.changed[0]!.changes.map((c) => c.field)).toEqual(["qty"]);
    expect(d.added.map((i) => i.lineKey)).toEqual(["d"]);
    expect(d.removed.map((i) => i.lineKey)).toEqual(["c"]);
    expect(inheritsApproval(v2[0]!, v1)).toBe(true);
    expect(inheritsApproval(v2[1]!, v1)).toBe(false);
    expect(inheritsApproval(v2[2]!, v1)).toBe(false);
  });
  it("execução exige aprovação e versão vigente", () => {
    expect(canExecuteItem("approved", true).allowed).toBe(true);
    expect(canExecuteItem("approved_inherited", true).allowed).toBe(true);
    expect(canExecuteItem("pending", true)).toEqual({ allowed: false, reason: "not_approved" });
    expect(canExecuteItem("rejected", true).allowed).toBe(false);
    expect(canExecuteItem("approved", false).reason).toBe("not_in_current_version");
  });
});

describe("computeEffectiveStatuses", () => {
  const mk = (id: string, lineKey: string, hash: string, ownDecision: "approved" | "rejected" | null = null) => ({ id, lineKey, hash, ownDecision });
  it("herda só se hash idêntico e só da versão imediatamente anterior", () => {
    const st = computeEffectiveStatuses([
      { versionNo: 1, items: [mk("1a", "a", "h1", "approved"), mk("1b", "b", "h2", "approved"), mk("1c", "c", "h3", "rejected")] },
      { versionNo: 2, items: [mk("2a", "a", "h1"), mk("2b", "b", "h2x"), mk("2c", "c", "h3")] },
      { versionNo: 3, items: [mk("3a", "a", "h1"), mk("3b", "b", "h2")] },
    ]);
    expect(st.get("1a")).toBe("approved");
    expect(st.get("2a")).toBe("approved_inherited");
    expect(st.get("2b")).toBe("pending"); // mudou
    expect(st.get("2c")).toBe("pending"); // recusa não herda
    expect(st.get("3a")).toBe("approved_inherited"); // cadeia 1→2→3
    expect(st.get("3b")).toBe("pending"); // v2 mudou; voltar ao hash antigo não ressuscita aprovação
  });
});
