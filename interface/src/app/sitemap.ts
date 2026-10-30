import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const PATHS = ["", "/privacy", "/terms", "/brand", "/personhood"];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PATHS.map((path) => ({
    url: `${SITE_URL}${path || "/"}`,
    lastModified,
  }));
}
