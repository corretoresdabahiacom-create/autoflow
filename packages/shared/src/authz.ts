export type PermissionEffect = "allow" | "deny";

export interface PermissionOverride {
  code: string;
  effect: PermissionEffect;
}

/**
 * Permissões efetivas = permissões do papel + overrides. `deny` sempre vence `allow`.
 * Override `allow` só vale para códigos conhecidos (catálogo), nunca cria permissão nova.
 */
export function resolvePermissions(
  rolePermissions: Iterable<string>,
  overrides: Iterable<PermissionOverride>,
  catalog: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>(rolePermissions);
  const denied = new Set<string>();
  for (const o of overrides) {
    if (!catalog.has(o.code)) continue;
    if (o.effect === "allow") result.add(o.code);
    else denied.add(o.code);
  }
  for (const code of denied) result.delete(code);
  return result;
}

export function hasPermission(perms: ReadonlySet<string>, code: string): boolean {
  return perms.has(code);
}

/** Anti-escalada: só é possível conceder um papel cujas permissões sejam subconjunto das suas. */
export function canGrantRole(actorPermissions: ReadonlySet<string>, targetRolePermissions: Iterable<string>): boolean {
  for (const p of targetRolePermissions) {
    if (!actorPermissions.has(p)) return false;
  }
  return true;
}
