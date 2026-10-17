import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { appPath, site } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: site.title,
  description: site.description,
  alternates: { canonical: appPath("/") },
  robots: { index: site.indexable, follow: site.indexable },
  openGraph: { type: "website", url: appPath("/"), siteName: site.name, title: site.name, description: site.description },
  twitter: { card: "summary_large_image", title: site.name, description: site.description },
  appleWebApp: { capable: true, title: site.name, statusBarStyle: "black-translucent" },
  icons: { icon: appPath("/icons/icon-192.png"), apple: appPath("/icons/apple-touch-icon.png") },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // App-style layout: no pinch or double-tap zoom on phones.
  maximumScale: 1,
  userScalable: false,
  themeColor: "#1f4e8c",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        {process.env.VERCEL === "1" && <Analytics />}
      </body>
    </html>
  );
}
