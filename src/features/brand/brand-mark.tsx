import { cx } from "../ui/cx";

export function BrandMark({ className }: { className?: string }) {
  return <span className={cx("brand-mark", className)}>Отголосок<span aria-hidden="true">.</span></span>;
}
