import { Suspense } from "react";
import { WalkLibrary } from "@/features/walks/walk-library";

// WalkLibrary reads ?tab= with useSearchParams, which a static export renders on the client only.
export default function HistoryPage() {
  return <Suspense fallback={<main className="ui-page history-page"><p role="status">Открываем прогулки…</p></main>}><WalkLibrary /></Suspense>;
}
