import { contrastRatio, WCAG_AA_TEXT } from "./portal";

export const TEMPLATES = ["moderno", "premium", "minimalista", "esportivo", "industrial", "elegante"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** Tokens fixos por modelo (fontes do sistema: sem requisições externas). `onPrimary` é o texto sobre a cor primária. */
export const TEMPLATE_TOKENS: Record<TemplateName, { bg: string; fg: string; muted: string; surface: string; font: string; radius: string; heading: string; weight: string }> = {
  moderno:     { bg: "#ffffff", fg: "#14213d", muted: "#495057", surface: "#f1f3f5", font: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif", radius: "12px", heading: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif", weight: "700" },
  premium:     { bg: "#0f1115", fg: "#f5f1e8", muted: "#c9c3b5", surface: "#1a1d24", font: "Georgia,'Times New Roman',serif", radius: "4px", heading: "Georgia,'Times New Roman',serif", weight: "600" },
  minimalista: { bg: "#ffffff", fg: "#111111", muted: "#4d4d4d", surface: "#f7f7f7", font: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif", radius: "0", heading: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif", weight: "500" },
  esportivo:   { bg: "#101010", fg: "#ffffff", muted: "#d0d0d0", surface: "#1e1e1e", font: "Impact,'Arial Black',system-ui,sans-serif", radius: "2px", heading: "Impact,'Arial Black',system-ui,sans-serif", weight: "800" },
  industrial:  { bg: "#e9ecef", fg: "#1b1f23", muted: "#40464d", surface: "#ffffff", font: "'Courier New',ui-monospace,monospace", radius: "0", heading: "'Arial Narrow',Arial,sans-serif", weight: "700" },
  elegante:    { bg: "#faf7f2", fg: "#2b2118", muted: "#5b4d40", surface: "#f0e9de", font: "Georgia,'Times New Roman',serif", radius: "8px", heading: "Georgia,'Times New Roman',serif", weight: "500" },
};

export interface SiteConfig {
  business: { name: string; tagline?: string; about?: string; phone?: string; whatsapp?: string; email?: string;
    address?: { street: string; city: string; state: string; zip?: string }; hours?: { days: string; open: string }[];
    instagram?: string; facebook?: string; mapUrl?: string };
  services: { title: string; description?: string; priceFrom?: string }[];
  gallery: { mediaId: string; alt: string }[];
  testimonials: { author: string; text: string }[];
  sections: { services: boolean; about: boolean; gallery: boolean; hours: boolean; testimonials: boolean };
  theme: { primaryColor: string; accentColor?: string };
  seo: { title?: string; description?: string };
  cta: { text: string };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** URLs externas aceitas: somente https, sem credenciais. Qualquer outro esquema (javascript:, data:, http:) é rejeitado. */
export function safeHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 300) return null;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null; } catch { return null; }
}
const digits = (s: string) => s.replace(/\D/g, "");

export function defaultSiteConfig(name: string): SiteConfig {
  return { business: { name }, services: [], gallery: [], testimonials: [], sections: { services: true, about: true, gallery: true, hours: true, testimonials: false },
    theme: { primaryColor: "#0b3d91" }, seo: {}, cta: { text: "Peça seu orçamento" } };
}

/** Valida o JSON do editor. Textos NÃO são HTML: são escapados no render; aqui só limites, tipos e URLs. */
export function validateSiteConfig(input: unknown, template: string): string[] {
  const e: string[] = []; const c = input as SiteConfig;
  const str = (v: unknown, max: number, path: string, req = false) => { if (v === undefined || v === null || v === "") { if (req) e.push(`${path} obrigatório`); return; } if (typeof v !== "string" || v.length > max) e.push(`${path} inválido (máx ${max})`); };
  if (!(TEMPLATES as readonly string[]).includes(template)) e.push("template inválido");
  if (!c || typeof c !== "object") return [...e, "config inválida"];
  const b = c.business ?? ({} as SiteConfig["business"]);
  str(b.name, 80, "business.name", true); str(b.tagline, 120, "business.tagline"); str(b.about, 1500, "business.about"); str(b.email, 120, "business.email");
  for (const [k, v] of [["phone", b.phone], ["whatsapp", b.whatsapp]] as const) if (v !== undefined && v !== "" && !/^\+?[0-9 ()-]{10,20}$/.test(String(v))) e.push(`business.${k} inválido`);
  for (const [k, v] of [["instagram", b.instagram], ["facebook", b.facebook], ["mapUrl", b.mapUrl]] as const) if (v !== undefined && v !== "" && !safeHttpsUrl(v)) e.push(`business.${k} deve ser URL https`);
  if (b.address) { str(b.address.street, 120, "address.street", true); str(b.address.city, 60, "address.city", true); if (!/^[A-Za-z]{2}$/.test(b.address.state ?? "")) e.push("address.state inválido"); str(b.address.zip, 12, "address.zip"); }
  if (b.hours && (!Array.isArray(b.hours) || b.hours.length > 8)) e.push("business.hours inválido"); else for (const h of b.hours ?? []) { str(h.days, 40, "hours.days", true); str(h.open, 40, "hours.open", true); }
  if (!Array.isArray(c.services) || c.services.length > 12) e.push("services inválido (máx 12)"); else for (const s of c.services) { str(s.title, 60, "service.title", true); str(s.description, 300, "service.description"); str(s.priceFrom, 30, "service.priceFrom"); }
  if (!Array.isArray(c.gallery) || c.gallery.length > 12) e.push("gallery inválido (máx 12)"); else for (const g of c.gallery) { if (!UUID.test(g.mediaId ?? "")) e.push("gallery.mediaId inválido"); str(g.alt, 120, "gallery.alt", true); }
  if (!Array.isArray(c.testimonials) || c.testimonials.length > 6) e.push("testimonials inválido (máx 6)"); else for (const t of c.testimonials) { str(t.author, 60, "testimonial.author", true); str(t.text, 400, "testimonial.text", true); }
  const s = c.sections; if (!s || (["services", "about", "gallery", "hours", "testimonials"] as const).some((k) => typeof s[k] !== "boolean")) e.push("sections inválido");
  if (!HEX.test(c.theme?.primaryColor ?? "")) e.push("theme.primaryColor inválida");
  else if (contrastRatio(c.theme.primaryColor, "#ffffff") < WCAG_AA_TEXT) e.push("theme.primaryColor sem contraste AA com texto branco (botões)");
  if (c.theme?.accentColor !== undefined) { if (!HEX.test(c.theme.accentColor)) e.push("theme.accentColor inválida"); else if (contrastRatio(c.theme.accentColor, "#ffffff") < WCAG_AA_TEXT) e.push("theme.accentColor sem contraste AA com texto branco"); }
  str(c.seo?.title, 70, "seo.title"); str(c.seo?.description, 160, "seo.description"); str(c.cta?.text, 40, "cta.text", true);
  return e;
}

/** Contraste texto/fundo de cada modelo (rodado em teste e antes de publicar). */
export function templateContrastErrors(t: TemplateName): string[] {
  const k = TEMPLATE_TOKENS[t]; const out: string[] = [];
  for (const [n, fg] of [["fg", k.fg], ["muted", k.muted]] as const) for (const [bn, bg] of [["bg", k.bg], ["surface", k.surface]] as const)
    if (contrastRatio(fg, bg) < WCAG_AA_TEXT) out.push(`${t}: ${n} sobre ${bn} abaixo de AA`);
  return out;
}

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|httpclient|go-http|scrapy|axios|node-fetch/i;
export const isBot = (ua: string | undefined) => !ua || ua.length < 10 || BOT_RE.test(ua);
/** Opt-out: Do Not Track e Global Privacy Control. */
export const optedOut = (h: { dnt?: string | null; gpc?: string | null }) => h.dnt === "1" || h.gpc === "1";
export function classifyReferrer(ref: string | undefined | null, ownHost: string): "direct" | "search" | "social" | "other" {
  if (!ref) return "direct";
  let host: string; try { host = new URL(ref).hostname.toLowerCase(); } catch { return "other"; }
  if (host === ownHost) return "direct";
  if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia)\./.test(host)) return "search";
  if (/(^|\.)(instagram|facebook|fb|t\.co|twitter|x|tiktok|youtube|linkedin|whatsapp|wa)\./.test(host + ".") || /(instagram|facebook|tiktok|youtube|linkedin|whatsapp)\.com$/.test(host)) return "social";
  return "other";
}
export const waLink = (whatsapp: string) => `https://wa.me/${digits(whatsapp).length <= 11 ? "55" + digits(whatsapp) : digits(whatsapp)}`;
export const LEAD_STATUSES = ["new", "contacted", "quoted", "scheduled", "won", "lost"] as const;
