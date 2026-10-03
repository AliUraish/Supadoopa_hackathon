import Link from "next/link";
import { Sprite } from "@/components/px/sprite";
import { Banner, Button, Field, Input, Panel } from "@/components/px/ui";
import { signIn, signUp } from "./actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error, message, next } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-3">
          <Sprite name="door" scale={4} className="drop-shadow-[0_0_12px_rgba(62,207,142,0.55)]" />
          <p className="text-center text-lg text-muted">
            Optional — only needed for billing. The Doorway demo works without an account.{" "}
            <Link href="/dashboard" className="text-green underline">
              Open the dashboard
            </Link>
          </p>
        </div>

        <Panel title="Sign in" icon="user">
          <form className="flex flex-col gap-4">
            {typeof error === "string" && (
              <Banner tone="bad" title="Error">
                {error}
              </Banner>
            )}
            {typeof message === "string" && <Banner tone="ok">{message}</Banner>}

            <input type="hidden" name="next" value={typeof next === "string" ? next : ""} />
            <Field label="Email">
              <Input name="email" type="email" required autoComplete="email" />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" required minLength={6} autoComplete="current-password" />
            </Field>

            <div className="flex flex-col gap-3 pt-1">
              <Button type="submit" formAction={signIn} icon="lock">
                Sign in
              </Button>
              <Button type="submit" variant="ghost" formAction={signUp} icon="plus">
                Create account
              </Button>
            </div>
          </form>
        </Panel>
      </div>
    </main>
  );
}
