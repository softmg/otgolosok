import Link from "next/link";
import { BrandMark } from "../brand/brand-mark";
import styles from "./map-brand.module.css";

/** The brand in the header island of every map screen, leading back to the start. */
export function MapBrand({ onClick }: { onClick?: () => void }) {
  return <Link href="/" prefetch={false} className={styles.brand} aria-label="Отголосок, на главную" onClick={onClick}><BrandMark className={styles.mark} /></Link>;
}
