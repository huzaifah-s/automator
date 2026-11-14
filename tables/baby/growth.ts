import { date, defineTable, real, text } from "../../src/core/define.ts";

/** A weight and/or height reading, usually from a clinic visit. */
export default defineTable({
  name: "baby_growth",
  description: "Growth readings: weight in kg and height in cm on a date, usually from the clinic.",

  columns: {
    measured_on: date({ label: "Date" }),
    weight_kg: real({ nullable: true, label: "Weight (kg)", help: "e.g. 4.35" }),
    height_cm: real({ nullable: true, label: "Height (cm)", help: "e.g. 55.5" }),
    place: text({ nullable: true, label: "Where", help: "Clinic, hospital, or home scale." }),
    note: text({ nullable: true, label: "Note" }),
  },

  order: { column: "measured_on", direction: "desc" },
});
