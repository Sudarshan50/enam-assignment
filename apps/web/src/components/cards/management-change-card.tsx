import type { Card, Person } from "@finn/shared";
import { ArrowUpRight } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { formatIsoDate } from "./parts";

type ManagementChange = Extract<Card, { kind: "management_change" }>;

const DIRECTION: Record<Person["direction"], { label: string; tone: Tone }> = {
  incoming: { label: "Incoming", tone: "pos" },
  outgoing: { label: "Outgoing", tone: "neg" },
  redesignated: { label: "Redesignated", tone: "know" },
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function PersonBlock({ person }: { person: Person }) {
  const dir = DIRECTION[person.direction];
  const effective = formatIsoDate(person.effectiveDate);
  const featured = person.direction === "incoming";
  return (
    <article className={featured ? "rounded-2xl border border-rule-strong bg-white/[0.02] p-4" : "rounded-2xl border border-rule p-4"}>
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden
          className="flex size-12 shrink-0 items-center justify-center rounded-full border border-rule-strong bg-paper-high font-display text-[20px] text-ink"
        >
          {initials(person.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={dir.tone}>{dir.label}</Badge>
            {effective ? <span className="font-mono text-[11px] text-ink-faint">effective {effective}</span> : null}
          </div>
          <h4 className="mt-1.5 font-display text-[24px] leading-[1.1] text-ink">{person.name}</h4>
          {person.role ? <p className="mt-0.5 text-[13.5px] text-ink-muted">{person.role}</p> : null}
        </div>
      </div>
      {person.reason ? <p className="mt-3 text-[13.5px] text-ink-muted">Reason given: {person.reason}</p> : null}
      {person.filingProfile ? (
        <figure className="mt-4">
          <blockquote className="border-l-2 border-amber/50 pl-4 text-[14.5px] leading-relaxed text-ink">{person.filingProfile}</blockquote>
          <figcaption className="mt-2 pl-4 font-mono text-[11px] text-ink-faint">
            Brief profile from the filing{person.profilePage ? ` · p.${person.profilePage}` : ""}
          </figcaption>
        </figure>
      ) : null}
      {person.link ? (
        <a
          href={person.link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] text-ink-muted underline decoration-rule-strong underline-offset-4 hover:text-ink"
        >
          {person.link.headline ?? "Professional profile"} · {person.link.source}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      ) : null}
    </article>
  );
}

export function ManagementChangeCard({ card }: { card: ManagementChange }) {
  const ordered = [...card.people].sort((a, b) => Number(b.direction === "incoming") - Number(a.direction === "incoming"));
  return (
    <div className="space-y-3">
      {card.summary ? <p className="text-[14.5px] leading-relaxed text-ink-muted">{card.summary}</p> : null}
      {ordered.map((p) => (
        <PersonBlock key={`${p.name}-${p.direction}`} person={p} />
      ))}
    </div>
  );
}
