/** Build-time prefix for both server routes and plain HTML asset URLs. */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const appPath = (path: string) => `${basePath}${path}`;

/** Edit this file to rebrand your deployment. Local logo paths are relative to public/. */
export const site = {
  name: "Mini-Split Designer",
  version: "v1",
  /** Shown under the name in the header. Set to "" to hide. */
  tagline: "System builder for residential Mitsubishi Electric model numbers",
  /** Public URL of this deployment: canonical links, sitemap and social previews. */
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://designer.3rdgen.io",
  /** Let search engines index this deployment. Turn off for private or staging copies. */
  indexable: true,
  /** Browser tab and search result title. */
  title: "Mini-Split Designer: Free Mitsubishi Electric Ductless System Builder",
  description: "Free browser-based builder for residential Mitsubishi Electric ductless systems: pick outdoor and indoor units, check compatibility, line sets, controls and accessories, and export a bill of materials.",
  owner: "3rdGen Labs",
  /** Source repository: header GitHub link and the footer "Report a problem" link. Set to "" to hide both. */
  repo: "https://github.com/3rdGen-Labs/minisplit-designer",
  mcp: {
    /** Appended to every evaluate_design result after the verification notice. Set to "" to remove. */
    note: "Need it installed in the San Francisco Bay Area? 3rdGen Building Systems: https://3rdgen.io/?utm_source=designer&utm_medium=mcp",
  },
  header: {
    enabled: false,
    name: "3rdGen Labs",
    url: "https://3rdgenlabs.com",
    logo: "/brand/3rdgen-labs-logo.png",
  },
  business: {
    enabled: true,
    name: "3rdGen Building Systems",
    logo: "/brand/3rdgen-building-systems-logo.svg",
    description: "Heating, cooling, and mechanical systems for Bay Area homes and businesses.",
    url: "https://3rdgen.io/?utm_source=designer&utm_medium=referral&utm_campaign=installation",
    linkLabel: "Visit 3rdGen",
  },
  credits: {
    enabled: true,
    url: "https://3rdgenlabs.com",
    secondaryEnabled: true,
    secondaryLabel: "Hecho con",
    secondaryName: "Criterio",
    secondaryUrl: "https://hechoconcriterio.com",
  },
};
