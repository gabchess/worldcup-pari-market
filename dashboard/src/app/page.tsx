import { redirect } from "next/navigation";

// ponytail: native Next.js redirect over duplicating /market's content; the
// market view is the only dashboard view in this repo, so / just forwards.
export default function Page() {
  redirect("/market");
}
