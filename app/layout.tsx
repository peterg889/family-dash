import type { Metadata, Viewport } from "next";
import { Saira_Condensed, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";

// Condensed signage face for station names — the lettering of a terminal
// departure board. Tabular mono carries every time and countdown.
const signage = Saira_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-signage",
  display: "swap",
});

const mono = Spline_Sans_Mono({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Next Trains",
  description: "Next trains to New York and Hoboken from Morristown & Bernardsville",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${signage.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
