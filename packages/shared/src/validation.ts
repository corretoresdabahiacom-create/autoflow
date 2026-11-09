const COMMON_PASSWORDS = new Set([
  "password1234", "123456789012", "qwertyuiop12", "senha1234567", "admin1234567",
  "autoflow12345", "mudar123456", "abcdefgh1234", "111111111111", "letmein12345",
]);

export type PasswordProblem = "too_short" | "too_long" | "common" | "contains_email" | "low_variety";

/** Política: 12–128 caracteres, não comum, não contém o e-mail, e ao menos 3 classes ou frase longa. */
export function validatePassword(password: string, email?: string): PasswordProblem | null {
  if (password.length < 12) return "too_short";
  if (password.length > 128) return "too_long";
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "common";
  if (email) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) return "contains_email";
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3 && password.length < 20) return "low_variety";
  return null;
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const UNIT_CODE_PATTERN = /^[A-Z0-9-]{1,12}$/;
