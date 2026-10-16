/** Build-time prefix for both server routes and plain HTML asset URLs. */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const appPath = (path: string) => `${basePath}${path}`;

/** Edit this file to rebrand your deployment. Local logo paths are relative to public/. */
export const site = {
  name: "Mini-Split Designer",
  version: "v1",
  owner: "3rdGen Labs",
  header: {
    enabled: true,
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
