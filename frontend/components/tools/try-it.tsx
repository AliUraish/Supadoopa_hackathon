"use client";

// "Try it": run a tool from the dashboard with a form generated from its input schema.
// Action tools pay $0.50 per successful call through Stripe test mode; reads are free.

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { DoorwayError, doorway, type Payment, type RunToolBody, type RunToolResult, type Tool } from "@/lib/doorway";
import { fmtInt, fmtMs, fmtUsd } from "@/lib/doorway/format";
import { useAction } from "@/lib/doorway/live";
import { Toggle } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
import { Badge, Banner, Button, ErrorBanner, JsonBlock, Kv, Panel } from "@/components/px/ui";
import { CopyText } from "./copy-text";
import { buildArguments, SchemaForm, type FieldValue, type FormValues } from "./schema-form";

export function TryIt({ tool, onRan }: { tool: Tool; onRan?: () => void }) {
  const isAction = tool.kind === "action";
  const profileFields = tool.profile_fields ?? {};
  const hasProfile = Object.keys(profileFields).length > 0;
  const price = fmtUsd(tool.price_cents);

  const [values, setValues] = useState<FormValues>({});
  const [useProfile, setUseProfile] = useState(hasProfile);
  const [remember, setRemember] = useState(false);
  const [pay, setPay] = useState(isAction);
  const [result, setResult] = useState<RunToolResult | null>(null);
  const call = useAction((body: RunToolBody) => doorway.runTool(tool.id, body));

  const needsPayment = call.error instanceof DoorwayError && call.error.status === 402;
  const missing =
    call.error instanceof DoorwayError && call.error.status === 422 && call.error.code === "missing_inputs"
      ? call.error.missing
      : null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setResult(null);
    const body: RunToolBody = {
      arguments: buildArguments(tool.input_schema, values),
      use_profile: hasProfile && useProfile,
      remember: hasProfile && remember,
    };
    if (isAction && pay) body.pay = "test";
    const res = await call.run(body);
    if (res) {
      setResult(res);
      onRan?.();
    }
  };

  const setField = (key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (call.error) call.reset();
  };

  return (
    <Panel
      title="Try it"
      icon="execute"
      actions={
        <Badge tone={isAction ? "gold" : "ok"} pulse={false} className="font-mono normal-case">
          {isAction ? `${price} / call` : "Free read"}
        </Badge>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {tool.status === "repairing" && (
          <Banner tone="warn" icon="heal" title="Repairing">
            A heal job is running. The tool still answers through a fallback strategy meanwhile.
          </Banner>
        )}
        {tool.status === "broken" && (
          <Banner tone="bad" icon="broken" title="Broken">
            The last verification failed. Calls may fail until a sandbox heals it.
          </Banner>
        )}

        <SchemaForm
          schema={tool.input_schema}
          values={values}
          onChange={setField}
          profileFields={profileFields}
          useProfile={hasProfile && useProfile}
          disabled={call.pending}
        />

        <div className="flex flex-col gap-3 rounded-md border border-line bg-panel-2 p-3">
          {hasProfile && (
            <>
              <Toggle
                checked={useProfile}
                onChange={setUseProfile}
                label="Use my saved details"
                hint={`Fills ${Object.keys(profileFields).join(", ")} from your profile, only for fields you consented to share with ${tool.site_id}.`}
              />
              <Toggle
                checked={remember}
                onChange={setRemember}
                label="Remember these details"
                hint="Saves what you type here back to your profile."
              />
            </>
          )}
          {isAction ? (
            <Toggle
              checked={pay}
              onChange={(next) => {
                setPay(next);
                if (needsPayment) call.reset();
              }}
              label={
                <>
                  Pay with Stripe test mode{" "}
                  <span className="font-mono text-xs tabular-nums text-muted">{price} per successful call</span>
                </>
              }
              hint="Test card, no real money. Without it, the dashboard runs the action unpaid; agents always pay per call."
            />
          ) : (
            <p className="flex items-center gap-2 text-xs text-faint">
              <Icon name="coin" size={13} /> Reads are free: no payment needed.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" icon="execute" loading={call.pending}>
            {call.pending ? "Running" : isAction && pay ? `Run · pay ${price}` : "Run"}
          </Button>
          <Link href="/profile" className="ml-auto text-xs text-muted underline-offset-2 hover:text-text hover:underline">
            Manage consent on your Profile
          </Link>
        </div>

        {needsPayment ? (
          <Banner
            tone="gold"
            icon="coin"
            title="Payment required"
            action={
              <Button
                size="sm"
                variant="warn"
                icon="coin"
                onClick={() => {
                  setPay(true);
                  call.reset();
                }}
              >
                Enable test payment
              </Button>
            }
          >
            {tool.name} is a paid action ({price} per successful call). Turn on &quot;Pay with Stripe test
            mode&quot; and run it again: it uses a test card, no real money moves.
          </Banner>
        ) : missing ? (
          <Banner tone="warn" icon="user" title="Missing inputs">
            Fill in {missing.join(", ") || "the required fields"}
            {hasProfile && (
              <>
                {useProfile ? ". Saved details" : ', or turn on "Use my saved details". It'} only fills fields
                you consented to share with {tool.site_id} on your{" "}
                <Link href="/profile" className="text-text underline underline-offset-2 hover:text-green">
                  Profile
                </Link>
              </>
            )}
            .
          </Banner>
        ) : (
          <ErrorBanner error={call.error} />
        )}

        {result && <RunResult result={result} />}
      </form>
    </Panel>
  );
}

function RunResult({ result }: { result: RunToolResult }) {
  const { run } = result;
  const strategy = result.strategy ?? run.strategy;
  const ms = result.ms ?? run.ms;
  const filled = result.filled_from_profile ?? [];
  return (
    <section className="animate-rise flex flex-col gap-3 border-t border-line pt-4" aria-label="Result">
      <div className="font-mono text-[11px] uppercase tracking-wider text-faint">Result</div>
      <Banner
        tone={result.ok ? "ok" : "bad"}
        title={result.ok ? "Call succeeded" : "Call failed"}
        action={
          result.healed ? (
            <Badge tone="warn" pulse={false} className="shrink-0">
              <Icon name="heal" size={12} />
              Self-healed
            </Badge>
          ) : undefined
        }
      >
        <span className="font-mono text-xs tabular-nums text-muted">
          run #{run.id} · <span className="text-text">{strategy ?? "—"}</span> · {fmtMs(ms)} · {fmtInt(run.steps)}{" "}
          steps · {run.status}
        </span>
        {(result.error ?? run.error) && <span className="mt-1 block text-red">{result.error ?? run.error}</span>}
        {result.healed && (
          <span className="mt-1 block text-amber">The tool broke mid-call, healed, and the call was retried.</span>
        )}
      </Banner>

      {filled.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Filled from profile</span>
          {filled.map((f) => (
            <span
              key={f}
              className="inline-flex h-5 items-center gap-1 rounded-md border border-line bg-panel-2 px-1.5 font-mono text-[11px] text-text"
            >
              <Icon name="user" size={11} className="text-violet" />
              {f}
            </span>
          ))}
        </div>
      )}

      <JsonBlock value={result.data} />

      {result.payment && <Receipt payment={result.payment} />}
    </section>
  );
}

function Receipt({ payment }: { payment: Payment }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line bg-panel-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-text">
          <Icon name="card" size={14} className="text-gold" />
          Stripe test receipt
        </span>
        <Badge tone="muted" pulse={false}>
          Test mode
        </Badge>
      </div>
      <Kv
        k="Reference"
        v={
          <CopyText value={payment.reference} className="justify-end font-mono text-xs text-text">
            {payment.reference}
          </CopyText>
        }
      />
      <Kv k="Amount" v={<span className="font-mono tabular-nums text-text">{fmtUsd(payment.amount_cents)}</span>} />
      {payment.receipt != null && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-text [&::-webkit-details-marker]:hidden">
            <Icon name="chevron" size={13} className="transition-transform group-open:rotate-90" />
            Receipt JSON
          </summary>
          <JsonBlock value={payment.receipt} className="mt-2 max-h-60" />
        </details>
      )}
    </div>
  );
}
