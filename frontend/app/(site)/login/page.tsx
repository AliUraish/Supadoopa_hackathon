import Link from "next/link";
import { DoorwayMark } from "@/components/brand/doorway-logo";
import { Banner, Button, Field, Input } from "@/components/px/ui";
import { signIn, signUp } from "./actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error, message, next } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <DoorwayMark size={32} />
          <h1 className="text-xl font-semibold tracking-tight text-text">Sign in to Doorway</h1>
          <p className="text-[13px] text-muted">
            Optional — only needed for billing. The dashboard works without an account.
          </p>
        </div>

        <form className="px-panel flex flex-col gap-4 p-5">
          {typeof error === "string" && (
            <Banner tone="bad" title="Couldn't sign in">
              {error}
            </Banner>
          )}
          {typeof message === "string" && <Banner tone="ok">{message}</Banner>}

          <input type="hidden" name="next" value={typeof next === "string" ? next : ""} />
          <Field label="Email">
            <Input name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
          </Field>
          <Field label="Password">
            <Input name="password" type="password" required minLength={6} autoComplete="current-password" />
          </Field>

          <div className="flex flex-col gap-2 pt-1">
            <Button type="submit" formAction={signIn} className="w-full">
              Sign in
            </Button>
            <Button type="submit" variant="ghost" formAction={signUp} className="w-full">
              Create account
            </Button>
          </div>
        </form>

        <p className="text-center text-xs text-faint">
          <Link href="/dashboard" className="text-muted hover:text-text">
            Continue to the dashboard without signing in
          </Link>
        </p>
      </div>
    </main>
  );
}
