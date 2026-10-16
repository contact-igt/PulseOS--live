// Public site content. Every patient, hospital and number here is SYNTHETIC. Product claims are limited to what the app
// does today (docs/marketing/PULSEOS_PUBLIC_CLAIMS.md); provider-dependent behaviour is always worded "when your provider is connected".

export const NAV_LINKS = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#journey" },
  { label: "For hospitals", href: "#roles" },
  { label: "Integrations", href: "#integrations" },
] as const;

/** Where demo requests go. Unset means the form says so instead of dropping the request. */
export const DEMO_REQUEST_EMAIL = process.env.NEXT_PUBLIC_DEMO_REQUEST_EMAIL?.trim() || "";

/** The hook: "your report says 42 enquiries". Synthetic, labelled as such on the page. */
export const HOOK_STAGES = [
  { label: "Enquiries", count: 42 },
  { label: "Appointments booked", count: 27 },
  { label: "Visits attended", count: 21 },
  { label: "Consultations completed", count: 18 },
  { label: "Procedures advised", count: 9 },
  { label: "Procedures scheduled", count: 6 },
  { label: "Procedures done", count: 4 },
] as const;

/** Hero + owner dashboard funnel (a 30-day hospital view). */
export const FUNNEL_STAGES = [
  { key: "enquiries", label: "Enquiries", count: 143 },
  { key: "booked", label: "Appointments booked", count: 91 },
  { key: "attended", label: "Visits attended", count: 72 },
  { key: "consulted", label: "Consultations completed", count: 68 },
  { key: "advised", label: "Procedures advised", count: 34 },
  { key: "scheduled", label: "Procedures scheduled", count: 19 },
  { key: "done", label: "Procedures done", count: 14 },
] as const;

export const SOURCE_ROWS = [
  { source: "Google", enquiries: 52, visits: 31, consultations: 24, procedures: 6 },
  { source: "Meta", enquiries: 38, visits: 17, consultations: 12, procedures: 2 },
  { source: "Website", enquiries: 21, visits: 13, consultations: 11, procedures: 3 },
  { source: "Phone", enquiries: 32, visits: 24, consultations: 21, procedures: 3 },
] as const;

export const SERVICE_ROWS = [
  { service: "Cataract", enquiries: 52, advised: 14 },
  { service: "Oculoplasty", enquiries: 31, advised: 8 },
  { service: "Laser vision correction", enquiries: 27, advised: 7 },
  { service: "Squint", enquiries: 19, advised: 5 },
] as const;

export const DEMOGRAPHICS = [
  { dimension: "Age group", rows: [["18–30", 24], ["31–45", 38], ["46–60", 46], ["60+", 35]] },
  { dimension: "Area", rows: [["Whitefield", 33], ["Jayanagar", 28], ["HSR Layout", 24], ["Hebbal", 19]] },
  { dimension: "Gender", rows: [["Female", 78], ["Male", 65]] },
] as const;

export const TEAM_ROWS = [
  { name: "Shivani", enquiries: 48, followUps: "Up to date" },
  { name: "Deepa", enquiries: 41, followUps: "2 overdue" },
  { name: "Arun", enquiries: 35, followUps: "Up to date" },
] as const;

/** "What a lead report shows" vs what PulseOS shows. Illustrative data. */
export const ATTRIBUTION = [
  { source: "Google", leads: 40, appointments: 24, consultations: 18, procedures: 6 },
  { source: "Instagram", leads: 32, appointments: 12, consultations: 7, procedures: 1 },
  { source: "Website", leads: 18, appointments: 11, consultations: 9, procedures: 3 },
] as const;

export const SPREADSHEET = {
  columns: ["Name", "Phone", "Day 1", "Day 2", "Feedback Day 1", "Follow-up Date", "Final Feedback"],
  rows: [
    ["Savitha M.", "98xxx 10234", "Called", "Called", "No response", "—", "No response"],
    ["Ravi K.", "90xxx 55871", "Called", "—", "Call tomorrow", "07 Oct", "Booked"],
    ["Pooja N.", "97xxx 22418", "Called", "Called", "Interested", "08 Oct", "Visited"],
    ["Imran S.", "99xxx 70352", "Called", "—", "No response", "—", "—"],
    ["Latha R.", "88xxx 41096", "Called", "Called", "Call tomorrow", "09 Oct", "Booked"],
  ],
} as const;

export const OLD_WAY_TIMELINE = [
  { time: "10:12", title: "Enquiry · Google", detail: "Cataract · assigned to Shivani" },
  { time: "10:20", title: "Call connected", detail: "No response → call tomorrow 11:00 AM" },
  { time: "Next day", title: "Call connected", detail: "Interested → appointment booked" },
  { time: "Tue 10:30", title: "Visited", detail: "Consultation completed" },
  { time: "Tue 11:05", title: "Procedure advised", detail: "Next action: coordinator follow-up" },
] as const;

export const ROLES = [
  {
    key: "owner",
    tab: "Owner",
    headline: "See the hospital journey without chasing updates.",
    body: "From the source of an enquiry to the procedure that followed, on one screen.",
    points: ["Source → procedure, not just source → lead", "Services that turn into procedures", "Follow-ups that are overdue, and who owns them"],
  },
  {
    key: "frontdesk",
    tab: "Front desk",
    headline: "Run today's patient flow without paper queues.",
    body: "Everyone sees the same state for the same patient.",
    points: ["Check in puts the patient in the waiting queue", "Send to doctor in one tap", "No-shows surface for recovery"],
  },
  {
    key: "coordinator",
    tab: "Coordinator",
    headline: "Every patient has an owner. Every follow-up has a next action.",
    body: "Log the call, set the next step, book the appointment. In one place.",
    points: ["No answer → call tomorrow at 11 AM", "Book the appointment directly from the call", "The full history is one tap away"],
  },
  {
    key: "doctor",
    tab: "Doctor",
    headline: "Know who's next and why they're here.",
    body: "A clean planner of the patients coming to you. No marketing metrics, no charting.",
    points: ["Time, patient, service, status", "Waiting time at a glance", "Clinical notes stay in your EMR"],
  },
] as const;

export const FRONT_DESK_FLOW = ["Check in", "Waiting", "Send to doctor", "Consultation done"] as const;

export const FRONT_DESK_ROWS = [
  { time: "10:30", patient: "Anil Joshi", service: "Cataract consultation", status: "Waiting · 8 min", tone: "warning", next: "Send to doctor" },
  { time: "10:45", patient: "Zoya Khan", service: "Laser vision correction", status: "Confirmed", tone: "neutral", next: "Check in" },
  { time: "11:00", patient: "Pallavi Nayak", service: "Oculoplasty", status: "With doctor", tone: "primary", next: "" },
  { time: "09:30", patient: "Bhaskar Rao", service: "Cataract consultation", status: "Completed", tone: "success", next: "" },
] as const;

export const PLANNER_ROWS = [
  { time: "10:30 AM", patient: "Anil Joshi", service: "Cataract consultation", status: "Waiting · 8 min", tone: "warning" },
  { time: "10:45 AM", patient: "Zoya Khan", service: "Laser vision correction", status: "Confirmed", tone: "neutral" },
  { time: "11:15 AM", patient: "Harish Bhat", service: "Squint review", status: "Confirmed", tone: "neutral" },
  { time: "11:30 AM", patient: "Meera Pillai", service: "Oculoplasty", status: "Booked", tone: "neutral" },
  { time: "12:00 PM", patient: "Tanvi Shetty", service: "Cataract follow-up", status: "Booked", tone: "neutral" },
] as const;

export const CRM_FIELDS = [
  { key: "patientType", name: "Patient Type", detail: "New / existing patient", on: true, locked: false },
  { key: "area", name: "Area", detail: "Locality of the patient", on: true, locked: false },
  { key: "dob", name: "Date of Birth", detail: "Used for age group", on: false, locked: false },
  { key: "gender", name: "Gender", detail: "Used in who-is-enquiring", on: false, locked: false },
] as const;

export const FIRST_ENQUIRY_FIELDS = ["Phone", "Name", "New / existing", "Service", "Source"] as const;
export const LATER_FIELDS = ["UID", "Address", "PIN", "Area", "Service-specific details"] as const;

export const SYSTEM_ROLES = [
  { name: "Calling / IVR", great: "Receiving and routing calls.", adds: "What happened after the call." },
  { name: "General CRM", great: "Leads and sales tasks.", adds: "The hospital-specific patient workflow." },
  { name: "EMR / HMIS", great: "Clinical and hospital records.", adds: "The operational patient journey around care." },
] as const;

export const ARRIVAL = ["Meta", "Google", "Website", "Phone", "WhatsApp", "Walk-in", "Referral"] as const;
export const CORE = ["Enquiry", "Patient", "Calls", "Follow-ups", "Appointment", "Visit", "Consultation", "Treatment journey", "Analytics"] as const;
export const EXISTING_STACK = ["Calling / IVR", "EMR / HMIS", "Billing", "Clinical systems"] as const;

/** Integration states shown publicly. "Connected" is never used: a hospital connects its own providers. */
export type IntegrationState = "Works today" | "Integration-ready" | "On request";
export const INTEGRATIONS: { category: string; items: string; state: IntegrationState; note: string }[] = [
  { category: "Calling", items: "Manual Log Call, Runo", state: "Integration-ready", note: "Log a call by hand today. Call records and missed-call callbacks arrive when your hospital connects its calling provider." },
  { category: "Messaging", items: "WhatsApp Business", state: "Integration-ready", note: "Confirmations and reminders are planned in PulseOS and sent when your WhatsApp account is connected." },
  { category: "Website", items: "Website enquiry form", state: "Integration-ready", note: "A protected intake endpoint creates the patient and journey when your website posts to it." },
  { category: "Ads", items: "Google Ads, Meta Ads", state: "Integration-ready", note: "Read-only spend and campaign reporting. Provider conversions are never counted as PulseOS outcomes." },
  { category: "EMR / HMIS", items: "Your existing system", state: "On request", note: "PulseOS works alongside your EMR. Integration depends on what your system supports." },
  { category: "Walk-in & referral", items: "Add Lead", state: "Works today", note: "Enter walk-ins and referrals in seconds with the source attached." },
];

export const PROOF = [
  "One patient. Multiple journeys.",
  "Role-based workflows for owner, front desk, coordinator and doctor.",
  "Hospital-configurable intake.",
  "Source-to-procedure visibility.",
  "Built around real front-desk workflows.",
] as const;

export const SECURITY_POINTS = [
  { title: "Role-based access", body: "Each role sees what it is allowed to. Permissions are enforced on the server, not just hidden on screen." },
  { title: "Separate hospital data", body: "Every hospital's workspace is kept apart, and access always comes from the signed-in session." },
  { title: "Secure sessions", body: "Passwords are stored as one-way hashes. Sign-in uses secure, server-managed session cookies." },
  { title: "Protected credentials", body: "Provider keys live on the server and are never shown back in the browser. Sensitive changes are logged." },
] as const;

export const FAQ = [
  { q: "Do we have to replace our EMR or HMIS?", a: "No. PulseOS handles the patient engagement and operational journey around your clinical systems. Prescriptions, investigations, clinical notes and billing stay where they are." },
  { q: "Does it work with WhatsApp and our calling provider?", a: "You can log every call and enquiry by hand from day one. WhatsApp confirmations and reminders, and call records from a calling provider, switch on when your hospital connects its own accounts." },
  { q: "Can we change what the front desk has to fill in?", a: "Yes. Choose which fields appear on Add Lead, which are required and which can be used as filters. Services, lead sources and clinic hours are yours to set." },
  { q: "Who can see what?", a: "Owners and admins see performance. Coordinators see their follow-ups and journeys. Front desk sees the day's patient flow. Doctors see their planner. This is enforced on the server." },
  { q: "Is PulseOS a clinical record system?", a: "No, and it does not try to be. It is the operational layer: enquiry, call, follow-up, appointment, visit, consultation outcome and treatment follow-up." },
] as const;
