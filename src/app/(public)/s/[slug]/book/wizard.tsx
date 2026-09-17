"use client";

/**
 * TASK-302 — booking wizard client component (DESIGN §2.1 S3; REQ-004).
 *
 * Multi-step flow: (1) service → (2) stylist (optional "first available") →
 * (3) native date picker (today..+30d, salon-local) + slot list → (4) contact
 * form → on-screen confirmation with booking reference. fetch only, no
 * external state libs; the only client JS on the site.
 *
 * Timezone: slot starts arrive UTC ISO and are formatted with
 * Intl.DateTimeFormat("fi-FI", { timeZone }) where timeZone is the SALON's
 * IANA zone passed from the server page (salons.timezone) — never hardcoded.
 *
 * Errors (server is the authority; client validation is UX only):
 * 409 STALE_SLOT/SLOT_OCCUPIED → "just taken" + reload slots; 422
 * GAP_FRAGMENT → adjacent time / other day hint; 422 VALIDATION → server
 * issue messages surfaced; 404 → restart. Steps use fieldsets/legends and
 * type="button" navigation; the final step is the only <form> submit.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";

export interface BookingWizardProps {
  slug: string;
  salonName: string;
  timezone: string;
}

interface ServiceDto {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

interface EmployeeDto {
  id: string;
  displayName: string;
  title: string | null;
}

interface SlotDto {
  startUtc: string;
  endUtc: string;
  employeeId: string;
  localDate: string;
}

interface SlotsBody {
  slots: SlotDto[];
}

/** Union of every error body the public routes can emit (§7, §14.6). */
interface ErrorBody {
  code?: string;
  error?: string;
  fragmentMinutes?: number;
  issues?: Array<{ message: string }>;
}

interface Confirmation {
  bookingId: string;
  serviceName: string;
  stylistName: string;
  startsAt: string;
}

interface SubmitError {
  message: string;
  action: "reload-slots" | "restart" | "none";
}

const eur = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR" });

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; body: T | null }> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, ok: res.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

/** Salon-local calendar date (YYYY-MM-DD) offset by whole days. */
function localDate(timeZone: string, dayOffset: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + dayOffset * 86_400_000));
}

export function BookingWizard({ slug, salonName, timezone }: BookingWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [services, setServices] = useState<ServiceDto[] | null>(null);
  const [servicesError, setServicesError] = useState(false);
  const [employees, setEmployees] = useState<EmployeeDto[] | null>(null);
  const [employeesError, setEmployeesError] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const [employeeId, setEmployeeId] = useState(""); // "" = first available
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<SlotDto[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(false);
  const [slotsNonce, setSlotsNonce] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<SlotDto | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat("fi-FI", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }),
    [timezone],
  );
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("fi-FI", {
        timeZone: timezone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    [timezone],
  );
  const minDate = useMemo(() => localDate(timezone, 0), [timezone]);
  const maxDate = useMemo(() => localDate(timezone, 30), [timezone]);

  useEffect(() => {
    let active = true;
    fetchJson<ServiceDto[]>(`/api/public/salons/${slug}/services`).then((res) => {
      if (!active) return;
      if (res.ok && res.body) {
        setServices(res.body);
        setServicesError(false);
      } else {
        setServicesError(true);
      }
    });
    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    let active = true;
    fetchJson<EmployeeDto[]>(`/api/public/salons/${slug}/employees`).then((res) => {
      if (!active) return;
      if (res.ok && res.body) {
        setEmployees(res.body);
        setEmployeesError(false);
      } else {
        setEmployeesError(true);
      }
    });
    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    if (step !== 3 || !serviceId || !date) return;
    let active = true;
    setSlotsLoading(true);
    setSlotsError(false);
    const sp = new URLSearchParams({ serviceId, fromDate: date, toDate: date });
    if (employeeId) sp.set("employeeId", employeeId);
    fetchJson<SlotsBody>(`/api/public/salons/${slug}/slots?${sp}`).then((res) => {
      if (!active) return;
      if (res.ok && res.body) {
        setSlots(res.body.slots);
        setSlotsError(false);
      } else {
        setSlotsError(true);
      }
      setSlotsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [step, serviceId, employeeId, date, slug, slotsNonce]);

  // With "first available" the engine unions employees — collapse duplicate
  // start times so each open time is offered once (slot keeps its concrete
  // employeeId, which is what gets submitted).
  const visibleSlots = useMemo(() => {
    if (!slots) return [];
    if (employeeId !== "") return slots;
    const seen = new Set<string>();
    const out: SlotDto[] = [];
    for (const slot of slots) {
      if (seen.has(slot.startUtc)) continue;
      seen.add(slot.startUtc);
      out.push(slot);
    }
    return out;
  }, [slots, employeeId]);

  const groupedSlots = useMemo(() => {
    const byDate = new Map<string, SlotDto[]>();
    for (const slot of visibleSlots) {
      const list = byDate.get(slot.localDate);
      if (list) list.push(slot);
      else byDate.set(slot.localDate, [slot]);
    }
    return [...byDate.entries()];
  }, [visibleSlots]);

  const chosenService = services?.find((service) => service.id === serviceId) ?? null;
  const chosenEmployee = employees?.find((employee) => employee.id === employeeId) ?? null;

  function resetAll(): void {
    setStep(1);
    setServiceId("");
    setEmployeeId("");
    setDate("");
    setSlots(null);
    setSelectedSlot(null);
    setContactError(null);
    setSubmitError(null);
  }

  function backToSlots(): void {
    setSubmitError(null);
    setSelectedSlot(null);
    setStep(3);
    setSlotsNonce((n) => n + 1);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedSlot || !chosenService) return;
    const nameValue = name.trim();
    const phoneValue = phone.trim();
    const emailValue = email.trim();
    if (nameValue === "") {
      setContactError("Please enter your name.");
      return;
    }
    if (phoneValue === "" && emailValue === "") {
      setContactError("Please provide a phone number or an email address.");
      return;
    }
    const customer: { name: string; phone?: string; email?: string } = { name: nameValue };
    if (phoneValue !== "") customer.phone = phoneValue;
    if (emailValue !== "") customer.email = emailValue;

    setContactError(null);
    setSubmitError(null);
    setSubmitting(true);
    const res = await fetchJson<{ bookingId?: string } & ErrorBody>(`/api/public/salons/${slug}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId,
        employeeId: selectedSlot.employeeId,
        startsAt: selectedSlot.startUtc,
        customer,
      }),
    });
    setSubmitting(false);

    if (res.status === 201 && res.body?.bookingId) {
      const stylistName =
        employees?.find((employee) => employee.id === selectedSlot.employeeId)?.displayName ??
        "First available";
      setConfirmation({
        bookingId: res.body.bookingId,
        serviceName: chosenService.name,
        stylistName,
        startsAt: selectedSlot.startUtc,
      });
      return;
    }

    const body = res.body;
    if (res.status === 409 && (body?.code === "STALE_SLOT" || body?.code === "SLOT_OCCUPIED")) {
      setSubmitError({
        message: "That time was just taken by someone else. Please pick another time.",
        action: "reload-slots",
      });
    } else if (res.status === 422 && body?.code === "GAP_FRAGMENT") {
      setSubmitError({
        message: `That start time would leave a ${body.fragmentMinutes ?? "too-short"}-minute gap for the stylist. Please pick an adjacent time or another day.`,
        action: "reload-slots",
      });
    } else if (res.status === 422 && body?.error === "VALIDATION") {
      const detail = body.issues?.map((issue) => issue.message).join(" ");
      setSubmitError({
        message: `The booking was rejected: ${detail || "please check your details and try again."}`,
        action: "none",
      });
    } else if (res.status === 404) {
      setSubmitError({
        message: "This service or stylist is no longer available. Please start over.",
        action: "restart",
      });
    } else {
      setSubmitError({
        message: "Could not complete the booking. Please try again.",
        action: "none",
      });
    }
  }

  if (confirmation) {
    return (
      <section className="wizard-card" aria-labelledby="confirm-heading" aria-live="polite">
        <h2 id="confirm-heading">Booking confirmed</h2>
        <p className="wizard-note">Your appointment is saved.</p>
        <dl className="confirm-list">
          <div>
            <dt>Service</dt>
            <dd>{confirmation.serviceName}</dd>
          </div>
          <div>
            <dt>Stylist</dt>
            <dd>{confirmation.stylistName}</dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>
              {dateFmt.format(new Date(confirmation.startsAt))} at{" "}
              {timeFmt.format(new Date(confirmation.startsAt))}
            </dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd className="confirm-ref">{confirmation.bookingId}</dd>
          </div>
        </dl>
        <div className="wizard-actions">
          <a className="cta" href={`/s/${slug}`}>
            Back to {salonName}
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="wizard-card" aria-labelledby="wizard-heading">
      <h2 id="wizard-heading">Book at {salonName}</h2>
      <ol className="wizard-progress">
        {["Service", "Stylist", "Time", "Contact"].map((label, index) => (
          <li
            key={label}
            aria-current={step === index + 1 ? "step" : undefined}
            className={step === index + 1 ? "is-current" : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <fieldset className="wizard-field">
          <legend>Choose a service</legend>
          {services === null && !servicesError ? (
            <p className="wizard-note" role="status">
              Loading services…
            </p>
          ) : servicesError ? (
            <div>
              <p className="wizard-error" role="alert">
                Could not load services.
              </p>
              <div className="wizard-actions">
                <button type="button" className="btn" onClick={() => window.location.reload()}>
                  Try again
                </button>
              </div>
            </div>
          ) : services !== null && services.length === 0 ? (
            <p className="wizard-note">No services available right now.</p>
          ) : (
            <div className="wizard-options">
              {services?.map((service) => (
                <label key={service.id} className="wizard-option">
                  <input
                    type="radio"
                    name="service"
                    value={service.id}
                    checked={serviceId === service.id}
                    onChange={() => {
                      setServiceId(service.id);
                      setSubmitError(null);
                    }}
                  />
                  <span className="wizard-option-name">{service.name}</span>
                  <span className="wizard-option-meta">
                    {service.durationMinutes} min · {eur.format(service.priceCents / 100)}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="wizard-actions">
            <button
              type="button"
              className="btn"
              disabled={serviceId === ""}
              onClick={() => {
                setSelectedSlot(null);
                setStep(2);
              }}
            >
              Continue
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === 2 ? (
        <fieldset className="wizard-field">
          <legend>Choose a stylist</legend>
          {employeesError ? (
            <p className="wizard-error" role="alert">
              Could not load stylists — first available will be assigned.
            </p>
          ) : employees === null ? (
            <p className="wizard-note" role="status">
              Loading stylists…
            </p>
          ) : employees.length === 0 ? (
            <p className="wizard-note">No named stylists — first available will be assigned.</p>
          ) : null}
          <div className="wizard-options">
            <label className="wizard-option">
              <input
                type="radio"
                name="stylist"
                value=""
                checked={employeeId === ""}
                onChange={() => setEmployeeId("")}
              />
              <span className="wizard-option-name">First available</span>
              <span className="wizard-option-meta">Any stylist</span>
            </label>
            {employees?.map((employee) => (
              <label key={employee.id} className="wizard-option">
                <input
                  type="radio"
                  name="stylist"
                  value={employee.id}
                  checked={employeeId === employee.id}
                  onChange={() => setEmployeeId(employee.id)}
                />
                <span className="wizard-option-name">{employee.displayName}</span>
                {employee.title ? <span className="wizard-option-meta">{employee.title}</span> : null}
              </label>
            ))}
          </div>
          <div className="wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSelectedSlot(null);
                setStep(3);
              }}
            >
              Continue
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === 3 ? (
        <fieldset className="wizard-field">
          <legend>Pick a date and time</legend>
          <label className="wizard-label" htmlFor="wizard-date">
            Date
          </label>
          <input
            id="wizard-date"
            className="wizard-input"
            type="date"
            value={date}
            min={minDate}
            max={maxDate}
            onChange={(event) => {
              setDate(event.target.value);
              setSelectedSlot(null);
            }}
          />

          {date === "" ? (
            <p className="wizard-note">Choose a date to see open times.</p>
          ) : slotsLoading ? (
            <p className="wizard-note" role="status">
              Loading open times…
            </p>
          ) : slotsError ? (
            <div>
              <p className="wizard-error" role="alert">
                Could not load open times.
              </p>
              <div className="wizard-actions">
                <button type="button" className="btn" onClick={() => setSlotsNonce((n) => n + 1)}>
                  Try again
                </button>
              </div>
            </div>
          ) : groupedSlots.length === 0 ? (
            <p className="wizard-note">No open times on this date — try another day.</p>
          ) : (
            groupedSlots.map(([day, daySlots]) => (
              <div key={day} className="slot-day">
                <h3 className="slot-day-heading">{dateFmt.format(new Date(`${day}T12:00:00Z`))}</h3>
                <div className="slot-grid">
                  {daySlots.map((slot) => (
                    <button
                      key={`${slot.startUtc}-${slot.employeeId}`}
                      type="button"
                      className="slot-button"
                      aria-pressed={
                        selectedSlot?.startUtc === slot.startUtc &&
                        selectedSlot?.employeeId === slot.employeeId
                      }
                      onClick={() => setSelectedSlot(slot)}
                    >
                      {timeFmt.format(new Date(slot.startUtc))}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
          <div className="wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>
              Back
            </button>
            <button
              type="button"
              className="btn"
              disabled={selectedSlot === null}
              onClick={() => setStep(4)}
            >
              Continue
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === 4 && chosenService !== null && selectedSlot !== null ? (
        <form className="wizard-form" onSubmit={onSubmit} noValidate>
          <fieldset className="wizard-field">
            <legend>Your details</legend>
            <p className="wizard-summary">
              {chosenService.name} · {chosenService.durationMinutes} min ·{" "}
              {chosenEmployee?.displayName ?? "First available"} ·{" "}
              {dateFmt.format(new Date(selectedSlot.startUtc))} at{" "}
              {timeFmt.format(new Date(selectedSlot.startUtc))}
            </p>
            <label className="wizard-label" htmlFor="wizard-name">
              Name
            </label>
            <input
              id="wizard-name"
              className="wizard-input"
              value={name}
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
            />
            <label className="wizard-label" htmlFor="wizard-phone">
              Phone
            </label>
            <input
              id="wizard-phone"
              className="wizard-input"
              type="tel"
              value={phone}
              autoComplete="tel"
              onChange={(event) => setPhone(event.target.value)}
            />
            <label className="wizard-label" htmlFor="wizard-email">
              Email
            </label>
            <input
              id="wizard-email"
              className="wizard-input"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
            />
            <p className="wizard-note">Phone or email — at least one, so the salon can reach you.</p>
            {contactError ? (
              <p className="wizard-error" role="alert">
                {contactError}
              </p>
            ) : null}
            {submitError ? (
              <div className="wizard-error-box" role="alert">
                <p>{submitError.message}</p>
                {submitError.action === "reload-slots" ? (
                  <button type="button" className="btn" onClick={backToSlots}>
                    Pick another time
                  </button>
                ) : null}
                {submitError.action === "restart" ? (
                  <button type="button" className="btn" onClick={resetAll}>
                    Start over
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="wizard-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={submitting}
                onClick={() => setStep(3)}
              >
                Back
              </button>
              <button type="submit" className="btn" disabled={submitting}>
                {submitting ? "Booking…" : "Confirm booking"}
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}
