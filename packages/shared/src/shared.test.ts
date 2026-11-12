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

import { DEFAULT_THEME, MANDATORY_BLOCKS, contrastRatio, validateTheme } from "./portal";
describe("portal theme", () => {
  it("contraste WCAG", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrastRatio("#1f5fd1", "#ffffff")).toBeGreaterThan(4.5);
  });
  it("tema padrão é válido; ocultar obrigatório ou cor fraca é recusado", () => {
    expect(validateTheme(DEFAULT_THEME)).toEqual([]);
    for (const b of MANDATORY_BLOCKS) expect(validateTheme({ ...DEFAULT_THEME, hidden: [b] }).length).toBeGreaterThan(0);
    expect(validateTheme({ ...DEFAULT_THEME, primaryColor: "#ffff00" }).length).toBeGreaterThan(0);
    expect(validateTheme({ ...DEFAULT_THEME, hidden: ["photos", "chat"] })).toEqual([]);
    expect(validateTheme({ ...DEFAULT_THEME, extra: 1 }).length).toBeGreaterThan(0);
  });
});

import { allocateProRata, buildDre, discountNeedsOverride, installmentStatus, lateCharges, overheadForOrder, splitCents } from "./finance";
describe("finance", () => {
  it("splitCents: resto na última parcela, Σ preservada", () => {
    expect(splitCents(10000, 3)).toEqual([3333, 3333, 3334]);
    for (const [t, n] of [[1, 3], [99999, 7], [0, 2], [100, 100]] as const) expect(splitCents(t, n).reduce((a, b) => a + b, 0)).toBe(t);
  });
  it("allocateProRata: sem perda de centavos e proporcional", () => {
    expect(allocateProRata(100, [1, 1, 1])).toEqual([34, 33, 33]);
    for (let t = 0; t < 300; t += 7) expect(allocateProRata(t, [3, 5, 11, 1]).reduce((a, b) => a + b, 0)).toBe(t);
    expect(allocateProRata(1000, [70, 30])).toEqual([700, 300]);
  });
  it("juros e multa: 2% multa + 1% a.m. pro rata, sem atraso = 0, HALF_EVEN", () => {
    expect(lateCharges({ principalCents: 10000, dueDate: "2030-01-10", on: "2030-01-10", fineBp: 200, interestBpMonth: 100 })).toMatchObject({ days: 0, fineCents: 0, interestCents: 0 });
    expect(lateCharges({ principalCents: 10000, dueDate: "2030-01-10", on: "2030-02-09", fineBp: 200, interestBpMonth: 100 })).toMatchObject({ days: 30, fineCents: 200, interestCents: 100 });
    expect(lateCharges({ principalCents: 150, dueDate: "2030-01-01", on: "2030-01-02", fineBp: 100, interestBpMonth: 100 }).fineCents).toBe(2); // 1,5 → 2 (par)
    expect(lateCharges({ principalCents: 250, dueDate: "2030-01-01", on: "2030-01-02", fineBp: 100, interestBpMonth: 0 }).fineCents).toBe(2); // 2,5 → 2 (par)
  });
  it("status derivado", () => {
    const b = { amountCents: 100, dueDate: "2030-01-10", cancelled: false };
    expect(installmentStatus({ ...b, paidCents: 0, today: "2030-01-05" })).toBe("open");
    expect(installmentStatus({ ...b, paidCents: 40, today: "2030-01-05" })).toBe("partial");
    expect(installmentStatus({ ...b, paidCents: 40, today: "2030-01-11" })).toBe("overdue");
    expect(installmentStatus({ ...b, paidCents: 100, today: "2030-01-11" })).toBe("paid");
    expect(installmentStatus({ ...b, paidCents: 0, today: "2030-01-05", cancelled: true })).toBe("cancelled");
  });
  it("alçada de desconto", () => {
    expect(discountNeedsOverride(10000, 500, 500)).toBe(false);
    expect(discountNeedsOverride(10000, 501, 500)).toBe(true);
  });
  it("DRE e rateio", () => {
    const d = buildDre({ revenue: 10000, deductions: 500, directCosts: 3000, opex: 2000, financial: 100 });
    expect(d).toMatchObject({ netRevenue: 9500, contributionMargin: 6500, operatingResult: 4500, managementResult: 4600, label: "gerencial estimado" });
    expect(overheadForOrder({ method: "revenue", value: 1000 }, { netRevenueCents: 9500, trackedMinutes: 0 })).toBe(950);
    expect(overheadForOrder({ method: "hours", value: 3000 }, { netRevenueCents: 0, trackedMinutes: 90 })).toBe(4500);
    expect(overheadForOrder({ method: "fixed", value: 700 }, { netRevenueCents: 0, trackedMinutes: 0 })).toBe(700);
  });
});

import { TEMPLATES, classifyReferrer, defaultSiteConfig, isBot, optedOut, safeHttpsUrl, templateContrastErrors, validateSiteConfig, waLink } from "./site";
describe("site", () => {
  it("todos os modelos passam em contraste AA texto/fundo", () => { for (const t of TEMPLATES) expect(templateContrastErrors(t)).toEqual([]); });
  it("config padrão é válida; cor sem contraste, javascript: e http: são rejeitados", () => {
    const c = defaultSiteConfig("Oficina Teste");
    expect(validateSiteConfig(c, "moderno")).toEqual([]);
    expect(validateSiteConfig({ ...c, theme: { primaryColor: "#ffff00" } }, "moderno").join()).toMatch(/contraste/);
    expect(validateSiteConfig({ ...c, business: { ...c.business, instagram: "javascript:alert(1)" } }, "moderno").join()).toMatch(/https/);
    expect(validateSiteConfig({ ...c, business: { ...c.business, mapUrl: "http://x.test" } }, "moderno").join()).toMatch(/https/);
    expect(validateSiteConfig(c, "outro").join()).toMatch(/template/);
    expect(safeHttpsUrl("https://user:pw@x.test")).toBeNull(); expect(safeHttpsUrl("data:text/html,x")).toBeNull(); expect(safeHttpsUrl("https://x.test/a")).toBe("https://x.test/a");
  });
  it("bots, opt-out, referrer, whatsapp", () => {
    expect(isBot("Googlebot/2.1")).toBe(true); expect(isBot(undefined)).toBe(true); expect(isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1")).toBe(false);
    expect(optedOut({ dnt: "1" })).toBe(true); expect(optedOut({ gpc: "1" })).toBe(true); expect(optedOut({ dnt: "0" })).toBe(false);
    expect(classifyReferrer(undefined, "a.test")).toBe("direct"); expect(classifyReferrer("https://www.google.com/search?q=x", "a.test")).toBe("search"); expect(classifyReferrer("https://l.instagram.com/?u=x", "a.test")).toBe("social"); expect(classifyReferrer("https://blog.test/p", "a.test")).toBe("other");
    expect(waLink("(71) 99999-1234")).toBe("https://wa.me/5571999991234");
  });
});

import { applyIn, applyOut, outCost, returnCost, avgUnitCostCents, parseQtyMilli, loyaltyPoints, couponDiscount, addDays } from "./stock";
describe("estoque: custo médio móvel", () => {
  it("entradas, saídas, devolução e saída total sem resíduo", () => {
    let s = { onHandMilli: 0, valueCents: 0 };
    s = applyIn(s, 10_000, 10_000); // 10 un a R$ 10,00
    s = applyIn(s, 10_000, 14_000); // 10 un a R$ 14,00 => médio R$ 12,00
    expect(avgUnitCostCents(s)).toBe(1200);
    const o = applyOut(s, 5_000); expect(o.costCents).toBe(6000); s = o.state; expect(s).toEqual({ onHandMilli: 15_000, valueCents: 18_000 });
    expect(returnCost(5_000, 6000, 2_000)).toBe(2400);
    s = applyIn(s, 2_000, 2400); expect(avgUnitCostCents(s)).toBe(1200);
    const all = applyOut(s, 17_000); expect(all.state).toEqual({ onHandMilli: 0, valueCents: 0 }); expect(all.costCents).toBe(20_400);
  });
  it("arredondamento, limites e validações", () => {
    expect(outCost({ onHandMilli: 3000, valueCents: 100 }, 1000)).toBe(33);
    expect(outCost({ onHandMilli: 3000, valueCents: 200 }, 1000)).toBe(67);
    expect(() => outCost({ onHandMilli: 1000, valueCents: 100 }, 2000)).toThrow("insufficient_stock");
    expect(() => outCost({ onHandMilli: 1000, valueCents: 100 }, 0)).toThrow();
    expect(() => returnCost(1000, 100, 2000)).toThrow();
    expect(parseQtyMilli(1.25)).toBe(1250); expect(() => parseQtyMilli(0.0001)).toThrow(); expect(() => parseQtyMilli(-1)).toThrow();
  });
  it("pontos, cupom e datas", () => {
    expect(loyaltyPoints(12_345, 1)).toBe(123); expect(loyaltyPoints(-5, 2)).toBe(0);
    expect(couponDiscount("percent", 10, 15_000)).toBe(1500); expect(couponDiscount("fixed", 99_999, 15_000)).toBe(15_000);
    expect(addDays("2026-12-20", 15)).toBe("2027-01-04");
  });
});
