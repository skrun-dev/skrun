// Design system primitives — from Claude Design handoff.
// Neutral-forward system: primary CTA is ink (gray-900), sky reserved for links/brand marks.

import type { ReactNode } from "react";

// ── Btn ──────────────────────────────────────────────────────────────

type BtnVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
type BtnSize = "sm" | "md" | "lg";

const btnVariants: Record<BtnVariant, string> = {
  primary:
    "bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.12)] dark:shadow-[inset_0_1px_0_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.3)]",
  accent:
    "bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.12)] dark:shadow-[inset_0_1px_0_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.3)]",
  secondary:
    "bg-white dark:bg-gray-900/60 text-gray-800 dark:text-gray-200 border border-gray-200/80 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_1px_2px_rgba(0,0,0,0.2)]",
  ghost:
    "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900 hover:text-gray-900 dark:hover:text-gray-100 border border-transparent",
  danger:
    "border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-400 bg-red-50/40 dark:bg-red-950/20 hover:bg-red-50 dark:hover:bg-red-950/40",
};

const btnSizes: Record<BtnSize, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
  md: "h-8 px-2.5 text-[12.5px] gap-1.5 rounded-md",
  lg: "h-9 px-3 text-[13px] gap-1.5 rounded-md",
};

const btnIconTones: Record<BtnVariant, string> = {
  primary: "text-white/70 dark:text-gray-900/60",
  accent: "text-white/70 dark:text-gray-900/60",
  secondary: "text-gray-400 dark:text-gray-500",
  ghost: "text-gray-400 dark:text-gray-500",
  danger: "text-red-500/80",
};

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: ReactNode;
}

export function Btn({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center font-medium transition-[background-color,border-color,box-shadow] duration-150 ${btnVariants[variant]} ${btnSizes[size]} ${className}`}
    >
      {icon && (
        <span
          className={`inline-flex items-center ${btnIconTones[variant]} [&>svg]:w-3 [&>svg]:h-3`}
        >
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}

// ── Pill ─────────────────────────────────────────────────────────────

type PillTone = "neutral" | "sky" | "emerald" | "amber" | "red" | "violet";

const pillTones: Record<PillTone, string> = {
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400",
  sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300 ring-1 ring-sky-100 dark:ring-sky-900/50",
  emerald:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 ring-1 ring-emerald-100 dark:ring-emerald-900/40",
  amber:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 ring-1 ring-amber-100 dark:ring-amber-900/40",
  red: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400 ring-1 ring-red-100 dark:ring-red-900/40",
  violet:
    "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300 ring-1 ring-violet-100 dark:ring-violet-900/40",
};

const pillDotColors: Record<PillTone, string> = {
  neutral: "bg-gray-400",
  sky: "bg-sky-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  violet: "bg-violet-500",
};

interface PillProps {
  tone?: PillTone;
  dot?: boolean;
  children: ReactNode;
}

export function Pill({ tone = "neutral", dot = false, children }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10.5px] font-medium ${pillTones[tone]}`}
    >
      {dot && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${pillDotColors[tone]} ${tone === "amber" ? "animate-pulse" : ""}`}
        />
      )}
      {children}
    </span>
  );
}

// ── StatusPill ───────────────────────────────────────────────────────

const statusToneMap: Record<string, PillTone> = {
  completed: "emerald",
  failed: "red",
  running: "amber",
  cancelled: "neutral",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={statusToneMap[status] ?? "neutral"} dot>
      {status}
    </Pill>
  );
}

// ── StatusDot ────────────────────────────────────────────────────────

const statusDotColors: Record<string, string> = {
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  running: "bg-amber-500 animate-pulse",
  cancelled: "bg-gray-400",
};

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotColors[status] ?? "bg-gray-400"}`}
    />
  );
}

// ── Card ─────────────────────────────────────────────────────────────

interface CardProps {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  pad?: boolean;
}

export function Card({ title, action, children, className = "", pad = true }: CardProps) {
  return (
    <div
      className={`rounded-lg border border-gray-200 dark:border-gray-900 bg-white dark:bg-gray-950/40 ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between px-4 h-10 border-b border-gray-100 dark:border-gray-900">
          <h3 className="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
            {title}
          </h3>
          {action}
        </div>
      )}
      {children && <div className={pad ? "p-4" : ""}>{children}</div>}
    </div>
  );
}

// ── KV ───────────────────────────────────────────────────────────────

interface KVProps {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

export function KV({ label, value, mono }: KVProps) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-100 dark:border-gray-900/80 last:border-b-0">
      <dt className="text-[12px] text-gray-500 dark:text-gray-500">{label}</dt>
      <dd
        className={`text-[12.5px] text-gray-900 dark:text-gray-200 ${mono ? "font-mono tabular-nums" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

// ── PageHeader ───────────────────────────────────────────────────────

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, meta, children }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-6 mb-6 pb-5 border-b border-gray-100 dark:border-gray-900">
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10.5px] font-medium uppercase tracking-[0.09em] text-sky-600 dark:text-sky-400 mb-1.5">
            {eyebrow}
          </div>
        )}
        <div className="flex items-center gap-2.5">
          <h1 className="text-[22px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 leading-none">
            {title}
          </h1>
          {meta}
        </div>
        {description && (
          <p className="text-[13px] text-gray-500 dark:text-gray-500 mt-2 max-w-xl">
            {description}
          </p>
        )}
      </div>
      {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
    </div>
  );
}

// ── MetricCard ───────────────────────────────────────────────────────

type MetricTone = "sky" | "emerald" | "violet" | "amber" | "red";

const metricAccents: Record<MetricTone, { bg: string; ic: string; val: string; delta: string }> = {
  sky: {
    bg: "bg-sky-50 dark:bg-sky-950/30",
    ic: "text-sky-500 dark:text-sky-400",
    val: "text-gray-900 dark:text-gray-100",
    delta: "text-sky-600 dark:text-sky-400",
  },
  emerald: {
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    ic: "text-emerald-500 dark:text-emerald-400",
    val: "text-gray-900 dark:text-gray-100",
    delta: "text-emerald-600 dark:text-emerald-400",
  },
  violet: {
    bg: "bg-violet-50 dark:bg-violet-950/30",
    ic: "text-violet-500 dark:text-violet-400",
    val: "text-gray-900 dark:text-gray-100",
    delta: "text-violet-600 dark:text-violet-400",
  },
  amber: {
    bg: "bg-amber-50 dark:bg-amber-950/30",
    ic: "text-amber-500 dark:text-amber-400",
    val: "text-gray-900 dark:text-gray-100",
    delta: "text-amber-600 dark:text-amber-400",
  },
  red: {
    bg: "bg-red-50 dark:bg-red-950/30",
    ic: "text-red-500 dark:text-red-400",
    val: "text-gray-900 dark:text-gray-100",
    delta: "text-red-600 dark:text-red-400",
  },
};

interface MetricCardProps {
  label: string;
  value: string | number;
  delta?: string;
  tone?: MetricTone;
  icon?: ReactNode;
  spark?: number[];
  status?: string;
  href?: string;
}

export function MetricCard({
  label,
  value,
  delta,
  tone = "sky",
  icon,
  spark,
  status,
}: MetricCardProps) {
  const accent = metricAccents[tone];
  return (
    <div className="relative rounded-lg border border-gray-200 dark:border-gray-900 bg-white dark:bg-gray-950/60 p-3.5 hover:border-gray-300 dark:hover:border-gray-800 transition-colors group overflow-hidden">
      <div className={`absolute top-0 left-0 right-0 h-[2px] ${accent.bg} opacity-80`} />
      <div className="flex items-center justify-between mb-3">
        {icon && (
          <div
            className={`w-7 h-7 rounded-md ${accent.bg} flex items-center justify-center ${accent.ic}`}
          >
            {icon}
          </div>
        )}
        {status && (
          <Pill tone="emerald" dot>
            {status}
          </Pill>
        )}
        {delta && !status && (
          <span className={`text-[10.5px] font-medium tabular-nums ${accent.delta}`}>{delta}</span>
        )}
      </div>
      <div className={`text-[24px] font-semibold tracking-tight leading-none ${accent.val}`}>
        {value}
      </div>
      <div className="flex items-center mt-1.5">
        <span className="text-[11.5px] text-gray-500 dark:text-gray-500">{label}</span>
      </div>
      {spark && <Spark data={spark} tone={tone} />}
    </div>
  );
}

// ── Spark ────────────────────────────────────────────────────────────

const sparkColors: Record<MetricTone, string> = {
  sky: "#0ea5e9",
  emerald: "#10b981",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  red: "#ef4444",
};

export function Spark({ data, tone = "sky" }: { data: number[]; tone?: MetricTone }) {
  const w = 60;
  const h = 16;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 2) - 1}`,
    )
    .join(" ");
  return (
    <svg width={w} height={h} className="absolute bottom-2 right-3 opacity-70">
      <polyline
        fill="none"
        stroke={sparkColors[tone]}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
    </svg>
  );
}
