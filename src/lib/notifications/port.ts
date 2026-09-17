/**
 * Notification interface — DESIGN §8 + amendment §14.6(g). Sprint 5 stub seam.
 *
 * Booking logic depends on NotificationPort only; `send` MUST resolve (never
 * reject) so a failed send can never affect a committed booking. Default
 * adapter: console. Sprint 5 swaps in SmtpNotificationAdapter with zero
 * booking-code changes.
 */

export type NotificationType = "BOOKING_CONFIRMED" | "BOOKING_CANCELLED";

export interface Notification {
  type: NotificationType;
  bookingId: string;
  salonId: string;
  recipientEmail: string | null;
  locale: "fi";
}

export interface NotificationPort {
  /** MUST resolve (never reject). Implementations catch + log internally. */
  send(n: Notification): Promise<void>;
}

export class ConsoleNotificationAdapter implements NotificationPort {
  async send(n: Notification): Promise<void> {
    try {
      console.log(JSON.stringify({ channel: "console", notification: n }));
    } catch {
      // §8 failure isolation — never propagate
    }
  }
}

let currentPort: NotificationPort = new ConsoleNotificationAdapter();

/** Module-level seam (§14.6(g)). Returns the previous port so callers can restore it. */
export function setNotificationPort(port: NotificationPort): NotificationPort {
  const previous = currentPort;
  currentPort = port;
  return previous;
}

export function getNotificationPort(): NotificationPort {
  return currentPort;
}
