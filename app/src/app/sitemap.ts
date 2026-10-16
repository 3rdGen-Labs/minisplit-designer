import type { MetadataRoute } from "next";
import { appPath, site } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  if (!site.indexable) return [];
  return [{ url: new URL(appPath("/"), site.url).toString(), changeFrequency: "monthly", priority: 1 }];
}
