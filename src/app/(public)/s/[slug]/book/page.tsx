/**
 * TASK-302 — /s/[slug]/book booking wizard page (DESIGN §2.1 S3; REQ-004).
 *
 * Server shell only: resolves the salon from the slug (unknown → notFound(),
 * decision 20) and passes the row's timezone into the client wizard as a prop
 * — slot times are rendered in the SALON's IANA zone, never hardcoded. The
 * wizard is the site's only client JS; the landing stays server-only.
 */
import { notFound } from "next/navigation";
import { db } from "../../../../../db/client";
import { findSalonBySlug } from "../../../../../repos";
import { BookingWizard } from "./wizard";

export const dynamic = "force-dynamic";

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const salon = await findSalonBySlug(db, slug);
  if (!salon) notFound();

  return (
    <main className="book-page">
      <BookingWizard slug={salon.slug} salonName={salon.name} timezone={salon.timezone} />
    </main>
  );
}
