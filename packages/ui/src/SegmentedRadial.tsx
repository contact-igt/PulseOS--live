import { Card, SectionHeading } from "./primitives";

export interface RadialSegment {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
}

export function SegmentedRadial({
  title,
  subtitle,
  segments,
  centerLabel,
  centerValue,
  onSegmentClick,
  testId,
}: {
  title: string;
  subtitle?: string;
  segments: RadialSegment[];
  centerLabel: string;
  centerValue: string;
  onSegmentClick?: (key: string) => void;
  testId?: string;
}) {
  const size = 220;
  const center = size / 2;
  const strokeWidth = 11;
  const gap = 3;
  const outerRadius = 92;

  // Center label geometry, computed rather than eyeballed: two SVG text
  // lines (value + label), each vertically centered on its own baseline via
  // dominant-baseline="central", stacked and centered as a block around the
  // ring's true (cx, cy). No magic per-pixel y offsets to retune by eye.
  const valueFontSize = 26;
  const labelFontSize = 11;
  const lineGap = 4;
  const blockHeight = valueFontSize + lineGap + labelFontSize;
  const valueY = center - blockHeight / 2 + valueFontSize / 2;
  const labelY = center - blockHeight / 2 + valueFontSize + lineGap + labelFontSize / 2;

  return (
    <Card className="@container p-4" data-testid={testId}>
      <SectionHeading title={title} subtitle={subtitle} />
      {/* @container query, not a viewport (sm:) breakpoint — this panel can
          sit in a narrow grid column (e.g. Command Centre's 4/12 slot at
          1024px) where the viewport is wide but the card itself isn't, which
          a viewport breakpoint can't see. Side-by-side only once the card has
          enough width for the legend to stay readable (170px svg + ~170px
          legend + gap); otherwise stacked, where the legend gets the full
          card width instead of truncating. */}
      <div className="flex min-w-0 flex-col items-center gap-4 @[360px]:flex-row @[360px]:items-start @[360px]:gap-6">
        {/* CSS controls the rendered box (aspect-square + a max-width cap,
            allowed to shrink below that in a tight flex row); viewBox stays
            fixed at the original 220-unit coordinate system so every radius/
            text-position computed above keeps working unchanged — the SVG
            just scales its whole content to fit, same technique as a
            responsive <img>. This is what actually avoids collision at
            1024px, where a hardcoded 220px box didn't leave the legend any
            room at all. */}
        <svg viewBox={`0 0 ${size} ${size}`} className="aspect-square w-full max-w-[170px] shrink" role="img" aria-label={`${centerLabel}: ${centerValue}`}>
          {segments.map((seg, idx) => {
            const radius = outerRadius - idx * (strokeWidth + gap);
            const circumference = 2 * Math.PI * radius;
            const filled = (Math.min(seg.pct, 100) / 100) * circumference;
            return (
              <g key={seg.key}>
                <title>{`${seg.label}: ${seg.count} (${seg.pct}%)`}</title>
                <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--color-neutral-100)" strokeWidth={strokeWidth} />
                {/* A round-linecap circle with a zero-length dash still paints
                    a dot at the start point — skip the progress arc entirely
                    at 0% rather than let a segment with no share of the ring
                    show up as a colored mark on it. */}
                {filled > 0 && (
                  <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={seg.color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${filled} ${circumference - filled}`}
                    strokeLinecap="round"
                    transform={`rotate(-90 ${center} ${center})`}
                    className={onSegmentClick ? "cursor-pointer transition-opacity hover:opacity-80" : undefined}
                    onClick={() => onSegmentClick?.(seg.key)}
                  />
                )}
              </g>
            );
          })}
          <text x={center} y={valueY} textAnchor="middle" dominantBaseline="central" className="fill-slate-900 font-semibold" style={{ fontSize: valueFontSize, fontWeight: 600 }}>
            {centerValue}
          </text>
          <text x={center} y={labelY} textAnchor="middle" dominantBaseline="central" style={{ fontSize: labelFontSize, fill: "var(--color-neutral-500)" }}>
            {centerLabel}
          </text>
        </svg>

        {/* w-full (not just flex-1) so the list keeps the card's full
            content width in stacked mode too — items-center on the parent
            centers flex children by their own box, and without an explicit
            width the <ul> shrinks to its content, which visually centers
            every legend row under the donut instead of the plain
            left-aligned list this is meant to read as. */}
        <ul className="w-full min-w-[140px] flex-1 space-y-1.5">
          {segments.map((seg) => (
            <li key={seg.key}>
              <button
                type="button"
                onClick={() => onSegmentClick?.(seg.key)}
                title={`${seg.label}: ${seg.count} (${seg.pct}%)`}
                className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-neutral-50"
                data-testid={`radial-segment-${seg.key}`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: seg.color }} />
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-600">{seg.label}</span>
                <span className="w-7 shrink-0 text-right text-xs tabular-nums text-slate-700">{seg.count}</span>
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-neutral-400">{seg.pct}%</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
