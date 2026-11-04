/** Lo que escribe el usuario se busca literal, no como expresión regular. */
export function escapeRegex(value: string): string {
  return value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
