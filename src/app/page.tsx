/**
 * TASK-301 — platform index: minimal salon list linking to /s/[slug]
 * (DESIGN §2.1). Server component, plain anchors, no client JS. Kept tiny
 * deliberately — the customer face is the salon landing (REQ-001).
 */
import { db } from "../db/client";
import { listSalons } from "../repos";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const salons = await listSalons(db);

  return (
    <main className="index-page">
      <h1>Find a salon</h1>
      {salons.length === 0 ? (
        <p className="empty-note">No salons yet — check back soon.</p>
      ) : (
        <ul className="index-list">
          {salons.map((salon) => (
            <li key={salon.id}>
              <a href={`/s/${salon.slug}`}>{salon.name}</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
