export function safeReturnTo(value: string | null, origin: string): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return "/account";
  try {
    const base = new URL(origin);
    if (!/^https?:$/.test(base.protocol)) return "/account";
    const target = new URL(value, base);
    if (target.origin !== base.origin || !/^https?:$/.test(target.protocol)) return "/account";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/account";
  }
}
