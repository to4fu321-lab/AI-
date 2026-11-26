import type { Metadata, Viewport } from "next";
import { AuthorizeApp } from "@/components/migrate/AuthorizeApp";

export const metadata: Metadata = {
  title: "AI 秘書をつなぐ許可 | アカウント引っ越し",
  robots: { index: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function AuthorizePage() {
  return <AuthorizeApp />;
}
