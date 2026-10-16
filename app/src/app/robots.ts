import type { MetadataRoute } from "next";
import { appPath, site } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  if (!site.indexable) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/", disallow: appPath("/api/") },
    sitemap: new URL(appPath("/sitemap.xml"), site.url).toString(),
  };
}
