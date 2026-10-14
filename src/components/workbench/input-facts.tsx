import type { InputFact } from "@/lib/client/display";

export function InputFacts({ facts }: { facts: InputFact[] }) {
  if (facts.length === 0) {
    return <p className="text-sm text-muted-foreground">没有输入</p>;
  }
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {facts.map((fact) => (
        <div key={fact.key} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="break-words">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
