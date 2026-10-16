import type { MetadataRoute } from "next";
import { appPath, site } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: site.name,
    short_name: site.name,
    description: "Ductless system design and estimating",
    start_url: appPath("/"),
    scope: appPath("/"),
    display: "standalone",
    orientation: "any",
    background_color: "#c9d3df",
    theme_color: "#1f4e8c",
    icons: [
      { src: appPath("/icons/icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: appPath("/icons/icon-512.png"), sizes: "512x512", type: "image/png" },
      { src: appPath("/icons/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
