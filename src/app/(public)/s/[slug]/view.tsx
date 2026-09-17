/**
 * TASK-301 — SalonLandingView: SYNCHRONOUS presentational component for the
 * /s/[slug] landing (DESIGN §2.1; REQ-001).
 *
 * Render seam (tests/README.md decision 19): renderable via
 * react-dom/server renderToString OUTSIDE any Next request context —
 * therefore no next/link (plain <a href>), no client hooks, no context
 * reads. Format pins (decision 21): fi-FI EUR prices from integer cents;
 * English long weekday labels for the §3.5 working-hours union.
 */
import type { ReactElement } from "react";

export interface SalonLandingSalon {
  name: string;
  slug: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface SalonLandingService {
  name: string;
  priceCents: number;
  durationMinutes?: number;
}

export interface SalonLandingWorkingHour {
  isoWeekday: number;
  startMinute: number;
  endMinute: number;
}

export interface SalonLandingViewProps {
  salon: SalonLandingSalon;
  services: SalonLandingService[];
  workingHours: SalonLandingWorkingHour[];
}

const eur = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR" });
const weekday = new Intl.DateTimeFormat("en", { weekday: "long" });

/** 2024-01-01 is an ISO Monday — day-of-month == isoWeekday for Jan 1–7. */
const weekdayLabel = (isoWeekday: number): string =>
  weekday.format(new Date(Date.UTC(2024, 0, isoWeekday)));

const minuteLabel = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

interface DayWindow {
  isoWeekday: number;
  startMinute: number;
  endMinute: number;
}

/** §3.5 union across employees: per weekday, min-start/max-end summary. */
function unionByWeekday(hours: SalonLandingWorkingHour[]): DayWindow[] {
  const byDay = new Map<number, DayWindow>();
  for (const hour of hours) {
    const current = byDay.get(hour.isoWeekday);
    if (current) {
      current.startMinute = Math.min(current.startMinute, hour.startMinute);
      current.endMinute = Math.max(current.endMinute, hour.endMinute);
    } else {
      byDay.set(hour.isoWeekday, {
        isoWeekday: hour.isoWeekday,
        startMinute: hour.startMinute,
        endMinute: hour.endMinute,
      });
    }
  }
  return [...byDay.values()].sort((a, b) => a.isoWeekday - b.isoWeekday);
}

export function SalonLandingView({ salon, services, workingHours }: SalonLandingViewProps): ReactElement {
  const bookHref = `/s/${salon.slug}/book`;
  const days = unionByWeekday(workingHours);
  const hasContact = Boolean(salon.address ?? salon.phone ?? salon.email);

  return (
    <main className="salon-page">
      <header className="salon-header">
        <h1>{salon.name}</h1>
        {hasContact ? (
          <address className="salon-contact">
            {salon.address ? <span className="contact-line">{salon.address}</span> : null}
            {salon.phone ? (
              <a className="contact-line" href={`tel:${salon.phone}`}>
                {salon.phone}
              </a>
            ) : null}
            {salon.email ? (
              <a className="contact-line" href={`mailto:${salon.email}`}>
                {salon.email}
              </a>
            ) : null}
          </address>
        ) : null}
        <a className="cta" href={bookHref}>
          Book an appointment
        </a>
      </header>

      <section aria-labelledby="services-heading" className="salon-section">
        <h2 id="services-heading">Services</h2>
        {services.length === 0 ? (
          <p className="empty-note">No services published yet.</p>
        ) : (
          <ul className="service-list">
            {services.map((service) => (
              <li key={service.name}>
                <a className="service-row" href={bookHref}>
                  <span className="service-name">{service.name}</span>
                  {service.durationMinutes !== undefined ? (
                    <span className="service-duration">{service.durationMinutes} min</span>
                  ) : null}
                  <span className="service-price">{eur.format(service.priceCents / 100)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hours-heading" className="salon-section">
        <h2 id="hours-heading">Opening hours</h2>
        {days.length === 0 ? (
          <p className="empty-note">Opening hours not published yet.</p>
        ) : (
          <dl className="hours-list">
            {days.map((day) => (
              <div className="hours-row" key={day.isoWeekday}>
                <dt>{weekdayLabel(day.isoWeekday)}</dt>
                <dd>
                  {minuteLabel(day.startMinute)}–{minuteLabel(day.endMinute)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </main>
  );
}
