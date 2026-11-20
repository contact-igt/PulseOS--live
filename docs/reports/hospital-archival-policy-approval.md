# Hospital archival policy approval package

**Implementation readiness — BLOCKED BY POLICY.** Every decision below is pending. This package proposes requirements for future implementation.

## Verified in the checkout

| Capability | Source finding |
| --- | --- |
| Assessment endpoint | `hospital-lifecycle.routes.ts` registers GET `/platform/hospitals/:id/archival-assessment`, requires lifecycle read permission and a Platform Super Admin browser account, and returns `Cache-Control: no-store`. The existing Platform guard checks the session and browser origin boundary. |
| Hospital identity | `targetTenant` resolves onboarding UUIDs to the canonical tenant UUID. The explicit legacy path accepts a tenant UUID only for hospitals without an onboarding mapping. Unresolved targets return 404. |
| Snapshot and aggregates | `hospital-archival-assessment.service.ts` resolves the target and reads evidence in one PostgreSQL repeatable-read, read-only transaction. It counts nonterminal appointments, tasks, notifications, deliveries, coordination commands, integration events, held leads and selected ad and call work. Child queries with separate connector, call or webhook ownership check both sides. |
| Sanitization and evidence limits | The response projects states, timestamps, counts, classifications and a revenue-existence flag. It omits patient records, provider identifiers, credentials and amounts. Local counts cannot establish clinical handover, external queue emptiness, financial clearance or legal-hold status. |
| WhatsNexus observations | Verified, schema-valid observations are matched to the current LIVE binding and lifecycle version when coordination is enabled. Historical observations suppress permit counts. Even a matching observation is point-in-time evidence. The endpoint makes no live provider request. |
| Lifecycle and audit | Migration 0052 accepts PROVISIONING, ACTIVE, SUSPENDED and ARCHIVED. The lifecycle service executes suspend and operational restore under tenant-row locking and expected-version checks. It audits outcomes, revokes hospital sessions on suspension and checks administrator readiness on restore. ARCHIVED support in the schema confers no archive or archive-restoration authority. |
| MFA precedent | Platform administrator recovery has an existing fresh-TOTP authorization path. Archive approval has no corresponding route or grant today. |

The earlier read-only delivery reported 22 passing local tests. This documentation pass verified source and did not rerun the suites.

## Policy decisions for sign-off

Record each signed decision with the approver, effective policy version, evidence references, and any approved exception scope. The functions listed below are proposed approval owners.

| Decision | Proposed rule | Required evidence | Approval function | Operational consequence | Missing evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Eligible states | Only SUSPENDED can enter archive review. | Canonical tenant UUID, state and lifecycle version. | Platform governance and hospital operations | Keep the hospital suspended throughout review. | Reject submission or invalidate review. | PENDING |
| Clinical continuity | Clinical leadership certifies handover and a designated records custodian. | Signed continuity plan, receiving ownership, and escalation path for unresolved episodes. | Hospital clinical leadership and records custodian | Block archive until responsibilities are accepted. | Block execution. | PENDING |
| Appointments and transfers | Disposition each open appointment or transfer through its existing authorized workflow. | Reconciled appointment inventory and handover acknowledgements maintained in the clinical source system. | Scheduling operations and clinical leadership | Keep active obligations visible and assigned. | Block execution. | PENDING |
| Jobs and outboxes | Freeze new ordinary work and safely drain, cancel through approved paths, or quarantine outstanding work with an owner. | Worker and outbox inventories, queue evidence and disposition references. | Job owners and release operations | Preserve payloads and retry identities. Prevent replay on restoration. | Block execution. | PENDING |
| WhatsNexus | Require authoritative matching PAUSED with zero unresolved permits for a paired hospital, or documented and independently verified lack of an applicable sender. | Live approved verification scoped to the exact hospital, binding revision, provider version and verification time. Approve a freshness window separately. | Messaging operations and security | Preserve permits and provider references. Use no automatic fencing. | Block execution for missing, stale, mismatched or unresolved evidence. | PENDING |
| Integration shutdown | Prevent new intake and ordinary submission. Allow authenticated receipt-only processing for known work on explicitly approved paths. | Per-connector shutdown checklist, callback tests, retained correlation keys and independent sender-isolation evidence where applicable. | Integration owners, security and operations | Preserve events and process approved callbacks without opening new work. | Block execution. | PENDING |
| Finance | Reconcile known obligations and retain audit and provider references without triggering settlement from archival. | Finance sign-off against source ledgers, open obligations, invoices and external settlement evidence where applicable. | Finance controller and integration finance owners | Preserve historical evidence and existing reconciliation authority. | Block execution. | PENDING |
| Historical access | Grant purpose-bound, tenant-scoped read access by data class. | Approved role matrix, request and audit design, and negative isolation tests. | Privacy, security and records custodians | Permit only approved access paths. | Deny affected access. Block execution if required access is unavailable. | PENDING |
| Restoration | Independently approve ARCHIVED → SUSPENDED. Use the existing separately authorized path for ACTIVE. | Current administrator, clinical, integration, permission and credential readiness. | Platform governance, hospital operations and security | Recovery preserves identities and starts no external sender or old job. | Keep the current lifecycle state. | PENDING |
| Retention, holds and disposal | Approve data-class schedules and legal-hold precedence separately. Disposal requires its own authorization and implementation review. | Approved schedule and triggers, authoritative hold source and owner, release and disposal procedure, backup implications. | Legal, privacy, records management and compliance | Preserve clinical, audit, financial and integration evidence. Apply holds before any future disposition. | Preserve records, prohibit disposal and block archive execution if hold obligations cannot be verified. | PENDING |

## Archive request, review and execution

1. **Request.** A specifically authorized Platform browser actor submits the canonical hospital, expected lifecycle version, reason and references to protected evidence. The hospital stays SUSPENDED. Use a stable request UUID and permit at most one open archive request per hospital. Identical replay returns the existing request. Changed payload under the same identity conflicts.
2. **Approve.** A separately authorized actor reviews the request under fresh MFA. Bind step-up evidence to the actor, browser session, tenant, request, version and purpose. Never store raw TOTP codes. Reject self-approval, stale or replayed step-up evidence, and disabled or demoted actors. Record approvals, rejections and expirations alongside the policy and evidence versions.
3. **Execute.** An explicitly authorized execution step revalidates current authority, lifecycle version, evidence freshness and every blocker. Establish a verified admission barrier for ordinary work before relying on an empty queue. Collect remote evidence outside the database transaction and bind it to the current pairing and provider version. If evidence changes, expires or cannot be rechecked safely, keep SUSPENDED and require renewed review. Under a tenant-row lock, atomically apply ARCHIVED, increment the version, keep login disabled, revoke residual sessions and write the terminal request and audit event. Repeated execution returns the committed outcome.
4. **After execution.** Block ordinary hospital writes, new sessions and stale work at API, integration ingress and worker admission boundaries. Permit only explicitly approved historical reads and authenticated receipt-only updates scoped to original provider identities. Never delete clinical or financial records, settle funds, or fence external permits from this workflow.

## Restoration

Use a separately authorized request, independent reviewer and fresh MFA for ARCHIVED → SUSPENDED. Recheck the account and lifecycle version, branch-bound administrator and current permissions, clinical owner and access plan, integration pairing and safe connector posture, and credential validity. Preserve the hospital UUID, historical relationships, audit, external references and evidence. Keep login disabled in SUSPENDED. The existing operational restore path separately authorizes ACTIVE after current readiness checks. WhatsNexus resume requires its own authorization. Existing jobs, invitations and notifications do not replay as part of archive restoration.

## Historical access security

| Data | Proposed authorization and controls |
| --- | --- |
| Hospital metadata | Approved Platform role, scoped to canonical hospital and minimum fields. |
| Patient and clinical records | Separately approved clinical or records-custodian permission, case purpose and audited read access. No general Platform visibility. |
| Communications and media | Separate purpose-bound permission. Verify tenant ownership through the full record and attachment chain before issuing short-lived object access. |
| Financial records | Finance permission and tenant scope. Exclude payment credentials and unrelated tenant records. |
| Audit events | Audit permission, tenant scope, redaction and protected append-only history. |
| Exports | Separate approval with defined scope, recipient and expiry. Audit generation and retrieval, and verify each record's tenant ownership. |
| Legal holds | Access restricted to legal and records custodians. Give operational reviewers only the disposition signal required to prevent unsafe action. |

Deny access by default, including direct-object and export routes. Record actor, hospital, purpose, access category and outcome without recording private content. Historical clinical access requires separate approval before implementation.

## Proposed additive database and API changes

- Reuse ARCHIVED and the existing tenant UUID and version. If approved, add a durable lifecycle request table for archive and archive restoration with actor references, state, deadlines, expected version, policy version and sanitized evidence references. Add a partial unique index for one open request per hospital and a tenant-scoped idempotency constraint.
- Add request audit events or extend existing audit conventions with request identity, transition and reason codes. Preserve existing audit and lifecycle rows. Add dedicated request, review and execution permissions only after approval.
- Propose hospital-scoped POST request, review and execute endpoints, and GET request and history endpoints under the current Platform hospital namespace. Reuse canonical resolution, browser session, CSRF, server-side MFA and authorization checks. Historical read and export APIs require separate policy approval. No migration or endpoint in this section was executed or added.

## Acceptance and rollout

| Scenario | Required evidence |
| --- | --- |
| Authorization and MFA | Hospital user, operator credential, insufficient role, self-approval, stale MFA, replay, and post-approval demotion are denied and audited. |
| Conflicting requests and version races | Concurrent requests converge on one open request. Same UUID with altered payload conflicts. Concurrent lifecycle change invalidates stale approval with no partial transition. |
| Clinical and appointment obligations | Open, transferred and resolved fixtures demonstrate that execution depends on authoritative dispositions and current clinical sign-off. |
| Provider state and permits | Missing, historical, mismatched, PAUSING or nonzero permit evidence blocks execution. Pairing rotation invalidates prior evidence. A verified matching PAUSED result with zero permits satisfies only this gate. |
| Webhooks and background work | Inject new work at the execution boundary. Admission blocks ordinary work while authenticated callbacks for original identities preserve references without new work or duplicate effects. |
| Finance and legal holds | Missing sign-off or unknown hold disposition blocks. Accepted archival preserves ledger and hold evidence and performs no settlement or disposal. |
| Historical read isolation | Verify cross-tenant denial through IDs, joins, attachments, exports and audit paths. Confirm approved reads are audited with minimal disclosure. |
| Restoration | Revalidate current readiness and independent approval. First transition lands in SUSPENDED. Separate activation leaves WhatsNexus and old work untouched. |
| Worker restart | Restart between request, approval and execution boundaries. Preserve the approved version and request identity. Stale work stays blocked and committed results replay without a second transition. |
| Rollback with archived hospitals | Rehearse rollback with open requests and archived records. Preserve states, history, snapshots and external correlations. Keep archive-aware ingress and worker admission enforced throughout rollback. |

**Staging gate.** Approve the policy register before implementation. Then apply proposed migrations only to disposable environments and pass the acceptance matrix with synthetic hospitals, real staging workers where applicable, controlled provider evidence, and a documented rollback rehearsal. Record evidence and owner sign-off for clinical continuity, finance, legal holds, security and integration safety.

**Production gate.** Require signed policy and staging evidence, approved change authorization, version-compatible worker and ingress rollout, verified backup and rollback, and named audit and alert owners. Keep execution disabled until separately authorized. Retention automation and disposal require separate approval.
