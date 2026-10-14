import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { COLUMN_ORDER, fieldLabel, statusLabel } from "@/smart-ui/labels";
import { StatusBadge } from "@/smart-ui/StatusBadge";

function columnKeys(records: Record<string, unknown>[]): string[] {
  const present = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) present.add(key);
  }
  const preferred = COLUMN_ORDER.filter((key) => present.has(key));
  const rest = [...present].filter((key) => !COLUMN_ORDER.includes(key)).sort();
  return [...preferred, ...rest];
}

function plain(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") return statusLabel(value) ?? value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => plain(item)).join("、") || "—";
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${fieldLabel(key)} ${plain(item)}`)
      .join(" · ");
  }
  return String(value);
}

function formatWhen(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function renderCell(key: string, value: unknown): ReactNode {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string" && statusLabel(value)) {
    return <StatusBadge status={value} />;
  }
  if (typeof value === "string") return formatWhen(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => plain(item)).join("、");
    return text || "—";
  }
  if (typeof value === "object") return plain(value);
  return String(value);
}

export function SmartTable({
  records,
  renderActions,
  empty = "没有记录",
}: {
  records: Record<string, unknown>[];
  renderActions?: (record: Record<string, unknown>) => ReactNode;
  empty?: string;
}) {
  if (records.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  const columns = columnKeys(records);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column}>{fieldLabel(column)}</TableHead>
          ))}
          {renderActions ? <TableHead>操作</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record, index) => {
          const key = typeof record.id === "string" ? record.id : String(index);
          return (
            <TableRow key={key}>
              {columns.map((column) => (
                <TableCell key={column}>{renderCell(column, record[column])}</TableCell>
              ))}
              {renderActions ? (
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap gap-2">{renderActions(record)}</div>
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
