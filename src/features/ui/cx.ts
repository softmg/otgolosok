/** Joins class names, skipping empty and false values: cx(styles.card, open && styles.open). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
