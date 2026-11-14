import { bool, date, datetime, defineTable, text } from "../../src/core/define.ts";

/**
 * Vaccine appointments, and whether each dose was given.
 *
 * One row per dose: added when the appointment is booked, and finished by
 * filling in `given_on` on the day. The schedule is not preloaded — it comes
 * from the baby's health record book, entered as appointments are made.
 * `additional` marks a vaccine outside the standard schedule (an optional
 * or paid one), with the reason in `remarks`.
 */
export default defineTable({
  name: "baby_vaccines",
  description:
    "Vaccines: one row per dose, with the appointment, the date it was given (empty until " +
    "then), the clinic, and whether it is an additional vaccine outside the standard schedule.",

  columns: {
    vaccine: text({ label: "Vaccine", help: "As written in the health book, e.g. BCG, Hep B, 6-in-1." }),
    dose: text({ nullable: true, label: "Dose", help: "1st, 2nd, booster…" }),
    appointment_at: datetime({ nullable: true, label: "Appointment", help: "When it is booked." }),
    given_on: date({ nullable: true, label: "Given on", help: "Leave empty until it is done." }),
    clinic: text({ nullable: true, label: "Clinic" }),
    additional: bool({ default: false, label: "Additional", help: "Not in the standard schedule" }),
    remarks: text({ nullable: true, label: "Remarks", help: "Why it was added, reactions, what the doctor said." }),
  },

  order: { column: "appointment_at", direction: "desc" },
});
