import type { Metadata } from "next";
import { AppNavigation } from "@/features/navigation/app-navigation";
import "./globals.css";

export const metadata: Metadata = {
  icons: { icon: "/icon.svg" },
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru">
      <body>{children}<AppNavigation /></body>
    </html>
  );
}
