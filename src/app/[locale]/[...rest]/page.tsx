import { notFound } from "next/navigation";

/** Any URL that matches no route lands on the 404 page ([locale]/not-found.tsx). */
export default function CatchAllPage() {
  notFound();
}
