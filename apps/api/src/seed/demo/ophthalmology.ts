import { db } from "../../db/client.js";
import type { Edition } from "@pulseos/types";
import { journeys, marketingCampaigns, tasks, timelineEvents } from "../../db/schema.js";
import { seedCallDemo } from "./call-demo.js";
import { seedAppointmentDemo } from "./appointment-demo.js";
import { seedFollowUpDemo } from "./followup-demo.js";
import { installDepartmentTemplate } from "../../domain/specialty/department.service.js";
import { OPHTHALMOLOGY_TREATMENTS } from "../../domain/specialty/ophthalmology.templates.js";
import { eq } from "drizzle-orm";
import { assertJourneyConfigsConsistent } from "./consistency.js";
import {
  createDemoBranches,
  createDemoConnectors,
  createDemoPatients,
  createDemoTenant,
  createDemoUsers,
  createLeadsInOrder,
  daysFromNow,
  fixtureIdentifiers,
  journeyIdForPatient,
  seedConversations,
  seedJourneys,
  type ConversationConfig,
  type DemoContext,
  type DemoJourneyConfig,
  type LeadInput,
} from "./shared.js";

// Everything eye-specific in the product lives HERE, as data: the specialty
// templates come from ophthalmology.templates.ts, the rest is patients,
// campaigns and communication history. No page or service knows this tenant
// is ophthalmology — it just renders what the tenant contains.
//
// All estimated values and revenue figures are clearly DEMO numbers, not a
// price list. Clinical wording stays operational (what was advised, what the
// patient asked) — never a diagnosis inferred from a conversation.

type Laterality = "Right" | "Left" | "Both";

// Common ophthalmology intake fields shared by every service line.
function eyeIntake(v: { concern: string; laterality: Laterality; duration: string; prevSurgery: "Yes" | "No"; diabetes: "Yes" | "No"; glasses: string }) {
  return {
    primary_eye_concern: v.concern,
    laterality: v.laterality,
    symptom_duration: v.duration,
    previous_eye_surgery: v.prevSurgery,
    diabetes: v.diabetes,
    glasses_or_lens_use: v.glasses,
  };
}

// Patient index -> Journey story. Even indexes are owned by the Patient
// Coordinator, odd by Front Desk (same rule as the gynecology demo), so the
// follow-up tasks below deliberately sit on even indexes for My Work.
export const OPHTHALMOLOGY_PATIENT_NAMES = [
  "Ramesh Hegde", "Savitha Murthy", "Kavitha Prakash", "Manjunath Shetty", "Nisha Bhandari", "Ishaan Rao",
  "Aarav Deshpande", "Prakash Naidu", "Lalitha Krishnan", "Mohan Kumar", "Geetha Bhat", "Farhan Sheikh",
  "Divya Rao", "Sanjay Gowda", "Meera Pillai", "Anil Joshi", "Zoya Khan", "Harish Bhat",
  "Pallavi Nayak", "Rekha Shenoy", "Vinod Acharya", "Uma Sridhar", "Bhaskar Rao", "Sudha Hegde", "Chandan Kulkarni", "Arnav Prabhu", "Yashoda Rao",
  // 27+: Laser (PRK decision) and Keratoconus stories
  "Sneha Kamath", "Abhishek Nayak", "Tanvi Shetty", "Rohan Iyer",
];

export const JOURNEY_CONFIGS: DemoJourneyConfig[] = [
  // 0 — CATARACT · Google · right eye · consultation done, surgery advised, decision pending, follow-up due
  {
    patientIdx: 0, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: "cataractGoogle", stage: "treatment_advised",
    contactedOffsetDays: -6, createdOffsetDays: -6,
    appt: { status: "completed", offsetDays: -2, hour: 10, doctor: "rajiv", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Surgery advised for the right eye; patient wants to discuss with family." },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Right Eye", status: "DECISION_PENDING", estimatedValue: 45_000, decisionOffsetDays: 3 },
    task: { reason: "treatment_decision_pending", dueOffsetDays: -1, notes: "Call back about the cataract surgery estimate and preferred dates" },
    fields: {
      ...eyeIntake({ concern: "Gradually worsening blurred vision", laterality: "Right", duration: "About 8 months", prevSurgery: "No", diabetes: "Yes", glasses: "Reading glasses" }),
      cataract_diagnosis: "Confirmed", cataract_eye: "Right", cataract_surgery_advised: "Yes", cataract_surgery_interest: "Considering",
    },
    interactions: [
      {
        kind: "call", direction: "inbound", status: "completed", durationSeconds: 252, daysAgo: 6, hour: 10, minute: 42, endpoint: "cataract", agent: "Arun Kulkarni",
        summary: "Patient reports gradually worsening blurred vision in the right eye and wants to understand cataract consultation and surgery options.",
        outcome: "Appointment booked.",
      },
      {
        kind: "whatsapp", endpoint: "whatsapp",
        messages: [
          { sender: "patient", body: "Can I send my previous eye reports before the appointment?", daysAgo: 6, hour: 11, minute: 20 },
          { sender: "staff", body: "Yes, you can share them here and bring the originals when you visit.", daysAgo: 6, hour: 11, minute: 32 },
        ],
      },
      {
        kind: "call", direction: "outbound", status: "completed", durationSeconds: 178, daysAgo: 1, hour: 15, minute: 10, endpoint: "surgery", agent: "Arun Kulkarni",
        summary: "Followed up after the consultation, shared the surgery estimate and answered questions about the process. Patient will decide after speaking with family.",
        outcome: "Decision pending.",
      },
    ],
  },
  // 1 — CATARACT · Meta · both eyes · appointment booked
  {
    patientIdx: 1, journeyType: "Cataract", specialtyKey: "CATARACT", source: "meta", campaignKey: "cataractMeta", stage: "booked",
    contactedOffsetDays: -3, createdOffsetDays: -3,
    appt: { status: "confirmed", offsetDays: 1, hour: 10, doctor: "rajiv", reason: "Cataract consultation" },
    fields: {
      ...eyeIntake({ concern: "Blurred vision in both eyes, difficulty reading", laterality: "Both", duration: "Over a year", prevSurgery: "No", diabetes: "No", glasses: "Bifocal glasses" }),
      cataract_diagnosis: "Suspected", cataract_eye: "Both", cataract_surgery_advised: "No", cataract_surgery_interest: "Needs counselling",
    },
    interactions: [
      {
        kind: "call", direction: "outbound", status: "completed", durationSeconds: 185, daysAgo: 3, hour: 11, minute: 5, endpoint: "cataract", agent: "Deepa Nair",
        summary: "Called back after the Meta enquiry form. Patient reports blurred vision in both eyes and wants a cataract consultation.",
        outcome: "Appointment booked.",
      },
      {
        kind: "whatsapp", endpoint: "whatsapp",
        messages: [
          { sender: "staff", body: "Your consultation is confirmed for 10 AM. Please carry your ID and any previous eye reports.", daysAgo: 2, hour: 16, minute: 30 },
          { sender: "patient", body: "Thank you. Should someone come with me?", daysAgo: 2, hour: 16, minute: 44 },
          { sender: "staff", body: "It helps to bring an attendant, as your pupils may be dilated during the examination.", daysAgo: 2, hour: 16, minute: 50 },
        ],
      },
    ],
  },
  // 2 — OCULOPLASTY · Website · ptosis · consulted, procedure advised & accepted, scheduled
  {
    patientIdx: 2, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "website", campaignKey: "website", stage: "scheduled",
    contactedOffsetDays: -10, createdOffsetDays: -10,
    appt: { status: "completed", offsetDays: -7, hour: 11, doctor: "shalini", reason: "Oculoplasty consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Ptosis correction advised; patient accepted." },
    treatment: { definitionKey: "PTOSIS_CORRECTION", status: "SCHEDULED", estimatedValue: 55_000, decisionOffsetDays: -4, plannedOffsetDays: 5 },
    task: { reason: "manual_task", type: "FOLLOW_UP", dueOffsetDays: 0, notes: "Ptosis procedure scheduled — confirm pre-procedure instructions and arrival time" },
    fields: {
      ...eyeIntake({ concern: "Drooping left upper eyelid", laterality: "Left", duration: "About 2 years", prevSurgery: "No", diabetes: "No", glasses: "None" }),
      oculoplasty_concern: "Ptosis", cosmetic_or_functional: "Both", oculoplasty_procedure_advised: "Yes",
    },
    interactions: [
      // Backs the CALL conversation in the Inbox — the missed call is a real call row.
      { kind: "call", direction: "inbound", status: "missed", durationSeconds: 0, daysAgo: 1, hour: 16, minute: 40, endpoint: "surgery" },
    ],
  },
  // 3 — OCULOPLASTY · WhatsApp · watering eye / tear duct · needs callback
  {
    patientIdx: 3, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "whatsapp", campaignKey: null, stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: -1,
    task: { reason: "high_intent_uncontacted", dueOffsetDays: -1, notes: "Patient enquired on WhatsApp about a watering eye — call to book an oculoplasty consultation" },
    fields: {
      ...eyeIntake({ concern: "Constant watering of the right eye", laterality: "Right", duration: "Several months", prevSurgery: "No", diabetes: "No", glasses: "None" }),
      oculoplasty_concern: "Tear duct problem", cosmetic_or_functional: "Functional", oculoplasty_procedure_advised: "No",
    },
    interactions: [
      {
        kind: "whatsapp", endpoint: "whatsapp", ownershipState: "HUMAN_REQUIRED",
        messages: [
          { sender: "patient", body: "Hello, my right eye has been watering constantly for months. Do you have a doctor who treats blocked tear ducts?", daysAgo: 1, hour: 10, minute: 12 },
          { sender: "ai", body: "Thanks for reaching out. Our oculoplasty team evaluates watering eyes. A coordinator will call you to book a consultation.", daysAgo: 1, hour: 10, minute: 13 },
        ],
      },
    ],
  },
  // 4 — LASER · Google · screening completed, eligibility discussion pending, callback due
  {
    patientIdx: 4, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "google", campaignKey: "lasikGoogle", stage: "consulted",
    contactedOffsetDays: -5, createdOffsetDays: -5,
    appt: { status: "completed", offsetDays: -1, hour: 12, doctor: "rajiv", reason: "Laser vision correction screening" },
    outcome: { value: "FOLLOW_UP_REQUIRED", notes: "Screening completed; eligibility discussion pending." },
    task: { reason: "missed_follow_up", type: "CALLBACK", dueOffsetDays: 0, notes: "Screening completed — call back to discuss eligibility and options" },
    fields: {
      ...eyeIntake({ concern: "Wants to reduce dependence on glasses", laterality: "Both", duration: "Since school", prevSurgery: "No", diabetes: "No", glasses: "Spectacles, daily" }),
      lvc_interest: "LASIK", spectacle_power: "-3.50 / -3.00", lvc_contact_lens_use: "No", lvc_screening_completed: "Yes", lvc_eligible: "Pending evaluation",
    },
    interactions: [
      {
        kind: "call", direction: "inbound", status: "completed", durationSeconds: 220, daysAgo: 5, hour: 11, minute: 15, endpoint: "main", agent: "Deepa Nair",
        summary: "Patient asked about LASIK and SMILE options and whether a screening is needed first.",
        outcome: "Screening appointment booked.",
      },
      {
        kind: "whatsapp", endpoint: "whatsapp",
        messages: [
          { sender: "patient", body: "What should I do about my contact lenses before the screening?", daysAgo: 2, hour: 18, minute: 5 },
          { sender: "staff", body: "Please avoid wearing contact lenses to the screening and bring your glasses. The screening team will confirm the exact instructions.", daysAgo: 2, hour: 18, minute: 12 },
        ],
      },
    ],
  },
  // 5 — LASER · Meta (Instagram) · wants LASIK/SMILE evaluation · screening booked
  {
    patientIdx: 5, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "meta", campaignKey: "lasikMeta", stage: "booked",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    appt: { status: "confirmed", offsetDays: 1, hour: 14, doctor: "rajiv", reason: "Laser vision correction screening" },
    fields: {
      ...eyeIntake({ concern: "Interested in LASIK or SMILE", laterality: "Both", duration: "Several years", prevSurgery: "No", diabetes: "No", glasses: "Contact lenses, occasional" }),
      lvc_interest: "Not sure", spectacle_power: "-2.25 / -2.00", lvc_contact_lens_use: "Yes", lvc_screening_completed: "No", lvc_eligible: "Pending evaluation",
    },
  },
  // 6 — SQUINT · phone · parent enquiry for child · consultation booked
  {
    patientIdx: 6, journeyType: "Squint", specialtyKey: "SQUINT", source: "phone", campaignKey: null, stage: "booked",
    contactedOffsetDays: -2, createdOffsetDays: -2,
    appt: { status: "confirmed", offsetDays: 2, hour: 11, doctor: "shalini", reason: "Squint consultation (child)" },
    task: { reason: "manual_task", type: "APPOINTMENT_CONFIRMATION", dueOffsetDays: 0, notes: "Confirm the squint consultation with the parent; ask them to bring previous glasses" },
    fields: {
      ...eyeIntake({ concern: "One eye turns inward at times (parent's report)", laterality: "Both", duration: "About a year", prevSurgery: "No", diabetes: "No", glasses: "Glasses since last year" }),
      squint_patient_group: "Child", squint_type: "Inward turn", squint_since: "About a year", squint_previous_treatment: "Glasses", squint_surgery_advised: "No",
    },
    interactions: [
      {
        kind: "call", direction: "inbound", status: "completed", durationSeconds: 320, daysAgo: 2, hour: 12, minute: 10, endpoint: "main", agent: "Deepa Nair",
        summary: "Parent reports the child's eye turns inward at times and asked for a squint consultation for a 6-year-old.",
        outcome: "Appointment booked.",
      },
      {
        kind: "whatsapp", endpoint: "whatsapp",
        messages: [
          { sender: "staff", body: "Your child's consultation is confirmed. Please bring any previous glasses prescription.", daysAgo: 1, hour: 17, minute: 30 },
          { sender: "patient", body: "Yes, we have his old glasses.", daysAgo: 1, hour: 17, minute: 52 },
        ],
      },
    ],
  },
  // 7 — SQUINT · referral · adult · consulted, treatment decision pending
  {
    patientIdx: 7, journeyType: "Squint", specialtyKey: "SQUINT", source: "referral", campaignKey: null, stage: "treatment_advised",
    contactedOffsetDays: -5, createdOffsetDays: -6,
    appt: { status: "completed", offsetDays: -3, hour: 15, doctor: "shalini", reason: "Squint consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Surgical correction discussed; patient considering timing." },
    treatment: { definitionKey: "SQUINT_SURGERY", status: "DECISION_PENDING", estimatedValue: 48_000, decisionOffsetDays: 4 },
    task: { reason: "treatment_decision_pending", dueOffsetDays: 0, notes: "Follow up on the squint surgery decision" },
    fields: {
      ...eyeIntake({ concern: "Outward turn of the left eye", laterality: "Left", duration: "Since childhood", prevSurgery: "No", diabetes: "No", glasses: "None" }),
      squint_patient_group: "Adult", squint_type: "Outward turn", squint_since: "Childhood", squint_previous_treatment: "None", squint_surgery_advised: "Yes",
    },
  },

  // --- Completed treatments: real revenue for campaign ROAS ---
  {
    patientIdx: 8, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: "cataractGoogle", stage: "completed",
    contactedOffsetDays: -21, createdOffsetDays: -22,
    appt: { status: "completed", offsetDays: -20, hour: 10, doctor: "rajiv", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Left Eye", status: "COMPLETED", estimatedValue: 42_000 },
    revenueAmount: 42_000, revenueOffsetDays: -12,
    fields: {
      ...eyeIntake({ concern: "Cloudy vision in the left eye", laterality: "Left", duration: "1 year", prevSurgery: "No", diabetes: "Yes", glasses: "Reading glasses" }),
      cataract_diagnosis: "Confirmed", cataract_eye: "Left", cataract_surgery_advised: "Yes", cataract_surgery_interest: "Ready to schedule",
    },
  },
  {
    patientIdx: 9, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: "cataractGoogle", stage: "completed",
    contactedOffsetDays: -14, createdOffsetDays: -15,
    appt: { status: "completed", offsetDays: -13, hour: 11, doctor: "rajiv", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Right Eye", status: "COMPLETED", estimatedValue: 48_000 },
    revenueAmount: 48_000, revenueOffsetDays: -9,
    fields: {
      ...eyeIntake({ concern: "Glare while driving at night", laterality: "Right", duration: "10 months", prevSurgery: "No", diabetes: "No", glasses: "Distance glasses" }),
      cataract_diagnosis: "Confirmed", cataract_eye: "Right", cataract_surgery_advised: "Yes", cataract_surgery_interest: "Ready to schedule",
    },
  },
  // 10 — FLAGSHIP: Meta lead → outbound calls → WhatsApp → appointment → consultation → surgery advised
  //        → accepted → surgery done → payment. The one complete end-to-end Patient 360 story.
  {
    patientIdx: 10, journeyType: "Cataract", specialtyKey: "CATARACT", source: "meta", campaignKey: "cataractMeta", stage: "completed",
    contactedOffsetDays: -9, createdOffsetDays: -9,
    appt: { status: "completed", offsetDays: -6, hour: 12, doctor: "rajiv", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Cataract surgery advised for the right eye." },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Right Eye", status: "COMPLETED", estimatedValue: 40_000, decisionOffsetDays: -4 },
    revenueAmount: 40_000, revenueOffsetDays: -2,
    fields: {
      ...eyeIntake({ concern: "Blurred vision, difficulty with night driving", laterality: "Both", duration: "About a year", prevSurgery: "No", diabetes: "No", glasses: "Progressive glasses" }),
      cataract_diagnosis: "Confirmed", cataract_eye: "Right", cataract_surgery_advised: "Yes", cataract_surgery_interest: "Ready to schedule",
    },
    interactions: [
      { kind: "call", direction: "outbound", status: "no_answer", durationSeconds: 0, daysAgo: 9, hour: 10, minute: 30, endpoint: "cataract", agent: "Arun Kulkarni", summary: "No answer on the first attempt after the Meta enquiry form.", outcome: "Retry scheduled." },
      {
        kind: "call", direction: "outbound", status: "completed", durationSeconds: 168, daysAgo: 9, hour: 14, minute: 20, endpoint: "cataract", agent: "Arun Kulkarni",
        summary: "Spoke to the patient about blurred vision in both eyes and explained how the cataract consultation works.", outcome: "Follow-up scheduled.",
      },
      {
        kind: "call", direction: "outbound", status: "completed", durationSeconds: 240, daysAgo: 5, hour: 15, minute: 30, endpoint: "surgery", agent: "Arun Kulkarni",
        summary: "Followed up after the consultation, explained the surgery estimate and the admission steps. Patient discussed it with family and wants to go ahead.",
        outcome: "Surgery accepted.",
      },
      {
        // One WhatsApp thread per patient and line — booking, then surgery logistics.
        kind: "whatsapp", endpoint: "whatsapp",
        messages: [
          { sender: "patient", body: "Morning slots work best for me.", daysAgo: 8, hour: 11, minute: 0 },
          { sender: "staff", body: "Booked a morning slot for you. We will send a reminder before the visit.", daysAgo: 8, hour: 11, minute: 10 },
          { sender: "staff", body: "Your surgery is booked. Our team will share the admission instructions; please bring your ID and insurance details.", daysAgo: 4, hour: 17, minute: 0 },
          { sender: "patient", body: "Thank you. My son will accompany me.", daysAgo: 4, hour: 17, minute: 25 },
        ],
      },
    ],
  },
  {
    patientIdx: 11, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "google", campaignKey: "lasikGoogle", stage: "completed",
    contactedOffsetDays: -17, createdOffsetDays: -18,
    appt: { status: "completed", offsetDays: -15, hour: 9, doctor: "rajiv", reason: "Laser vision correction screening" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "SMILE", status: "COMPLETED", estimatedValue: 96_000 },
    revenueAmount: 96_000, revenueOffsetDays: -8,
    fields: {
      ...eyeIntake({ concern: "Wants freedom from glasses", laterality: "Both", duration: "Since teens", prevSurgery: "No", diabetes: "No", glasses: "Spectacles, daily" }),
      lvc_interest: "SMILE", spectacle_power: "-4.00 / -4.25", lvc_contact_lens_use: "No", lvc_screening_completed: "Yes", lvc_eligible: "Yes",
    },
  },
  {
    patientIdx: 12, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "meta", campaignKey: "ptosisMeta", stage: "completed",
    contactedOffsetDays: -16, createdOffsetDays: -17,
    appt: { status: "completed", offsetDays: -14, hour: 14, doctor: "shalini", reason: "Oculoplasty consultation" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "DCR", status: "COMPLETED", estimatedValue: 38_000 },
    revenueAmount: 38_000, revenueOffsetDays: -7,
    fields: {
      ...eyeIntake({ concern: "Persistent watering, occasional discharge", laterality: "Left", duration: "6 months", prevSurgery: "No", diabetes: "No", glasses: "None" }),
      oculoplasty_concern: "Tear duct problem", cosmetic_or_functional: "Functional", oculoplasty_procedure_advised: "Yes",
    },
  },
  {
    patientIdx: 13, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: "cataractGoogle", stage: "booked",
    contactedOffsetDays: -3, createdOffsetDays: -4,
    appt: { status: "no_show", offsetDays: -1, hour: 10, doctor: "rajiv", reason: "Cataract consultation" },
    task: { reason: "no_show", dueOffsetDays: -1, notes: "Missed cataract consultation — call to reschedule" },
    fields: {
      ...eyeIntake({ concern: "Blurred vision", laterality: "Right", duration: "6 months", prevSurgery: "No", diabetes: "No", glasses: "Reading glasses" }),
      cataract_diagnosis: "Suspected", cataract_eye: "Right", cataract_surgery_advised: "No", cataract_surgery_interest: "Considering",
    },
  },
  {
    patientIdx: 14, journeyType: "Squint", specialtyKey: "SQUINT", source: "meta", campaignKey: "squintMeta", stage: "treatment_advised",
    contactedOffsetDays: -8, createdOffsetDays: -9,
    appt: { status: "completed", offsetDays: -5, hour: 10, doctor: "shalini", reason: "Squint consultation (child)" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Surgery advised; parents agreed." },
    treatment: { definitionKey: "SQUINT_SURGERY", status: "ACCEPTED", estimatedValue: 45_000, decisionOffsetDays: -2 },
    task: { reason: "manual_task", type: "FOLLOW_UP", dueOffsetDays: 0, notes: "Squint surgery accepted — agree a surgery date with the parents" },
    fields: {
      ...eyeIntake({ concern: "Outward turn of the right eye (parent's report)", laterality: "Right", duration: "2 years", prevSurgery: "No", diabetes: "No", glasses: "Glasses and patching" }),
      squint_patient_group: "Child", squint_type: "Outward turn", squint_since: "2 years", squint_previous_treatment: "Patching", squint_surgery_advised: "Yes",
    },
  },

  // --- Today's live clinic: one appointment in each in-clinic state ---
  {
    patientIdx: 15, journeyType: "Cataract", specialtyKey: "CATARACT", source: "walk_in", campaignKey: null, stage: "attended",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 8,
    appt: { status: "waiting", offsetDays: 0, hour: 9, doctor: "rajiv", reason: "Cataract consultation" },
    fields: {
      ...eyeIntake({ concern: "Blurred vision for reading", laterality: "Both", duration: "Over a year", prevSurgery: "No", diabetes: "Yes", glasses: "Bifocal glasses" }),
      cataract_diagnosis: "Suspected", cataract_eye: "Both", cataract_surgery_advised: "No", cataract_surgery_interest: "Considering",
    },
  },
  {
    patientIdx: 16, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "meta", campaignKey: "lasikMeta", stage: "attended",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    appt: { status: "checked_in", offsetDays: 0, hour: 10, doctor: "rajiv", reason: "Laser vision correction screening" },
    fields: {
      ...eyeIntake({ concern: "Interested in LASIK", laterality: "Both", duration: "Since school", prevSurgery: "No", diabetes: "No", glasses: "Spectacles, daily" }),
      lvc_interest: "LASIK", spectacle_power: "-2.75 / -2.50", lvc_contact_lens_use: "No", lvc_screening_completed: "No", lvc_eligible: "Pending evaluation",
    },
  },
  {
    patientIdx: 17, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: "cataractGoogle", stage: "treatment_advised",
    contactedOffsetDays: -4, createdOffsetDays: -5,
    // Seen today, surgery advised, decision still open — Dr. Rajiv's "treatment follow-up" list.
    appt: { status: "completed", offsetDays: 0, hour: 11, doctor: "rajiv", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Cataract surgery advised for the left eye." },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Left Eye", status: "ADVISED", estimatedValue: 44_000 },
    fields: {
      ...eyeIntake({ concern: "Blurred vision in the left eye", laterality: "Left", duration: "8 months", prevSurgery: "No", diabetes: "No", glasses: "Distance glasses" }),
      cataract_diagnosis: "Suspected", cataract_eye: "Left", cataract_surgery_advised: "No", cataract_surgery_interest: "Considering",
    },
  },
  {
    // Consultation finished today, outcome not yet recorded — lets the doctor
    // outcome workflow be exercised live against today's date.
    patientIdx: 18, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "website", campaignKey: "website", stage: "attended",
    contactedOffsetDays: -4, createdOffsetDays: -5,
    appt: { status: "completed", offsetDays: 0, hour: 9, doctor: "shalini", reason: "Oculoplasty consultation" },
    fields: {
      ...eyeIntake({ concern: "Swelling of the upper eyelid", laterality: "Right", duration: "3 months", prevSurgery: "No", diabetes: "No", glasses: "None" }),
      oculoplasty_concern: "Eyelid swelling", cosmetic_or_functional: "Functional", oculoplasty_procedure_advised: "No",
    },
  },
  {
    patientIdx: 19, journeyType: "General Eye Consultation", specialtyKey: "GENERAL_EYE_CONSULTATION", source: "website", campaignKey: "website", stage: "booked",
    contactedOffsetDays: -1, createdOffsetDays: -2,
    appt: { status: "confirmed", offsetDays: 0, hour: 16, doctor: "shalini", reason: "General eye consultation" },
    fields: eyeIntake({ concern: "Eye strain and headaches", laterality: "Both", duration: "A few weeks", prevSurgery: "No", diabetes: "No", glasses: "None" }),
  },

  {
    // Seen this morning, outcome not yet recorded — Dr. Rajiv's "awaiting outcome" list.
    patientIdx: 22, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: "cataractGoogle", stage: "attended",
    contactedOffsetDays: -4, createdOffsetDays: -5,
    appt: { status: "completed", offsetDays: 0, hour: 8, doctor: "rajiv", reason: "Cataract consultation" },
    fields: {
      ...eyeIntake({ concern: "Blurred vision in the right eye", laterality: "Right", duration: "7 months", prevSurgery: "No", diabetes: "No", glasses: "Reading glasses" }),
      cataract_diagnosis: "Suspected", cataract_eye: "Right", cataract_surgery_advised: "No", cataract_surgery_interest: "Considering",
    },
  },
  {
    // In the consulting room right now.
    patientIdx: 24, journeyType: "Cataract", specialtyKey: "CATARACT", source: "meta", campaignKey: "cataractMeta", stage: "attended",
    contactedOffsetDays: -3, createdOffsetDays: -4,
    appt: { status: "with_doctor", offsetDays: 0, hour: 12, doctor: "rajiv", reason: "Cataract consultation" },
    fields: {
      ...eyeIntake({ concern: "Blurred vision in both eyes", laterality: "Both", duration: "Over a year", prevSurgery: "No", diabetes: "Yes", glasses: "Bifocal glasses" }),
      cataract_diagnosis: "Suspected", cataract_eye: "Both", cataract_surgery_advised: "No", cataract_surgery_interest: "Needs counselling",
    },
  },
  {
    // Seen recently, no treatment needed — routine post-care / review candidate.
    patientIdx: 23, journeyType: "General Eye Consultation", specialtyKey: "GENERAL_EYE_CONSULTATION", source: "website", campaignKey: "website", stage: "consulted",
    contactedOffsetDays: -5, createdOffsetDays: -6,
    appt: { status: "completed", offsetDays: -4, hour: 10, doctor: "rajiv", reason: "General eye consultation" },
    outcome: { value: "NO_TREATMENT_REQUIRED", notes: "Routine check; no treatment needed." },
    fields: eyeIntake({ concern: "Routine eye check", laterality: "Both", duration: "N/A", prevSurgery: "No", diabetes: "No", glasses: "Reading glasses" }),
  },

  // --- More completed treatments, so revenue spans every service line ---
  {
    patientIdx: 24 + 1, journeyType: "Squint", specialtyKey: "SQUINT", source: "meta", campaignKey: "squintMeta", stage: "completed",
    contactedOffsetDays: -19, createdOffsetDays: -20,
    appt: { status: "completed", offsetDays: -16, hour: 11, doctor: "shalini", reason: "Squint consultation (child)" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Surgery advised; parents agreed." },
    treatment: { definitionKey: "SQUINT_SURGERY", status: "COMPLETED", estimatedValue: 45_000, decisionOffsetDays: -14 },
    revenueAmount: 45_000, revenueOffsetDays: -8,
    fields: {
      ...eyeIntake({ concern: "Inward turn of the left eye (parent's report)", laterality: "Left", duration: "3 years", prevSurgery: "No", diabetes: "No", glasses: "Glasses and patching" }),
      squint_patient_group: "Child", squint_type: "Inward turn", squint_since: "3 years", squint_previous_treatment: "Patching", squint_surgery_advised: "Yes",
    },
  },
  {
    patientIdx: 24 + 2, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: "cataractGoogle", stage: "completed",
    contactedOffsetDays: -21, createdOffsetDays: -22,
    appt: { status: "completed", offsetDays: -18, hour: 10, doctor: "rajiv", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Right Eye", status: "COMPLETED", estimatedValue: 46_000, decisionOffsetDays: -15 },
    revenueAmount: 46_000, revenueOffsetDays: -10,
    fields: {
      ...eyeIntake({ concern: "Difficulty seeing at night", laterality: "Right", duration: "1 year", prevSurgery: "No", diabetes: "Yes", glasses: "Distance glasses" }),
      cataract_diagnosis: "Confirmed", cataract_eye: "Right", cataract_surgery_advised: "Yes", cataract_surgery_interest: "Ready to schedule",
    },
  },

  // --- Declined / cancelled: honest non-converting outcomes ---
  {
    patientIdx: 20, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "google", campaignKey: "lasikGoogle", stage: "lost",
    contactedOffsetDays: -12, createdOffsetDays: -13,
    appt: { status: "completed", offsetDays: -10, hour: 13, doctor: "rajiv", reason: "Laser vision correction screening" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "LASIK", status: "DECLINED", estimatedValue: 90_000, decisionOffsetDays: -8 },
    fields: {
      ...eyeIntake({ concern: "Wants to stop wearing glasses", laterality: "Both", duration: "Since school", prevSurgery: "No", diabetes: "No", glasses: "Spectacles, daily" }),
      lvc_interest: "LASIK", spectacle_power: "-5.00 / -4.50", lvc_contact_lens_use: "No", lvc_screening_completed: "Yes", lvc_eligible: "No",
    },
  },
  {
    patientIdx: 21, journeyType: "General Eye Consultation", specialtyKey: "GENERAL_EYE_CONSULTATION", source: "referral", campaignKey: null, stage: "contacted",
    contactedOffsetDays: -3, createdOffsetDays: -4,
    appt: { status: "cancelled", offsetDays: -1, hour: 15, doctor: "shalini", reason: "General eye consultation" },
    fields: eyeIntake({ concern: "Routine eye check", laterality: "Both", duration: "N/A", prevSurgery: "No", diabetes: "No", glasses: "Reading glasses" }),
  },

  // --- Laser Vision Correction: comparing LASIK / SMILE / PRK after screening ---
  {
    // Screening done; PRK is the option the doctor advised. The patient is still weighing it against
    // LASIK and SMILE (cost, recovery time) — a decision-pending treatment with a counselling call due.
    patientIdx: 27, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "google", campaignKey: "lasikGoogle", stage: "treatment_advised",
    contactedOffsetDays: -8, createdOffsetDays: -8,
    appt: { status: "completed", offsetDays: -3, hour: 12, doctor: "rajiv", reason: "Laser vision correction screening" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Screening completed. PRK advised as the suitable option; patient is comparing it with LASIK and SMILE before deciding." },
    treatment: { definitionKey: "PRK", status: "DECISION_PENDING", estimatedValue: 68_000, decisionOffsetDays: 4 },
    task: { reason: "treatment_decision_pending", dueOffsetDays: 0, notes: "Call to help compare LASIK, SMILE and PRK (cost and recovery time) and note the patient's preference" },
    fields: {
      ...eyeIntake({ concern: "Wants to reduce dependence on glasses; unsure which laser procedure", laterality: "Both", duration: "Since college", prevSurgery: "No", diabetes: "No", glasses: "Spectacles, daily" }),
      lvc_interest: "Not sure", spectacle_power: "-2.00 / -1.75", lvc_contact_lens_use: "No", lvc_screening_completed: "Yes", lvc_eligible: "Yes",
    },
    interactions: [
      {
        kind: "call", direction: "inbound", status: "completed", durationSeconds: 205, daysAgo: 8, hour: 12, minute: 30, endpoint: "main", agent: "Deepa Nair",
        summary: "Patient asked what the difference is between LASIK, SMILE and PRK and whether a screening is needed first.",
        outcome: "Screening appointment booked.",
      },
      {
        kind: "whatsapp", endpoint: "whatsapp",
        messages: [
          { sender: "staff", body: "Thank you for visiting today. We have noted that PRK was advised. Please take your time to compare it with LASIK and SMILE — we can walk you through the differences on a call.", daysAgo: 3, hour: 16, minute: 10 },
          { sender: "patient", body: "Thanks. Could you tell me about the recovery time for each option?", daysAgo: 3, hour: 17, minute: 2 },
        ],
      },
    ],
  },

  // --- Keratoconus: enquiry, screening and corneal cross-linking (CXL) ---
  {
    // Enquiry -> screening consultation -> CXL advised -> follow-up call pending.
    patientIdx: 28, journeyType: "Keratoconus", specialtyKey: "KERATOCONUS", source: "google", campaignKey: "keratoconusGoogle", stage: "treatment_advised",
    contactedOffsetDays: -9, createdOffsetDays: -9,
    appt: { status: "completed", offsetDays: -4, hour: 11, doctor: "rajiv", reason: "Keratoconus screening consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Corneal cross-linking (CXL) advised for the right eye; patient wants to discuss with family before booking." },
    treatment: { definitionKey: "CXL", status: "ADVISED", estimatedValue: 34_000 },
    task: { reason: "manual_task", type: "FOLLOW_UP", dueOffsetDays: 0, notes: "Follow up on the CXL advice — answer questions about the procedure and offer a date to book" },
    fields: {
      ...eyeIntake({ concern: "Vision keeps changing; spectacle power changes often", laterality: "Right", duration: "About 2 years", prevSurgery: "No", diabetes: "No", glasses: "Spectacles, frequently updated" }),
      keratoconus_status: "Confirmed", keratoconus_eye: "Right", eye_rubbing_history: "Yes", topography_done: "Yes", cxl_advised: "Yes",
    },
    interactions: [
      {
        kind: "call", direction: "inbound", status: "completed", durationSeconds: 236, daysAgo: 9, hour: 15, minute: 5, endpoint: "main", agent: "Arun Kulkarni",
        summary: "Patient was told by an optician that the cornea may need a specialist review and asked about keratoconus screening.",
        outcome: "Screening consultation booked.",
      },
      {
        kind: "whatsapp", endpoint: "whatsapp",
        messages: [
          { sender: "staff", body: "Your screening consultation is confirmed. Please bring your current glasses and any previous eye reports.", daysAgo: 8, hour: 10, minute: 15 },
          { sender: "patient", body: "Will the screening take long? I have to arrange time off work.", daysAgo: 8, hour: 10, minute: 40 },
          { sender: "staff", body: "Please plan for about two hours in case extra checks are needed. The team will confirm on the day.", daysAgo: 8, hour: 10, minute: 52 },
        ],
      },
    ],
  },
  {
    // Earliest stage: an enquiry that nobody has called yet.
    patientIdx: 29, journeyType: "Keratoconus", specialtyKey: "KERATOCONUS", source: "website", campaignKey: "website", stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: -1,
    task: { reason: "high_intent_uncontacted", dueOffsetDays: -1, notes: "Website enquiry about keratoconus screening for a teenager — call the parent to book a screening consultation" },
    fields: {
      ...eyeIntake({ concern: "Frequent change in glasses power; rubs eyes often (parent's report)", laterality: "Both", duration: "About a year", prevSurgery: "No", diabetes: "No", glasses: "Spectacles" }),
      keratoconus_status: "Suspected", keratoconus_eye: "Both", eye_rubbing_history: "Yes", topography_done: "No", cxl_advised: "No",
    },
  },
  {
    // Screening booked, not yet attended.
    patientIdx: 30, journeyType: "Keratoconus", specialtyKey: "KERATOCONUS", source: "google", campaignKey: "keratoconusGoogle", stage: "booked",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    appt: { status: "confirmed", offsetDays: 2, hour: 11, doctor: "shalini", reason: "Keratoconus screening consultation" },
    fields: {
      ...eyeIntake({ concern: "Blurred, distorted vision in the left eye", laterality: "Left", duration: "Several months", prevSurgery: "No", diabetes: "No", glasses: "Spectacles" }),
      keratoconus_status: "Suspected", keratoconus_eye: "Left", eye_rubbing_history: "No", topography_done: "No", cxl_advised: "No",
    },
    interactions: [
      {
        kind: "call", direction: "outbound", status: "completed", durationSeconds: 174, daysAgo: 2, hour: 11, minute: 20, endpoint: "main", agent: "Deepa Nair",
        summary: "Called back after the enquiry form. Patient reports distorted vision in the left eye and wants a keratoconus screening.",
        outcome: "Screening consultation booked.",
      },
    ],
  },
];

// Inbox coverage: every channel and every ownership state at least once, on
// patients that have no WhatsApp interaction in JOURNEY_CONFIGS (which
// already creates its own threads).
const CONVERSATION_CONFIGS: ConversationConfig[] = [
  {
    patientIdx: 13, channel: "WHATSAPP", ownershipState: "HUMAN_REQUIRED", assignedTo: null,
    messages: [
      { sender: "patient", body: "Sorry, I could not make it yesterday. Can I reschedule my cataract consultation?", minutesAgoSent: 25, unread: true },
      { sender: "ai", body: "I can help with that. Would a morning or afternoon slot suit you better?", minutesAgoSent: 24 },
    ],
  },
  {
    patientIdx: 14, channel: "WHATSAPP", ownershipState: "HUMAN_REQUIRED", assignedTo: null,
    messages: [
      { sender: "ai", body: "Hope your child is doing well. Have you and your family had a chance to discuss the surgery advice?", minutesAgoSent: 180 },
      { sender: "patient", body: "Yes, we would like to go ahead. Can someone call us about the process and how long we stay at the hospital?", minutesAgoSent: 15, unread: true },
    ],
  },
  {
    patientIdx: 9, channel: "WHATSAPP", ownershipState: "AI_ACTIVE", assignedTo: null,
    messages: [
      { sender: "patient", body: "What are your clinic timings on Saturday?", minutesAgoSent: 60 },
      { sender: "ai", body: "Our team will confirm the Saturday timings for you shortly.", minutesAgoSent: 58 },
    ],
  },
  {
    patientIdx: 11, channel: "SMS", ownershipState: "HUMAN_ACTIVE", assignedTo: "coordinator",
    messages: [
      { sender: "patient", body: "Can my post-procedure review be moved to Friday?", minutesAgoSent: 45 },
      { sender: "staff", body: "Yes, I have noted Friday — I will confirm the exact time shortly.", minutesAgoSent: 30 },
    ],
  },
  {
    patientIdx: 12, channel: "EMAIL", ownershipState: "AI_RESUME_PENDING", assignedTo: "frontDesk",
    messages: [
      { sender: "patient", body: "Thank you for clarifying the billing breakdown for my procedure.", minutesAgoSent: 500 },
      { sender: "staff", body: "You're welcome! Handing you back to our assistant for anything else.", minutesAgoSent: 480 },
    ],
  },
  {
    patientIdx: 8, channel: "INTERNAL", ownershipState: "CLOSED", assignedTo: "coordinator",
    messages: [{ sender: "staff", body: "Payment for cataract surgery confirmed and reconciled — closing this thread.", minutesAgoSent: 1_440 }],
  },
];

/** The two Ophthalmology demo tenants share every row of data; only edition, identity and fixture tags differ. */
export interface OphthalmologyVariant {
  environment: "ophthalmology" | "ophthalmology-v1";
  tenantName: string;
  /** The address of this demo hospital's own sign-in page (/login/<slug>) and the short name shown on it. */
  loginSlug: string;
  loginShortName: string;
  edition: Edition;
  /** Upper-case tag that keeps each tenant's fixture secrets, page ids and provider refs unique. */
  tag: string;
  /** Website form id the demo tenant's form connector accepts. */
  formId: string;
}

export const OPHTHALMOLOGY_V2: OphthalmologyVariant = { environment: "ophthalmology", loginSlug: "eye-demo", loginShortName: "Eye Demo", tenantName: "PulseOS Ophthalmology Demo", edition: "BETA_V2_GROWTH", tag: "EYE", formId: "eye-care-enquiry-v1" };
export const OPHTHALMOLOGY_V1: OphthalmologyVariant = { environment: "ophthalmology-v1", loginSlug: "eye-v1-demo", loginShortName: "Eye V1 Demo", tenantName: "PulseOS Ophthalmology V1 Demo", edition: "BETA_V1_CORE", tag: "EYEV1", formId: "eye-care-enquiry-v1core" };

export async function seedOphthalmologyTenant(passwordHash: string, variant: OphthalmologyVariant = OPHTHALMOLOGY_V2) {
  assertJourneyConfigsConsistent("ophthalmology", JOURNEY_CONFIGS, OPHTHALMOLOGY_PATIENT_NAMES, new Set(OPHTHALMOLOGY_TREATMENTS.map((t) => t.key)));
  const tenant = await createDemoTenant(variant.tenantName, variant.edition, { loginSlug: variant.loginSlug, login: { shortName: variant.loginShortName, badgeLabel: variant.edition === "BETA_V1_CORE" ? "Beta V1" : "Beta V2" } });
  // The same install a hospital admin runs from Settings: department, services, fields, catalogue, lead sources.
  await installDepartmentTemplate(db, tenant.id, "ophthalmology");

  const branchByKey = await createDemoBranches(tenant.id, [
    { name: "Indiranagar Eye Centre", city: "Bengaluru" },
    { name: "Jayanagar Eye Centre", city: "Bengaluru" },
  ]);
  const { a: branchA, b: branchB } = branchByKey;

  // Provider mode is FIXTURE throughout — no live integration exists locally.
  // All three phone lines are seeded active, and the seeded calls below name
  // the line they arrived on. (Runo itself never reports the line; a live
  // inbound webhook only auto-stamps an endpoint when exactly one is active.)
  const { whatsappConnector, runoConnector, endpoints } = await createDemoConnectors(tenant.id, branchByKey, {
    identifiers: fixtureIdentifiers(variant.tag),
    phoneNumberId: `FIXTURE_${variant.tag}_PHONE_NUMBER_ID`,
    whatsappNumber: "+91 97400 55100",
    whatsappLabel: "WhatsApp Line",
    formIds: [variant.formId],
    metaPageId: `FIXTURE_${variant.tag}_PAGE_ID`,
    phoneLines: [
      { key: "main", number: "+91 80 4155 0100", providerRef: `${variant.tag}-MAIN-RECEPTION`, label: "Main Reception", isActive: true, branch: "a" },
      { key: "cataract", number: "+91 80 4155 0101", providerRef: `${variant.tag}-CATARACT-LINE`, label: "Cataract Enquiry Line", isActive: true, branch: null },
      { key: "surgery", number: "+91 80 4155 0102", providerRef: `${variant.tag}-SURGERY-LINE`, label: "Surgery / Procedure Line", isActive: true, branch: null },
    ],
  });

  const staff = await createDemoUsers(variant.environment, tenant.id, passwordHash, branchByKey, [
    { slug: "superadmin", name: "Vikram Rao", role: "SUPER_ADMIN", branch: "a" },
    { slug: "admin", name: "Meghna Kapoor", role: "HOSPITAL_ADMIN", branch: "a" },
    { slug: "doctor", name: "Dr. Rajiv Menon", role: "DOCTOR", branch: "a" },
    { slug: "doctor2", name: "Dr. Shalini Bhat", role: "DOCTOR", branch: "b" },
    { slug: "frontdesk", name: "Deepa Nair", role: "FRONT_DESK", branch: "a" },
    { slug: "coordinator", name: "Arun Kulkarni", role: "PATIENT_COORDINATOR", branch: "a" },
  ]);
  const { admin, coordinator, frontdesk: frontDesk } = staff;

  const campaignDefs = [
    { key: "cataractGoogle", source: "google", name: "Cataract Consultation — Google Search", spendAmount: 38_000, days: -30 },
    { key: "cataractMeta", source: "meta", name: "Cataract Surgery Enquiries — Meta", spendAmount: 24_000, days: -30 },
    { key: "lasikGoogle", source: "google", name: "LASIK / Laser Vision Correction — Google", spendAmount: 42_000, days: -30 },
    { key: "lasikMeta", source: "meta", name: "LASIK Awareness — Instagram / Meta", spendAmount: 18_000, days: -25 },
    { key: "ptosisMeta", source: "meta", name: "Ptosis / Oculoplasty Consultation — Meta", spendAmount: 20_000, days: -30 },
    { key: "squintMeta", source: "meta", name: "Squint Consultation — Meta", spendAmount: 16_000, days: -30 },
    { key: "keratoconusGoogle", source: "google", name: "Keratoconus Screening & CXL — Google", spendAmount: 14_000, days: -30 },
    { key: "website", source: "website", name: "Website — Eye Care Enquiry Form", spendAmount: 8_000, days: -30 },
  ] as const;
  const campaignRows = await db
    .insert(marketingCampaigns)
    .values(campaignDefs.map((c) => ({ tenantId: tenant.id, source: c.source, name: c.name, spendAmount: c.spendAmount, startDate: daysFromNow(c.days), status: "active" as const })))
    .returning();
  const campaigns = Object.fromEntries(campaignDefs.map((c, i) => [c.key, campaignRows[i]]));

  const patientRows = await createDemoPatients(tenant.id, branchByKey, OPHTHALMOLOGY_PATIENT_NAMES, 700_000_000, ["Kannada", "English", "Hindi"]);

  const ctx: DemoContext = {
    tenantId: tenant.id, branches: branchByKey, admin, coordinator, frontDesk,
    doctors: { rajiv: staff.doctor, shalini: staff.doctor2 }, campaigns, patients: patientRows,
    runoConnectorId: runoConnector.id, whatsappConnectorId: whatsappConnector.id, endpoints,
  };

  const { journeyIds, timelineRows } = await seedJourneys(ctx, JOURNEY_CONFIGS);
  if (timelineRows.length > 0) await db.insert(timelineEvents).values(timelineRows);
  await seedConversations(ctx, CONVERSATION_CONFIGS);

  // Standalone tasks so every My Work view has today / upcoming / completed rows.
  const journeyOf = (patientIdx: number) => journeyIdForPatient(JOURNEY_CONFIGS, journeyIds, patientIdx);
  await db.insert(tasks).values([
    {
      tenantId: tenant.id, patientId: patientRows[1].id, journeyId: journeyOf(1), assignedTo: coordinator.id, reason: "manual_task", type: "APPOINTMENT_CONFIRMATION",
      priority: "normal", status: "pending", dueAt: daysFromNow(0, 15), createdBy: admin.id,
      notes: "Confirm tomorrow's cataract consultation and remind the patient to bring an attendant",
    },
    {
      tenantId: tenant.id, patientId: patientRows[5].id, journeyId: journeyOf(5), assignedTo: frontDesk.id, reason: "manual_task", type: "FOLLOW_UP",
      priority: "normal", status: "pending", dueAt: daysFromNow(0, 17), createdBy: admin.id,
      notes: "Remind about contact-lens instructions before tomorrow's laser screening",
    },
    {
      tenantId: tenant.id, patientId: patientRows[9].id, journeyId: journeyOf(9), assignedTo: frontDesk.id, reason: "manual_task", type: "RECALL",
      priority: "normal", status: "pending", dueAt: daysFromNow(4, 10), createdBy: admin.id,
      notes: "Recall for the post-cataract review",
    },
    {
      tenantId: tenant.id, patientId: patientRows[8].id, journeyId: journeyOf(8), assignedTo: coordinator.id, reason: "manual_task", type: "POST_CARE",
      priority: "normal", status: "completed", dueAt: daysFromNow(-2, 10), completedAt: daysFromNow(-2, 14), completedBy: coordinator.id,
      createdBy: admin.id, notes: "Post-surgery check-in call",
    },
  ]);

  // Add Lead through the real createLead() path, one per service line, so this
  // seed also exercises specialty field capture end to end.
  const leadInputs: LeadInput[] = [
    {
      name: "Harini Prabhu", phone: "9711122001", specialtyKey: "CATARACT", branchId: branchA.id, doctorId: staff.doctor.id,
      source: "google", campaignId: campaigns.cataractGoogle.id, journeyType: "Cataract", ownerId: coordinator.id, priority: "high",
      customFieldValues: { primary_eye_concern: "Cloudy vision", laterality: "Left", cataract_diagnosis: "Suspected", cataract_eye: "Left", cataract_surgery_interest: "Considering" },
      followUp: { type: "CALLBACK", dueAt: daysFromNow(1, 11).toISOString(), assignedTo: coordinator.id },
    },
    {
      name: "Imran Pasha", phone: "9711122002", specialtyKey: "OCULOPLASTY", branchId: branchB.id,
      source: "meta", campaignId: campaigns.ptosisMeta.id, journeyType: "Oculoplasty", ownerId: frontDesk.id,
      customFieldValues: { primary_eye_concern: "Under-eye puffiness", oculoplasty_concern: "Under-eye concern", cosmetic_or_functional: "Cosmetic" },
    },
    {
      name: "Tejas Rao", phone: "9711122003", specialtyKey: "LASER_VISION_CORRECTION", branchId: branchA.id,
      source: "meta", campaignId: campaigns.lasikMeta.id, journeyType: "Laser Vision Correction", ownerId: coordinator.id,
      customFieldValues: { lvc_interest: "SMILE", lvc_contact_lens_use: "Yes", lvc_screening_completed: "No" },
      followUp: { type: "FOLLOW_UP", dueAt: daysFromNow(2, 10).toISOString(), assignedTo: coordinator.id },
    },
    {
      name: "Reyansh Nair", phone: "9711122004", specialtyKey: "SQUINT", branchId: branchB.id,
      source: "meta", campaignId: campaigns.squintMeta.id, journeyType: "Squint", ownerId: frontDesk.id,
      customFieldValues: { squint_patient_group: "Child", squint_since: "Since birth", squint_previous_treatment: "None" },
    },
  ];
  const leadResults = await createLeadsInOrder(tenant.id, admin.id, leadInputs);
  // Back-date contact on two journeys (no follow-up task) so the Leads page's No Response bucket has rows.
  await db.update(journeys).set({ contactedAt: daysFromNow(-3, 10) }).where(eq(journeys.id, leadResults[1].journeyId));
  await db.update(journeys).set({ contactedAt: daysFromNow(-1, 9) }).where(eq(journeys.id, leadResults[3].journeyId));

  await seedCallDemo(tenant.id, { runoConnectorId: runoConnector.id, coordinator: { id: coordinator.id, name: coordinator.name, role: "PATIENT_COORDINATOR" }, frontDesk: { id: frontDesk.id, name: frontDesk.name, role: "FRONT_DESK" }, tag: variant.tag.toLowerCase() });

  await seedFollowUpDemo(tenant.id, { admin, coordinator, frontDesk, doctorId: staff.doctor.id, branchId: branchA.id });
  await seedAppointmentDemo(tenant.id, { admin, coordinator, frontDesk, doctorId: staff.doctor.id, branchId: branchA.id });

  console.log(`Ophthalmology tenant: ${tenant.name} (${tenant.id}) — ${JOURNEY_CONFIGS.length} journeys, ${patientRows.length} patients`);
  return { tenantId: tenant.id };
}
