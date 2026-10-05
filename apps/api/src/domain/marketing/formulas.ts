/**
 * Attribution MVP formulas — see docs/superpowers/specs/2026-09-12-pulseos-marketing-journey-northstar.md.
 * Every function guards its denominator: a zero/undefined denominator returns
 * `null` (rendered as "—" in the UI), never `Infinity` or `NaN`.
 */

export function costPer(spendAmount: number, outcomeCount: number): number | null {
  if (outcomeCount <= 0) return null;
  return spendAmount / outcomeCount;
}

export function roas(attributedRevenue: number, spendAmount: number): number | null {
  if (spendAmount <= 0) return null;
  return attributedRevenue / spendAmount;
}

/**
 * A journey's allocated acquisition cost, for Spend-At-Risk reporting:
 * the campaign's own average cost-per-enquiry (spend / enquiries),
 * applied to each enquiry acquired through that campaign.
 * This is a transparent approximation, not formal cost accounting.
 */
export function allocatedAcquisitionCost(campaignSpend: number, campaignEnquiryCount: number): number | null {
  return costPer(campaignSpend, campaignEnquiryCount);
}
