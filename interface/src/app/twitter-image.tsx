import { shareImage } from "@/lib/shareImage";

export const alt = "Novi Corpus: A company for your agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return shareImage();
}
