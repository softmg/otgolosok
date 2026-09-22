import Link from "next/link";
import { BrandMark } from "../brand/brand-mark";
import "../ui/surfaces.css";

export function AppHeader() {
  return <header className="app-header"><Link href="/" aria-label="Отголосок, на главную"><BrandMark /></Link><span>Город говорит рядом</span></header>;
}
