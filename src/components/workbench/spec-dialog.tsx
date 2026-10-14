"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UiSpec } from "@/lib/contract/types";
import { SmartForm, type SmartUiHost } from "@/smart-ui";

export interface SpecDialogState {
  spec: UiSpec;
  initialValues?: Record<string, unknown>;
  session: number;
}

export function useSpecDialog() {
  const [active, setActive] = useState<SpecDialogState | null>(null);
  return {
    active,
    openSpec(spec: UiSpec, initialValues?: Record<string, unknown>) {
      setActive((current) => ({
        spec,
        initialValues,
        session: (current?.session ?? 0) + 1,
      }));
    },
    onOpenChange(open: boolean) {
      if (!open) setActive(null);
    },
  };
}

export function SpecDialog({
  active,
  onOpenChange,
  host,
}: {
  active: SpecDialogState | null;
  onOpenChange: (open: boolean) => void;
  host: SmartUiHost;
}) {
  const spec = active?.spec;
  return (
    <Dialog open={Boolean(active)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(85vh,40rem)] overflow-y-auto sm:max-w-lg">
        {spec ? (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle>{spec.title}</DialogTitle>
              <DialogDescription>{spec.description}</DialogDescription>
            </DialogHeader>
            <SmartForm
              key={`${active.session}:${spec.capabilityId}`}
              spec={spec}
              host={host}
              initialValues={active.initialValues}
              hideHeading
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
