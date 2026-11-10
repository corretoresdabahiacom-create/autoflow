/** Blocos que o portal SEMPRE exibe: nenhum tema pode ocultá-los. */
export const MANDATORY_BLOCKS = ["orderInfo", "status", "estimate", "shopContact", "privacyNotice"] as const;
/** Blocos que a oficina pode ocultar. */
export const OPTIONAL_BLOCKS = ["photos", "chat", "timeline", "welcomeText"] as const;

export interface ThemeConfig {
  primaryColor: string; // #RRGGBB, usado como fundo de botões com texto branco
  accentColor?: string;
  welcomeText?: string;
  hidden: string[];
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Razão de contraste WCAG 2.x entre duas cores #RRGGBB. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export const WCAG_AA_TEXT = 4.5;

/** Valida o tema. Retorna lista de erros (vazia = ok). */
export function validateTheme(c: unknown): string[] {
  const errs: string[] = [];
  if (typeof c !== "object" || c === null) return ["config inválida"];
  const t = c as Record<string, unknown>;
  const allowed = new Set(["primaryColor", "accentColor", "welcomeText", "hidden"]);
  for (const k of Object.keys(t)) if (!allowed.has(k)) errs.push(`campo desconhecido: ${k}`);
  if (typeof t.primaryColor !== "string" || !HEX.test(t.primaryColor)) errs.push("primaryColor inválida");
  else if (contrastRatio(t.primaryColor, "#ffffff") < WCAG_AA_TEXT) errs.push("primaryColor sem contraste AA com texto branco");
  if (t.accentColor !== undefined) {
    if (typeof t.accentColor !== "string" || !HEX.test(t.accentColor)) errs.push("accentColor inválida");
    else if (contrastRatio(t.accentColor, "#ffffff") < WCAG_AA_TEXT) errs.push("accentColor sem contraste AA com texto branco");
  }
  if (t.welcomeText !== undefined && (typeof t.welcomeText !== "string" || t.welcomeText.length > 300)) errs.push("welcomeText inválido");
  if (!Array.isArray(t.hidden)) errs.push("hidden deve ser lista");
  else for (const h of t.hidden) {
    if ((MANDATORY_BLOCKS as readonly string[]).includes(h as string)) errs.push(`bloco obrigatório não pode ser ocultado: ${String(h)}`);
    else if (!(OPTIONAL_BLOCKS as readonly string[]).includes(h as string)) errs.push(`bloco desconhecido: ${String(h)}`);
  }
  return errs;
}

export const DEFAULT_THEME: ThemeConfig = { primaryColor: "#1f5fd1", hidden: [] };

/** Texto do portal: bloqueia dados de custo/margem por nome de campo (defesa em profundidade nos testes). */
export const FORBIDDEN_PORTAL_KEYS = /cost|custo|margin|margem|supplier|fornecedor|markup|lucro|profit/i;
