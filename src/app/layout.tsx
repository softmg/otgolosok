import type { Metadata, Viewport } from "next";
import { AppNavigation } from "@/features/navigation/app-navigation";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/ui.css";
import "@/styles/legacy.css";

export const metadata: Metadata = {
  // iOS ignores SVG touch icons (scripts/build-app-icons.mjs).
  icons: { icon: "/icon.svg", apple: "/icons/apple-touch-icon.png" },
  title: "Отголосок — город говорит рядом",
  description:
    "Аудиопрогулки по Москве, которые начинаются там, где случилась история.",
  applicationName: "Отголосок",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Отголосок",
  },
  formatDetection: { telephone: false },
};

// The page draws under notches and the home indicator; safe-area tokens keep content clear of them.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru">
      <body>{children}<AppNavigation /></body>
    </html>
  );
}
