import Link from "next/link";
import { BrandMark } from "../brand/brand-mark";

export function AppHeader() {
  return <header className="app-header"><Link href="/" aria-label="Отголосок, на главную"><BrandMark /></Link><span>Город говорит рядом</span></header>;
}
