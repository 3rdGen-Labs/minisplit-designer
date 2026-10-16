import Designer from "@/components/Designer";
import { buildPalette } from "@/lib/engine";

export default function Home() {
  return <Designer palette={buildPalette()} />;
}
