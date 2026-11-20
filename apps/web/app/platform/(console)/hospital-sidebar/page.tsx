"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, platformApi } from "@pulseos/api-client";
import type { HospitalSidebarLayout, PlatformHospital, PlatformHospitalSidebar } from "@pulseos/types";
import { buttonClass, Failure, inputClass, Loading, PageControls, PageTitle, secondaryClass, usePlatformAccount, usePlatformQuery } from "../platform-ui";

export default function HospitalSidebarPage() {
  const account = usePlatformAccount();
  if (account.isPending) return <Loading />;
  if (account.data?.role !== "PLATFORM_SUPER_ADMIN") return <p>Platform Super Admin access is required.</p>;
  return <HospitalSidebarManagement />;
}

function HospitalSidebarManagement() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [hospital, setHospital] = useState<PlatformHospital | null>(null);
  const directory = usePlatformQuery(["sidebar-hospitals", String(page), search], () => platformApi.hospitals(page, search));

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearch(String(new FormData(event.currentTarget).get("search") ?? "").trim());
  }

  return <>
    <PageTitle title="Hospital Sidebar" />
    <div className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
      <section className="space-y-4 rounded-xl border border-primary-100 bg-white p-4">
        <form role="search" onSubmit={applySearch} className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-sm font-medium">Hospital name or slug
            <input name="search" type="search" maxLength={120} className={inputClass} />
          </label>
          <button className={secondaryClass}>Search</button>
        </form>
        {directory.isPending && <Loading />}
        {directory.isError && <Failure error={directory.error} />}
        {directory.data?.items.every((item) => !item.tenantId) && <p className="text-sm">No provisioned hospitals found on this page.</p>}
        <ul className="space-y-1">
          {directory.data?.items.filter((item) => item.tenantId).map((item) => <li key={item.id}>
            <button type="button" aria-pressed={hospital?.id === item.id} onClick={() => setHospital(item)}
              className="block w-full rounded-control px-3 py-2 text-left text-sm aria-pressed:bg-primary-100 hover:bg-primary-50">
              <span className="block font-semibold">{item.name ?? item.slug ?? "Hospital"}</span>
              {item.slug && <span className="text-neutral-600">{item.slug}</span>}
            </button>
          </li>)}
        </ul>
        <PageControls page={page} hasMore={directory.data?.hasMore ?? false} onPage={setPage} />
      </section>
      {hospital ? <HospitalSidebarSettings key={hospital.id} hospital={hospital} /> :
        <p className="rounded-xl border border-primary-100 bg-white p-4 text-sm">Select a hospital to manage its sidebar.</p>}
    </div>
  </>;
}

function HospitalSidebarSettings({ hospital }: { hospital: PlatformHospital }) {
  const legacy = hospital.onboardingId === null;
  const cache = useQueryClient();
  const key = ["hospital-sidebar", hospital.id, String(legacy)];
  const query = usePlatformQuery(key, () => platformApi.hospitalSidebar(hospital.id, legacy));
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failure error={query.error} />;
  return <SidebarEditor hospital={hospital} config={query.data}
    save={async (paths) => {
      const updated = await platformApi.updateHospitalSidebar(hospital.id, legacy, paths);
      cache.setQueryData(["platform", ...key], updated);
    }} />;
}

function move<T>(items: T[], index: number, offset: number): T[] {
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(index + offset, 0, item!);
  return next;
}

function OrderButtons({ label, index, size, onMove }: {
  label: string; index: number; size: number; onMove: (offset: number) => void;
}) {
  return <div className="flex shrink-0 gap-1">
    <button type="button" className={secondaryClass} aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
    <button type="button" className={secondaryClass} aria-label={`Move ${label} down`} disabled={index === size - 1} onClick={() => onMove(1)}>↓</button>
  </div>;
}

function SidebarEditor({ hospital, config, save }: {
  hospital: PlatformHospital; config: PlatformHospitalSidebar;
  save: (layout: HospitalSidebarLayout | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ layout: HospitalSidebarLayout | null } | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<unknown>();
  const catalog = config.groups.flatMap((group) => group.items.map(({ href, label }) => ({ href, label })));
  const defaultLayout = config.groups.map(({ label, items }) => ({ label, links: items.map(({ href, label }) => ({ href, label })) }));
  const savedLayout = config.layout ?? (config.paths ? defaultLayout.map(({ label, links }) => ({
    label, links: links.filter(({ href }) => config.paths!.includes(href)),
  })).filter((group) => group.links.length > 0) : null);
  const layout = draft ? draft.layout : savedLayout;
  const used = new Set(layout?.flatMap((group) => group.links.map((link) => link.href)));
  const unused = catalog.filter(({ href }) => !used.has(href));
  const names = layout?.map(({ label }) => label.trim().toLowerCase()) ?? [];
  const validation = layout && (!used.size ? "Add at least one navigation link." :
    names.some((name) => !name) || new Set(names).size !== names.length ? "Use a unique name for each group." :
    layout.some(({ links }) => links.some(({ label }) => !label.trim())) ? "Enter a label for each link." :
    [...used].some((href) => !catalog.some((item) => item.href === href)) ? "Remove links marked unavailable before saving." : "");

  function editGroup(index: number, group: HospitalSidebarLayout[number]) {
    setDraft({ layout: layout!.map((item, position) => position === index ? group : item) });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || working || validation) return;
    setWorking(true);
    setError(undefined);
    setMessage("");
    try {
      await save(layout);
      setDraft(null);
      setMessage("Hospital sidebar saved.");
    } catch (failure) {
      setError(failure);
    } finally {
      setWorking(false);
    }
  }

  return <form onSubmit={submit} className="min-w-0 space-y-4 rounded-xl border border-primary-100 bg-white p-5">
    <h2 className="text-lg font-semibold">{hospital.name ?? hospital.slug ?? "Hospital"} sidebar</h2>
    <p className="text-sm text-neutral-600">Arrange groups and links for this hospital. Users see only the links available to their role and edition.</p>
    <fieldset disabled={working} className="space-y-4">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={layout === null} onChange={(event) => setDraft({ layout: event.target.checked ? null : savedLayout ?? defaultLayout })} />
        Use default sidebar
      </label>
      {layout && <div className="space-y-4">
        {layout.map((group, index) => <fieldset key={index} className="space-y-3 rounded-control border border-primary-100 px-3 pb-3">
          <legend className="px-1 text-sm font-semibold">{group.label || "Untitled group"}</legend>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-36 flex-1 text-sm">Group name
              <input className={inputClass} value={group.label} maxLength={60} onChange={(event) => editGroup(index, { ...group, label: event.target.value })} />
            </label>
            <OrderButtons label={group.label} index={index} size={layout.length} onMove={(offset) => setDraft({ layout: move(layout, index, offset) })} />
            <button type="button" className={secondaryClass} aria-label={`Remove group ${group.label}`}
              onClick={() => setDraft({ layout: layout.filter((_, position) => position !== index) })}>Remove group</button>
          </div>
          {group.links.map((link, position) => <div key={link.href} className="flex flex-wrap items-end gap-2">
            <label className="min-w-36 flex-1 text-sm">{link.href}{!catalog.some((item) => item.href === link.href) && " (unavailable)"}
              <input className={inputClass} aria-label={`Label for ${link.href}`} value={link.label} maxLength={60} onChange={(event) =>
                editGroup(index, { ...group, links: group.links.map((item) => item.href === link.href ? { ...item, label: event.target.value } : item) })} />
            </label>
            <OrderButtons label={link.label} index={position} size={group.links.length}
              onMove={(offset) => editGroup(index, { ...group, links: move(group.links, position, offset) })} />
            <button type="button" className={secondaryClass} aria-label={`Remove link ${link.label}`}
              onClick={() => editGroup(index, { ...group, links: group.links.filter((item) => item.href !== link.href) })}>Remove</button>
          </div>)}
          <label className="block text-sm">Add navigation link
            <select className={inputClass} value="" disabled={!unused.length} onChange={(event) => {
              const link = unused.find(({ href }) => href === event.target.value);
              if (link) editGroup(index, { ...group, links: [...group.links, link] });
            }}>
              <option value="">{unused.length ? "Choose a PulseOS page" : "All available pages are already in the layout"}</option>
              {unused.map(({ href, label }) => <option key={href} value={href}>{label} ({href})</option>)}
            </select>
          </label>
        </fieldset>)}
        <button type="button" className={secondaryClass} disabled={layout.length >= 20} onClick={() => {
          let number = 1;
          while (names.includes(`new group ${number}`)) number++;
          setDraft({ layout: [...layout, { label: `New group ${number}`, links: [] }] });
        }}>Add group</button>
      </div>}
    </fieldset>
    {validation && <p className="text-sm text-red-700">{validation}</p>}
    {error instanceof ApiError && error.message === "invalid_sidebar" ?
      <p className="text-sm text-red-700" role="alert">Some selected links are no longer available. Refresh and review the selection.</p> :
      Boolean(error) && <Failure error={error} />}
    {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}
    <button type="submit" className={buttonClass} disabled={working || !draft || Boolean(validation)}>
      {working ? "Saving…" : "Save sidebar"}
    </button>
  </form>;
}
