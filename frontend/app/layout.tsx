import type { Metadata } from "next";
import { Press_Start_2P, VT323 } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

const pixel = Press_Start_2P({ weight: "400", subsets: ["latin"], variable: "--font-press-start" });
const term = VT323({ weight: "400", subsets: ["latin"], variable: "--font-vt323" });

export const metadata: Metadata = {
  title: { default: "Doorway", template: "%s · Doorway" },
  description: "Doorway turns websites with no API into verified, self-healing MCP tools that agents call and pay for.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${pixel.variable} ${term.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <Nav />
        {children}
      </body>
    </html>
  );
}
