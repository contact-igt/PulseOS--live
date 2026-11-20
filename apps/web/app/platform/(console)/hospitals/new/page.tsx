"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, platformApi } from "@pulseos/api-client";
import { SIGNUP_DEPARTMENTS, SIGNUP_EDITIONS, SIGNUP_INDUSTRIES, SIGNUP_ORGANIZATION_TYPES, type HospitalCreationInput } from "@pulseos/types";
import { buttonClass, Failure, inputClass, PageTitle, panelClass, usePlatformAccount } from "../../platform-ui";

type Field = {
  name: keyof HospitalCreationInput;
  label: string;
  options?: readonly string[];
  optional?: boolean;
  type?: string;
  min?: number;
  max?: number;
  pattern?: string;
  initial?: string;
};

const fields: Field[] = [
  { name: "organizationName", label: "Hospital name", min: 2, max: 120 },
  { name: "industry", label: "Industry", options: SIGNUP_INDUSTRIES, initial: "Healthcare" },
  { name: "organizationType", label: "Organization type", options: SIGNUP_ORGANIZATION_TYPES },
  { name: "department", label: "Department", options: SIGNUP_DEPARTMENTS },
  { name: "edition", label: "Edition", options: SIGNUP_EDITIONS, initial: "V1" },
  { name: "fullName", label: "First administrator name", min: 2, max: 80 },
  { name: "email", label: "First administrator email", type: "email", max: 254 },
  { name: "phone", label: "First administrator phone", type: "tel", min: 6, max: 24 },
  { name: "addressLine", label: "Address", min: 3, max: 160 },
  { name: "locality", label: "Locality", optional: true, max: 80 },
  { name: "city", label: "City", min: 2, max: 80 },
  { name: "state", label: "State", min: 2, max: 80 },
  { name: "pinCode", label: "PIN code", pattern: "[0-9]{6}", max: 6 },
  { name: "country", label: "Country", min: 2, max: 60, initial: "India" },
  { name: "discoveryNotes", label: "Discovery notes", optional: true, max: 300 },
];

type Attempt = { key: string; payload: HospitalCreationInput };

export default function NewHospital() {
  const router = useRouter();
  const cache = useQueryClient();
  const account = usePlatformAccount();
  const attempt = useRef<Attempt | null>(null);
  const inFlight = useRef(false);
  const [industry, setIndustry] = useState("Healthcare");
  const [working, setWorking] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>();
  const [issues, setIssues] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict) return;
    if (!attempt.current) {
      const entries = [...new FormData(event.currentTarget)].map(([key, value]) => [key, String(value).trim()]).filter(([, value]) => value);
      attempt.current = {
        key: crypto.randomUUID(),
        payload: { ...Object.fromEntries(entries), discoverySource: "Other" } as HospitalCreationInput,
      };
      setRequestId(attempt.current.key);
    }
    const { key, payload } = attempt.current;
    setError(undefined);
    setIssues({});
    inFlight.current = true;
    setWorking(true);
    try {
      const result = await platformApi.create(payload, key);
      void cache.invalidateQueries({ queryKey: ["platform"] });
      router.replace("/platform/hospitals/" + result.id);
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiError) {
        const byField = Object.fromEntries(failure.issues.map(({ path, message }) => [path, message]));
        if (failure.message === "invalid_phone") byField.phone = "Enter a valid phone number.";
        if (failure.message === "email_in_use") byField.email = "This email belongs to an existing account.";
        setIssues(byField);
        if (failure.status === 409 && failure.message === "idempotency_conflict") setConflict(true);
        else if (failure.status === 400 || failure.message === "email_in_use") {
          // A definitive validation rejection allows corrected input as a new operation.
          attempt.current = null;
          setRequestId(null);
        }
      }
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  if (!account.data?.permissions.includes("hospital:create")) return <p role="alert">Your platform account cannot create hospitals.</p>;

  return <>
    <PageTitle title="Create hospital" />
    <form onSubmit={submit} className={panelClass}>
      <fieldset disabled={Boolean(requestId)} className="grid gap-4 disabled:opacity-70 sm:grid-cols-2">
        <legend className="mb-4 font-semibold">Hospital and first administrator</legend>
        {fields.filter((field) => industry === "Healthcare" || !["organizationType", "department"].includes(field.name)).map((field) => {
          const issue = issues[field.name];
          const props = { id: field.name, name: field.name, required: !field.optional, className: inputClass, defaultValue: field.initial,
            "aria-invalid": Boolean(issue), "aria-describedby": issue ? field.name + "-error" : undefined };
          return <div key={field.name}>
            <label htmlFor={field.name} className="block text-sm font-medium">{field.label}</label>
            {field.options ? <select {...props} onChange={field.name === "industry" ? (event) => setIndustry(event.target.value) : undefined}>
              <option value="">Select {field.label.toLowerCase()}</option>
              {field.options.map((option) => <option key={option}>{option}</option>)}
            </select> : <input {...props} type={field.type ?? "text"} minLength={field.min} maxLength={field.max} pattern={field.pattern} />}
            {issue && <p id={field.name + "-error"} className="text-sm text-red-700">{issue}</p>}
          </div>;
        })}
      </fieldset>
      <div className="mt-5 space-y-3">
        {error !== undefined && <Failure error={error} />}
        {requestId && error !== undefined && <p className="text-sm">
          {conflict ? "Review the onboarding record for this request." : "Retry from this page to reuse the original request ID and details."}{" "}
          <Link className="text-primary-700 underline" href={"/platform/hospitals/" + requestId}>Check onboarding status</Link>
        </p>}
        <button type="submit" className={buttonClass} disabled={working || conflict}>{working ? "Submitting…" : requestId ? "Retry same request" : "Create hospital"}</button>
      </div>
    </form>
  </>;
}
